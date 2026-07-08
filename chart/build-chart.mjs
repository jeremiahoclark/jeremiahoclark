#!/usr/bin/env node
// Renders assets/tokscale-chart.svg from `tokscale graph` JSON.
// Usage: node build-chart.mjs [--input graph.json]   (defaults to running tokscale)

import * as echarts from "echarts";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "assets", "tokscale-chart.svg");

// --- data -------------------------------------------------------------
// Pass every known client explicitly: `tokscale graph` with no -c honors
// settings.json defaultClients, which silently drops codex et al.
const ALL_CLIENTS =
  "opencode,claude,codex,cursor,gemini,amp,droid,openclaw,pi,kimi,qwen,roocode,kilocode,mux,kilo,crush,hermes,copilot,goose,codebuff,antigravity,zed,kiro,synthetic";
const inputFlag = process.argv.indexOf("--input");
const raw =
  inputFlag !== -1
    ? readFileSync(process.argv[inputFlag + 1], "utf8")
    : execFileSync("tokscale", ["graph", "-c", ALL_CLIENTS, "--no-spinner"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
const graph = JSON.parse(raw);

const sumTokens = (t) => t.input + t.output + t.cacheRead + t.cacheWrite + (t.reasoning || 0);

const byDay = new Map(); // date -> tokens
for (const day of graph.contributions) {
  let tok = 0;
  for (const c of day.clients) tok += sumTokens(c.tokens);
  byDay.set(day.date, (byDay.get(day.date) || 0) + tok);
}

// continuous date axis, cumulative total carried through gaps
const start = new Date(graph.meta.dateRange.start + "T00:00:00Z");
const end = new Date(graph.meta.dateRange.end + "T00:00:00Z");
const dates = [];
for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
  dates.push(d.toISOString().slice(0, 10));
}
let running = 0;
const totals = dates.map((date) => (running += byDay.get(date) || 0));
const grandTotal = running;

const fmt = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "B"
  : n >= 1e6 ? (n / 1e6).toFixed(0) + "M"
  : n >= 1e3 ? (n / 1e3).toFixed(0) + "K"
  : String(n);

// --- chart ------------------------------------------------------------
const W = 940, H = 420;
const BG = "#0a0e1a";
const INK = { primary: "#e6edf3", secondary: "#94a3b8", muted: "#475569", grid: "#1b2436" };
const LINE = "#22d3ee"; // glow stroke; fill fades from validated #0891b2
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: W, height: H });

chart.setOption({
  backgroundColor: "transparent",
  animation: false,
  grid: { left: 64, right: 28, top: 92, bottom: 44 },
  title: [
    {
      text: "AI TOKEN USAGE",
      left: 62,
      top: 20,
      textStyle: { color: INK.primary, fontSize: 20, fontWeight: 700, fontFamily: MONO },
    },
    {
      text: `${fmt(grandTotal)} tokens · ${graph.summary.activeDays} active days · ${dates[0]} → ${dates[dates.length - 1]}`,
      left: 64,
      top: 50,
      textStyle: { color: INK.secondary, fontSize: 12, fontWeight: 400, fontFamily: MONO },
    },
  ],
  xAxis: {
    type: "category",
    data: dates,
    boundaryGap: false,
    axisLine: { lineStyle: { color: INK.grid } },
    axisTick: { show: false },
    axisLabel: {
      color: INK.muted,
      fontSize: 11,
      fontFamily: MONO,
      interval: Math.floor(dates.length / 6),
      formatter: (d) => {
        const [y, m] = d.split("-");
        return ["", "JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][+m] + " ’" + y.slice(2);
      },
    },
  },
  yAxis: {
    type: "value",
    splitNumber: 4,
    axisLabel: {
      color: INK.muted,
      fontSize: 11,
      fontFamily: MONO,
      formatter: (v) => (v === 0 ? "0" : fmt(v)),
    },
    splitLine: { lineStyle: { color: INK.grid, type: [2, 6] } },
  },
  series: [
    {
      name: "Total tokens",
      type: "line",
      data: totals,
      symbol: "none",
      smooth: 0.15,
      lineStyle: { color: LINE, width: 2.5 },
      itemStyle: { color: LINE },
      areaStyle: {
        color: {
          type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: "#0891b2B3" },
            { offset: 1, color: "#0891b200" },
          ],
        },
      },
      markPoint: {
        symbol: "circle",
        symbolSize: 7,
        itemStyle: { color: LINE, borderColor: BG, borderWidth: 2 },
        label: {
          show: true,
          position: "left",
          distance: 10,
          color: INK.primary,
          fontSize: 13,
          fontWeight: 700,
          fontFamily: MONO,
          formatter: fmt(grandTotal),
        },
        data: [{ coord: [dates.length - 1, grandTotal] }],
      },
    },
  ],
});

let svg = chart.renderToSVGString();
chart.dispose();

// Wrap: rounded panel background + subtle top glow line, self-contained dark surface.
svg = svg.replace(
  /<svg([^>]*)>/,
  `<svg$1>
  <defs>
    <linearGradient id="panelEdge" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#0891b2" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#22d3ee" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#8b5cf6" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="${BG}" stroke="#1e293b"/>
  <rect x="120" y="0" width="${W - 240}" height="2" rx="1" fill="url(#panelEdge)"/>`
);

writeFileSync(OUT, svg);
console.log(`wrote ${OUT} (${(svg.length / 1024).toFixed(0)} KB) — total ${fmt(grandTotal)} tokens`);
