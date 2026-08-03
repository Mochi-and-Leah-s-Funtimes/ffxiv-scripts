// web/app.js
//
// Targeted static scanner — loads pre-computed JSON from the backend
// (src/run_scans.js + src/scan_worker.js) and renders result cards.
// Falls back to an in-browser engine scan if JSON is missing.
//
import {
  fetchMarketable,
  fetchWorldMap,
  fetchDcWorlds,
  fetchDcName,
  runScan,
  DEFAULT_SELL_WORLD,
  DC_NAME,
} from "./src/engine.js";

// ── Predefined scan configs ────────────────────────────────────────────────────
// Matches the user's python bash script scan tiers.
// jsonFile points to the output of src/scan_worker.js.

const SCANS = {
  scan1: {
    color: "scan-1",
    icon: "💰",
    label: "High Tier (500k–2M)",
    desc: "Premium items with large absolute profit per unit.",
    jsonFile: "mateus_gillionaire.json",
    opts: { scope: "dc", minPct: 5, historyEntries: 5, workers: 6, topN: 25, sortBy: "score" },
  },
  scan2: {
    color: "scan-2",
    icon: "📈",
    label: "Mid-High (100k–750k)",
    desc: "Deep underpriced items with high % returns.",
    jsonFile: "mateus_high.json",
    opts: { scope: "dc", minPct: 5, historyEntries: 5, workers: 6, topN: 25, sortBy: "score" },
  },
  scan3: {
    color: "scan-3",
    icon: "⚡",
    label: "Mid Tier (50k–200k)",
    desc: "Solid mid-range flips with good turnover.",
    jsonFile: "mateus_mid.json",
    opts: { scope: "dc", minPct: 5, historyEntries: 5, workers: 6, topN: 25, sortBy: "profit" },
  },
  scan4: {
    color: "scan-4",
    icon: "🏆",
    label: "Low Tier (10k–100k)",
    desc: "Fastest turnover — items that sell quickly at low margin.",
    jsonFile: "mateus_low.json",
    opts: { scope: "dc", minPct: 5, historyEntries: 5, workers: 6, topN: 25, sortBy: "velocity" },
  },
};

// ── shared state ───────────────────────────────────────────────────────────────

let worldMapCache = null;
let dcListCache = null;
const running = new Set();

// ── helpers ───────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function fmt(num) {
  if (num == null) return "—";
  return Math.trunc(num).toLocaleString();
}

function escapeHtml(str) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(str ?? "").replace(/[&<>"']/g, (c) => map[c]);
}

function setTimestamp(scanId, isoString) {
  const tsEl = $(`${scanId}-ts`);
  if (!tsEl) return;
  const d = new Date(isoString);
  tsEl.textContent = `Updated ${d.toLocaleString()}`;
}

// ── per-card sort state ───────────────────────────────────────────────────────

const sortState = {};
let worldNameMap = {};

function getSortKey(scanId) {
  const cfg = SCANS[scanId];
  const defaultSort = cfg.opts.sortBy || "score";
  if (!sortState[scanId]) {
    sortState[scanId] = { column: defaultSort, dir: "desc" };
  }
  return sortState[scanId];
}

function handleSort(scanId, column) {
  const state = getSortKey(scanId);
  if (state.column === column) {
    state.dir = state.dir === "asc" ? "desc" : "asc";
  } else {
    state.column = column;
    state.dir = "desc";
  }
  const container = $(`${scanId}-results`);
  const results = container._cachedResults;
  if (results) renderScanCard(scanId, results, "done", container._cachedTotal);
}

// ── rendering ──────────────────────────────────────────────────────────────────

const SORT_MAP = {
  item: (a, b) => (a.name || `Item ${a.id}`).localeCompare(b.name || `Item ${b.id}`),
  buy: (a, b) => a.buy - b.buy,
  source: (a, b) => (worldNameMap[a.buy_world_id] || "").localeCompare(worldNameMap[b.buy_world_id] || ""),
  sell: (a, b) => a.home - b.home,
  profit: (a, b) => a.gross - b.gross,
  margin: (a, b) => a.margin - b.margin,
  velocity: (a, b) => a.dc_vel - b.dc_vel,
  score: (a, b) => a.score - b.score,
};

function sortArrow(column, state) {
  if (state.column !== column) return "↕";
  return state.dir === "asc" ? "↑" : "↓";
}

function renderScanCard(scanId, results, status, total = null) {
  const container = $(`${scanId}-results`);
  const cfg = SCANS[scanId];
  const state = getSortKey(scanId);

  if (status === "running") {
    container.innerHTML = `<div class="text-zinc-400 flex items-center gap-2"><span class="w-4 h-4 border-2 border-${cfg.color} border-t-transparent rounded-full animate-spin"></span>Loading…</div>`;
    return;
  }

  if (status === "error") {
    container.innerHTML = `<div class="text-gil-red">❌ Failed to load scan data.</div>`;
    return;
  }

  if (!results || results.length === 0) {
    container.innerHTML = `<div class="text-zinc-400">No candidates found.</div>`;
    return;
  }

  const sortFn = SORT_MAP[state.column] || SORT_MAP.score;
  const ordered = [...results].sort((a, b) => sortFn(a, b) * (state.dir === "asc" ? 1 : -1)).slice(0, cfg.opts.topN);
  const shown = total ?? results.length;

  container._cachedResults = results;
  container._cachedTotal = total;

  const th = (col, label, cls = "") =>
    `<th class="px-2 py-1 cursor-pointer select-none hover:text-white ${cls}" onclick="handleSort('${scanId}', '${col}')">${label} ${sortArrow(col, state)}</th>`;

  let html = `<div class="mb-2 text-xs text-zinc-400">${shown.toLocaleString()} candidates</div>`;
  html += `<div class="overflow-x-auto"><table class="w-full text-xs">
    <thead class="text-zinc-500 uppercase">
      <tr>
        <th class="text-left px-2 py-1 cursor-pointer select-none hover:text-white" onclick="handleSort('${scanId}', 'item')">Item ${sortArrow('item', state)}</th>
        ${th("buy", "Buy", "text-right")}
        ${th("source", "Source", "text-left")}
        ${th("sell", "Sell", "text-right")}
        ${th("profit", "Profit", "text-right font-bold")}
        ${th("margin", "Margin", "text-right")}
        ${th("velocity", "Vel/d", "text-right")}
        ${th("score", "Score", "text-right font-mono")}
      </tr>
    </thead><tbody>`;

  for (const r of ordered) {
    const source = r.buy_world_id ? (worldNameMap[r.buy_world_id] || `#${r.buy_world_id}`) : "—";
    const profitClass = r.gross >= 1000 ? "text-gil-green" : "text-yellow-400";
    const marginClass = r.margin >= 15 ? "text-gil-green" : r.margin >= 5 ? "text-yellow-400" : "text-gil-red";
    html += `
      <tr class="border-b border-zinc-700/30 hover:bg-zinc-700/20">
        <td class="px-2 py-1 font-medium text-white">${escapeHtml(r.name || `Item ${r.id}`)}</td>
        <td class="px-2 py-1 text-right">${fmt(r.buy)}g</td>
        <td class="px-2 py-1 text-right text-ffxiv-gold">${source}</td>
        <td class="px-2 py-1 text-right">${fmt(r.home)}g</td>
        <td class="px-2 py-1 text-right font-bold ${profitClass}">${fmt(r.gross)}g</td>
        <td class="px-2 py-1 text-right ${marginClass}">${r.margin.toFixed(1)}%</td>
        <td class="px-2 py-1 text-right">${r.dc_vel.toFixed(1)}</td>
        <td class="px-2 py-1 text-right font-mono text-ffxiv-gold">${fmt(r.score)}</td>
      </tr>`;
  }

  html += `</tbody></table></div>`;
  container.innerHTML = html;
}

// ── JSON loading (primary mode) ───────────────────────────────────────────────

async function loadScan(scanId) {
  const cfg = SCANS[scanId];

  renderScanCard(scanId, null, "running");

  try {
    const res = await fetch(`scans/${cfg.jsonFile}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    worldNameMap = {};
    if (data.worlds) {
      for (const [name, id] of Object.entries(data.worlds)) {
        worldNameMap[id] = name.charAt(0).toUpperCase() + name.slice(1);
      }
    }
    setTimestamp(scanId, data.generatedAt);
    renderScanCard(scanId, data.results, "done", data.count);
  } catch {
    renderScanCard(scanId, null, "error");
  }
}

async function refreshAll() {
  for (const id of Object.keys(SCANS)) {
    await loadScan(id);
  }
}

// ── global for inline onclick handlers ─────────────────────────────────────────

window.runScanById = loadScan;
window.runAllScans = refreshAll;
window.handleSort = handleSort;

// ── auto-load on page open ─────────────────────────────────────────────────────

refreshAll();
