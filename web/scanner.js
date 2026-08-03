// web/app.js
//
// Web scanner UI — imports the shared engine from ./src/engine.js
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

// ── DOM references ────────────────────────────────────────────────────────────

const scanBtn      = document.getElementById("scanBtn");
const quickBtn     = document.getElementById("quickBtn");
const exportBtn    = document.getElementById("exportCsv");
const progressEl   = document.getElementById("progressSection");
const progressTxt  = document.getElementById("progressText");
const progressBar  = document.getElementById("progressBar");
const logArea      = document.getElementById("logArea");
const resultsBody  = document.getElementById("resultsBody");
const countEl      = document.getElementById("resultsCount");

// ── state ─────────────────────────────────────────────────────────────────────

let currentResults = [];
let worldNameMap = {};

function $(id) { return document.getElementById(id); }

// ── helpers ───────────────────────────────────────────────────────────────────

function fmt(num) {
  if (num == null) return "—";
  return Math.trunc(num).toLocaleString();
}

function pct(num) {
  if (num == null) return "—";
  return `${num.toFixed(1)}%`;
}

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  const line = document.createElement("div");
  line.className = "text-gray-500";
  line.textContent = `[${ts}] ${msg}`;
  logArea.appendChild(line);
  logArea.scrollTop = logArea.scrollHeight;
}

function setProgress(done, total) {
  const pct = total > 0 ? (done / total) * 100 : 0;
  progressBar.style.width = `${Math.min(pct, 100)}%`;
  progressTxt.textContent = total > 0 ? `${done}/${total} batches` : "…";
}

function resetProgress() {
  progressBar.style.width = "0%";
  progressTxt.textContent = "Starting...";
  logArea.innerHTML = "";
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// ── render ────────────────────────────────────────────────────────────────────

const sortState = { column: "score", dir: "desc" };

const SORT_MAP = {
  item:     (a, b) => (a.name || `Item ${a.id}`).localeCompare(b.name || `Item ${b.id}`),
  buy:      (a, b) => a.buy - b.buy,
  source:   (a, b) => (worldNameMap[a.buy_world_id] || "").localeCompare(worldNameMap[b.buy_world_id] || ""),
  sell:     (a, b) => a.home - b.home,
  profit:   (a, b) => a.gross - b.gross,
  margin:   (a, b) => a.margin - b.margin,
  velocity: (a, b) => a.dc_vel - b.dc_vel,
  score:    (a, b) => a.score - b.score,
};

function sortArrow(col) {
  if (sortState.column !== col) return "↕";
  return sortState.dir === "asc" ? "↑" : "↓";
}

function percentileColor(values, val) {
  if (!values || values.length === 0) return "";
  const sorted = [...values].sort((a, b) => a - b);
  const idx = sorted.findIndex((v) => v >= val);
  const pct = idx === -1 ? 1 : idx / sorted.length;
  if (pct >= 0.8) return "text-green-400";
  if (pct >= 0.4) return "text-yellow-400";
  return "text-red-400";
}

function handleSort(column) {
  if (sortState.column === column) {
    sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
  } else {
    sortState.column = column;
    sortState.dir = "desc";
  }
  if (currentResults.length > 0) {
    renderResults(currentResults, sortState.column, currentResults._topN || 50);
  }
}

function renderResults(results, sortBy, topN) {
  currentResults = results;
  currentResults._topN = topN;
  countEl.textContent = `${results.length.toLocaleString()} candidates (showing ${Math.min(topN, results.length)})`;

  if (results.length === 0) {
    resultsBody.innerHTML =
      '<tr><td colspan="8" class="text-center py-8 text-gray-500">No candidates found. Try relaxing your filters (e.g. use ⚡ Quick Scan).</td></tr>';
    return;
  }

  const sortFn = SORT_MAP[sortBy] || SORT_MAP.score;
  const ordered = [...results].sort((a, b) => sortFn(a, b) * (sortState.dir === "asc" ? 1 : -1)).slice(0, topN);

  const grossValues = results.map((r) => r.gross);
  const marginValues = results.map((r) => r.margin);

  const th = (col, label, cls = "") =>
    `<th class="px-3 py-2 cursor-pointer select-none hover:text-white ${cls}" onclick="handleSort('${col}')">${label} ${sortArrow(col)}</th>`;

  resultsBody.innerHTML = ordered.map((r) => {
    const profitClass = percentileColor(grossValues, r.gross);
    const marginOk = percentileColor(marginValues, r.margin);
    const source = r.buy_world_id ? (worldNameMap[r.buy_world_id] || `#${r.buy_world_id}`) : "—";
    return `
      <tr class="hover:bg-gray-700/30 transition-colors">
        <td class="px-3 py-2 font-medium text-white">${escapeHtml(r.name || `Item ${r.id}`)}</td>
        <td class="px-3 py-2 text-right">${fmt(r.buy)} <span class="text-gray-500">gil</span></td>
        <td class="px-3 py-2 text-left text-ffxiv-gold">${source}</td>
        <td class="px-3 py-2 text-right">${fmt(r.home)} <span class="text-gray-500">gil</span></td>
        <td class="px-3 py-2 text-right font-bold ${profitClass}">${fmt(r.gross)} <span class="text-gray-500">gil</span></td>
        <td class="px-3 py-2 text-right ${marginOk}">${pct(r.margin)}</td>
        <td class="px-3 py-2 text-right">${r.dc_vel.toFixed(1)}</td>
        <td class="px-3 py-2 text-right font-mono text-ffxiv-gold">${fmt(r.score)} <span class="text-gray-500">pts</span></td>
      </tr>`;
  }).join("");
}

// ── CSV export ────────────────────────────────────────────────────────────────

function exportCsv(results) {
  if (results.length === 0) {
    alert("No results to export. Run a scan first.");
    return;
  }
  const fields = [
    "id","name","buy","dc_min","home","fees","gross",
    "margin","avg_sp","dc_vel","est_gp_d","confidence","score",
    "last_sale_age_h","last_sale_price","last_sale_qty",
  ];
  const rows = [...results].sort((a, b) => b.gross - a.gross);
  const lines = [fields.join(",")];
  for (const r of rows) {
    const row = fields.map((k) => {
      let v = r[k] ?? "";
      if (k === "last_sale_age_h") {
        v = (r.last_sale_age_h ?? 1e9) < 1e8
          ? r.last_sale_age_h.toFixed(1) : "";
      } else if (typeof v === "number") {
        v = v.toLocaleString();
      }
      const s = String(v);
      return s.includes(",") ? `"${s}"` : s;
    });
    lines.push(row.join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = `ffxiv-flips-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── scan ────────────────────────────────────────────────────────────────────────

async function doScan(opts) {
  scanBtn.disabled = true;
  quickBtn.disabled = true;
  exportBtn.disabled = true;
  progressEl.classList.remove("hidden");
  log("Starting scan…");

  try {
    // Resolve targets
    log("Fetching world list…");
    const worldMap = await fetchWorldMap();
    log("Fetching datacenter list…");
    const dcList = await fetchDcWorlds(DC_NAME);

    const sellWorld = opts.sellWorld || DEFAULT_SELL_WORLD;
    const sellId = worldMap[sellWorld.toLowerCase()];
    if (!sellId) {
      throw new Error(`Sell world '${sellWorld}' not found.`);
    }

    const sellWorldDc = await fetchDcName(sellId);
    worldNameMap = {};
    for (const [name, id] of Object.entries(worldMap)) {
      worldNameMap[id] = name.charAt(0).toUpperCase() + name.slice(1);
    }
    log(`🎯 Sell on: ${sellWorld} (World ID ${sellId}) [DC: ${sellWorldDc || "?"}]`);
    log(`🌐 Buy scope: ${opts.scope}`);
    log(`📊 Datacenter: ${DC_NAME} (${dcList.length} worlds)`);
    log(`Fetching marketable items…`);
    const itemList = await fetchMarketable();
    log(`📦 ${itemList.length.toLocaleString()} marketable items`);
    log(`Scanning in batches of 100…`);

    const results = await runScan({
      itemIds:         itemList,
      queryWorld:      sellWorld,
      sellWorldId:     sellId,
      scope:           opts.scope,
      minVel:          opts.minVel,
      minProfit:       opts.minProfit,
      minPct:          opts.minMargin,
      priceFloor:      opts.priceFloor,
      maxPriceFloor:   opts.maxPriceFloor,
      maxSaleAgeH:     opts.maxSaleAge,
      historyEntries:  opts.historyEntries,
      workers:         opts.workers,
      onLog:           log,
      onBatchProgress: setProgress,
    });

    log(`✅ Scan complete — ${results.length.toLocaleString()} candidates`);
    currentResults = results;
    renderResults(results, opts.sortBy, opts.topN);
    exportBtn.disabled = false;
  } catch (err) {
    log(`ERROR: ${err.message}`);
    alert(`Scan error: ${err.message}`);
  } finally {
    setProgress(0, 0);
    scanBtn.disabled = false;
    quickBtn.disabled = false;
  }
}

// ── presets ───────────────────────────────────────────────────────────────────

const PRESETS = {
  quick: {
    name: "Quick Scan",
    minVel: 0, minProfit: 0, minMargin: 0,
    priceFloor: 0, maxPriceFloor: null, maxSaleAge: null,
  },
};

// ── event listeners ───────────────────────────────────────────────────────────

function readForm() {
  return {
    sellWorld:        $("sellWorld").value.trim() || DEFAULT_SELL_WORLD,
    scope:            $("scope").value,
    sortBy:           $("sortBy").value,
    topN:             parseInt($("topN").value, 10) || 50,
    minProfit:        parseFloat($("minProfit").value) || 0,
    minVel:           parseFloat($("minVel").value) || 0,
    minMargin:        parseFloat($("minMargin").value) || 0,
    priceFloor:       parseFloat($("priceFloor").value) || 0,
    maxPriceFloor:    $("maxPriceFloor").value ? parseFloat($("maxPriceFloor").value) : null,
    maxSaleAge:       $("maxSaleAge").value ? parseFloat($("maxSaleAge").value) : null,
    historyEntries:   5,
    workers:          parseInt($("workers").value, 10) || 5,
  };
}

scanBtn.addEventListener("click", () => doScan(readForm()));
quickBtn.addEventListener("click", () => {
  const form = readForm();
  const opts = { ...form, ...PRESETS.quick };
  doScan(opts);
});
exportBtn.addEventListener("click", () => exportCsv(currentResults));
