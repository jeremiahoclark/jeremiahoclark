#!/usr/bin/env node
// Archive AI token usage locally and mirror it to jeremiah.so's D1 database.
//
//   1. Tokscale server /api/me/stats  -> token_usage_daily   (full history, daily totals)
//   2. local `tokscale graph`          -> token_usage_detail  (per client/model, what's still on disk)
//   3. both tables                     -> D1 `jayark` (same schema: jeremiah.so/migrations/0012_token_usage.sql)
//
// Rows only move up: an upsert is skipped when the incoming total is lower than
// the stored one, so pruned session logs can never shrink an archived day.
//
// Usage: node sync-usage.mjs [--no-d1]
// Env:   TOKSCALE_ARCHIVE (default ~/.local/share/tokscale-archive/usage.sqlite)
//        TOKSCALE_API_URL (default https://tokscale.ai)

import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const ARCHIVE =
  process.env.TOKSCALE_ARCHIVE || join(homedir(), ".local", "share", "tokscale-archive", "usage.sqlite");
const API_URL = process.env.TOKSCALE_API_URL || "https://tokscale.ai";
const SITE_REPO = join(homedir(), "dev", "jeremiah.so");
const D1_DB = "jayark";
const CF_ACCOUNT = "04b10da5b2c496a790ebb3f60bfe1b18"; // Jeremiahoclark@gmail.com's Account
const MACHINE = hostname().replace(/\.local$/, "");
// `tokscale graph` with no -c honors settings.json defaultClients, which drops codex et al.
export const ALL_CLIENTS =
  "opencode,claude,codex,cursor,gemini,amp,droid,openclaw,pi,kimi,qwen,roocode,kilocode,mux,kilo,crush,hermes,copilot,goose,codebuff,antigravity,zed,kiro,trae,warp,cline,gjc,grok,jcode,commandcode,micode,antigravity-cli,junie,zcode,opencodereview,codebuddy,workbuddy,synthetic";

const SCHEMA = readFileSync(join(SITE_REPO, "migrations", "0012_token_usage.sql"), "utf8");

const DAILY_COLS = ["date", "total_tokens", "input_tokens", "output_tokens", "cost_usd", "source", "updated_at"];
const DETAIL_COLS = [
  "date", "client", "model", "provider", "machine", "input_tokens", "output_tokens", "cache_read_tokens",
  "cache_write_tokens", "reasoning_tokens", "total_tokens", "cost_usd", "messages", "updated_at",
];
const upsertSql = (table, cols, keys) =>
  `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
   ON CONFLICT(${keys.join(", ")}) DO UPDATE SET
   ${cols.filter((c) => !keys.includes(c)).map((c) => `${c} = excluded.${c}`).join(", ")}
   WHERE excluded.total_tokens >= ${table}.total_tokens`;
const DAILY_UPSERT = upsertSql("token_usage_daily", DAILY_COLS, ["date"]);
const DETAIL_UPSERT = upsertSql("token_usage_detail", DETAIL_COLS, ["date", "client", "model", "machine"]);

export function openArchive() {
  mkdirSync(dirname(ARCHIVE), { recursive: true });
  const db = new DatabaseSync(ARCHIVE);
  db.exec(SCHEMA);
  return db;
}

async function fetchServerDays() {
  const { token } = JSON.parse(readFileSync(join(homedir(), ".config", "tokscale", "credentials.json"), "utf8"));
  const res = await fetch(`${API_URL}/api/me/stats`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "tokscale-archive" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const stats = await res.json();
  if (!Array.isArray(stats.days)) throw new Error("response has no days");
  return stats.days;
}

function readLocalGraph() {
  const raw = execFileSync("tokscale", ["graph", "-c", ALL_CLIENTS, "--no-spinner"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(raw).contributions;
}

const sqlLit = (v) =>
  v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

// Writes rows only; the tables come from the jeremiah.so migration
// (`wrangler d1 migrations apply jayark --remote`), never from this script.
function pushToD1(db) {
  const stmts = [];
  const inline = (sql, row, cols) => {
    let i = 0;
    return sql.replace(/\?/g, () => sqlLit(row[cols[i++]])) + ";";
  };
  for (const r of db.prepare(`SELECT ${DAILY_COLS.join(", ")} FROM token_usage_daily`).all())
    stmts.push(inline(DAILY_UPSERT, r, DAILY_COLS));
  for (const r of db.prepare(`SELECT ${DETAIL_COLS.join(", ")} FROM token_usage_detail`).all())
    stmts.push(inline(DETAIL_UPSERT, r, DETAIL_COLS));
  const file = join(tmpdir(), `tokscale-d1-${process.pid}.sql`);
  writeFileSync(file, stmts.join("\n"));
  try {
    execFileSync(join(SITE_REPO, "node_modules", ".bin", "wrangler"),
      ["d1", "execute", D1_DB, "--remote", "--file", file, "-y"], {
        cwd: SITE_REPO,
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT },
        stdio: ["ignore", "ignore", "pipe"],
      });
  } finally {
    rmSync(file, { force: true });
  }
  return stmts.length;
}

async function main() {
  const db = openArchive();
  const now = new Date().toISOString();
  let failed = 0;

  try {
    const days = await fetchServerDays();
    const up = db.prepare(DAILY_UPSERT);
    db.exec("BEGIN");
    for (const d of days)
      up.run(d.date, d.tokens, d.inputTokens ?? 0, d.outputTokens ?? 0, d.cost ?? 0, "tokscale-server", now);
    db.exec("COMMIT");
    console.log(`server: ${days.length} days`);
  } catch (err) {
    failed++;
    console.warn(`server stats skipped: ${err.message}`);
  }

  try {
    const contributions = readLocalGraph();
    const up = db.prepare(DETAIL_UPSERT);
    let n = 0;
    db.exec("BEGIN");
    for (const day of contributions)
      for (const c of day.clients) {
        const t = c.tokens;
        const total = t.input + t.output + t.cacheRead + t.cacheWrite + (t.reasoning || 0);
        up.run(day.date, c.client, c.modelId, c.providerId ?? null, MACHINE, t.input, t.output, t.cacheRead,
          t.cacheWrite, t.reasoning || 0, total, c.cost ?? 0, c.messages ?? 0, now);
        n++;
      }
    db.exec("COMMIT");
    console.log(`local: ${n} client/model/day rows from ${contributions.length} days`);
  } catch (err) {
    failed++;
    console.warn(`local graph skipped: ${err.message}`);
  }

  if (!process.argv.includes("--no-d1")) {
    try {
      console.log(`d1: upserted ${pushToD1(db)} rows into ${D1_DB}`);
    } catch (err) {
      failed++;
      const msg = String(err.stderr || err.message);
      const reason = msg.match(/\[ERROR\][^\n]*/)?.[0] ?? msg.trim().split("\n")[0];
      console.warn(`d1 push failed: ${reason}`);
      if (/no such table/.test(msg))
        console.warn("  apply the migration once: cd ~/dev/jeremiah.so && CLOUDFLARE_ACCOUNT_ID=" + CF_ACCOUNT +
          " npx wrangler d1 migrations apply jayark --remote");
    }
  }

  const { days, tokens } = db.prepare("SELECT COUNT(*) AS days, SUM(total_tokens) AS tokens FROM token_usage_daily").get();
  console.log(`archive ${ARCHIVE}: ${days} days, ${(Number(tokens || 0) / 1e9).toFixed(2)}B tokens`);
  db.close();
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
