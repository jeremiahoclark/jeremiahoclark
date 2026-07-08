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
const inputFlag = process.argv.indexOf("--input");
const raw =
  inputFlag !== -1
    ? readFileSync(process.argv[inputFlag + 1], "utf8")
    : execFileSync("tokscale", ["graph", "--no-spinner"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
const graph = JSON.parse(raw);

const CLIENT_LABELS = { claude: "Claude Code", opencode: "OpenCode", droid: "Droid", codex: "Codex", cursor: "Cursor" };
// Fixed hue order (validated dark-mode palette): assign by entity, never cycle.
const PALETTE = { claude: "#0891b2", opencode: "#8b5cf6", droid: "#ec4899", codex: "#f59e0b", cursor: "#10b981" };
const GLOW = { claude: "#22d3ee", opencode: "#a78bfa", droid: "#f472b6", codex: "#fbbf24", cursor: "#34d399" };

const sumTokens = (t) => t.input + t.output + t.cacheRead + t.cacheWrite + (t.reasoning || 0);

// per-day tokens per client
const byDay = new Map(); // date -> { client -> tokens }
const clientTotals = new Map();
for (const day of graph.contributions) {
  const entry = byDay.get(day.date) ?? {};
  for (const c of day.clients) {
    const tok = sumTokens(c.tokens);
    entry[c.client] = (entry[c.client] || 0) + tok;
    clientTotals.set(c.client, (clientTotals.get(c.client) || 0) + tok);
  }
  byDay.set(day.date, entry);
}

// biggest client on the bottom of the stack
const clients = [...clientTotals.keys()].sort(
  (a, b) => clientTotals.get(b) - clientTotals.get(a)
);

// continuous date axis (carry cumulative forward through gaps)
const start = new Date(graph.meta.dateRange.start + "T00:00:00Z");
const end = new Date(graph.meta.dateRange.end + "T00:00:00Z");
const dates = [];
for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
  dates.push(d.toISOString().slice(0, 10));
}

const running = Object.fromEntries(clients.map((c) => [c, 0]));
const series = Object.fromEntries(clients.map((c) => [c, []]));
for (const date of dates) {
  const day = byDay.get(date) || {};
  for (const c of clients) {
    running[c] += day[c] || 0;
    series[c].push(running[c]);
  }
}

// display window: cumulative totals carry in from all history, but only the
// recent stretch is drawn (--window-days 0 for all-time)
const windowFlag = process.argv.indexOf("--window-days");
const windowDays = windowFlag !== -1 ? +process.argv[windowFlag + 1] : 92;
let shownDates = dates;
if (windowDays > 0 && dates.length > windowDays) {
  const cut = dates.length - windowDays;
  shownDates = dates.slice(cut);
  for (const c of clients) series[c] = series[c].slice(cut);
}

const grandTotal = [...clientTotals.values()].reduce((a, b) => a + b, 0);
const fmt = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "B"
  : n >= 1e6 ? (n / 1e6).toFixed(0) + "M"
  : n >= 1e3 ? (n / 1e3).toFixed(0) + "K"
  : String(n);

// --- chart ------------------------------------------------------------
const W = 940, H = 420;
const BG = "#0a0e1a";
const INK = { primary: "#e6edf3", secondary: "#94a3b8", muted: "#475569", grid: "#1b2436" };

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
      textStyle: { color: INK.primary, fontSize: 20, fontWeight: 700, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", },
    },
    {
      text: `${fmt(grandTotal)} tokens all-time · ${graph.summary.activeDays} active days · showing ${shownDates[0]} → ${shownDates[shownDates.length - 1]}`,
      left: 64,
      top: 50,
      textStyle: { color: INK.secondary, fontSize: 12, fontWeight: 400, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
    },
  ],
  legend: {
    right: 28,
    top: 24,
    orient: "vertical",
    itemWidth: 14,
    itemHeight: 3,
    icon: "rect",
    textStyle: { color: INK.secondary, fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
    data: clients.map((c) => CLIENT_LABELS[c] || c),
  },
  xAxis: {
    type: "category",
    data: shownDates,
    boundaryGap: false,
    axisLine: { lineStyle: { color: INK.grid } },
    axisTick: { show: false },
    axisLabel: {
      color: INK.muted,
      fontSize: 11,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      interval: Math.floor(shownDates.length / 6),
      formatter: (d) => {
        const [y, m, day] = d.split("-");
        const mon = ["", "JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][+m];
        return shownDates.length <= 200 ? `${mon} ${+day}` : `${mon} ’${y.slice(2)}`;
      },
    },
  },
  yAxis: {
    type: "value",
    splitNumber: 4,
    axisLabel: {
      color: INK.muted,
      fontSize: 11,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      formatter: (v) => (v === 0 ? "0" : fmt(v)),
    },
    splitLine: { lineStyle: { color: INK.grid, type: [2, 6] } },
  },
  series: clients.map((c, i) => ({
    name: CLIENT_LABELS[c] || c,
    type: "line",
    stack: "tokens",
    data: series[c],
    symbol: "none",
    smooth: 0.15,
    lineStyle: { color: GLOW[c] || PALETTE[c], width: 2 },
    itemStyle: { color: PALETTE[c] || "#64748b" },
    areaStyle: {
      color: {
        type: "linear", x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [
          { offset: 0, color: (PALETTE[c] || "#64748b") + "B3" },
          { offset: 1, color: (PALETTE[c] || "#64748b") + "1A" },
        ],
      },
    },
    // 2px surface gap between stacked fills comes from the stroke on each band edge
    z: clients.length - i,
  })),
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
      <stop offset="1" stop-color="#ec4899" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="${BG}" stroke="#1e293b"/>
  <rect x="120" y="0" width="${W - 240}" height="2" rx="1" fill="url(#panelEdge)"/>`
);

writeFileSync(OUT, svg);
console.log(`wrote ${OUT} (${(svg.length / 1024).toFixed(0)} KB) — total ${fmt(grandTotal)} tokens across ${clients.join(", ")}`);
