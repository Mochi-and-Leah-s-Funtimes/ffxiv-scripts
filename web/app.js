// static/app.js
//
// Targeted static scanner — runs 4 predefined scan configurations
// and renders compact result cards.  Imports the shared engine.
//
import {
  fetchMarketable,
  fetchWorldMap,
  fetchDcWorlds,
  fetchDcName,
  runScan,
  DEFAULT_SELL_WORLD,
  DC_NAME,
} from "../src/engine.js";

// ── Predefined scan configs ────────────────────────────────────────────────────
// Each scan is a "targeted" configuration tuned for a specific strategy.

const SCANS = {
  scan1: {
    color: "scan-1",
    icon: "💰",
    label: "High Profit Flips",
    desc: "Premium items with large absolute profit per unit.",
    opts: {
      scope:        "region",
      minProfit:    1000,
      minVel:       3,
      minMargin:    10,
      priceFloor:   200,
      maxPriceFloor: 500000,
      maxSaleAge:   168,
      historyEntries: 5,
      workers:      6,
      sortBy:       "profit",
      topN:         15,
    },
  },
  scan2: {
    color: "scan-2",
    icon: "📈",
    label: "High Margin Flips",
    desc: "Deeply underpriced items with high % returns.",
    opts: {
      scope:        "dc",
      minProfit:    150,
      minVel:       5,
      minMargin:    25,
      priceFloor:   100,
      maxPriceFloor: 200000,
      maxSaleAge:   120,
      historyEntries: 5,
      workers:      6,
      sortBy:       "margin",
      topN:         15,
    },
  },
  scan3: {
    color: "scan-3",
    icon: "⚡",
    label: "High Velocity Flips",
    desc: "Fastest turnover — items that sell daily.",
    opts: {
      scope:        "region",
      minProfit:    50,
      minVel:       10,
      minMargin:    3,
      priceFloor:   50,
      maxPriceFloor: 200000,
      maxSaleAge:   72,
      historyEntries: 5,
      workers:      6,
      sortBy:       "velocity",
      topN:         15,
    },
  },
  scan4: {
    color: "scan-4",
    icon: "🏆",
    label: "Daily Revenue Leaders",
    desc: "Best profit × velocity — active market maker picks.",
    opts: {
      scope:        "region",
      minProfit:    300,
      minVel:       5,
      minMargin:    5,
      priceFloor:   200,
      maxPriceFloor: 500000,
      maxSaleAge:   168,
      historyEntries: 5,
      workers:      6,
      sortBy:       "gpday",
      topN:         15,
    },
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
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function log(msg) {
  const area = $("logArea");
  const line = document.createElement("div");
  line.className = "text-gray-400";
  const ts = new Date().toLocaleTimeString();
  line.textContent = `[${ts}] ${msg}`;
  area.appendChild(line);
  area.scrollTop = area.scrollHeight;
  area.parentElement.parentElement.classList.remove("hidden");
}

function renderScanCard(scanId, results, status) {
  const container = $(`${scanId}-results`);
  const cfg = SCANS[scanId];

  if (status === "running") {
    container.innerHTML = `<div class="text-gray-400 flex items-center gap-2"><span class="w-4 h-4 border-2 border-${cfg.color} border-t-transparent rounded-full animate-spin"></span>Scanning…</div>`;
    return;
  }

  if (status === "error") {
    container.innerHTML = `<div class="text-gil-red">❌ Scan failed. Check console for details.</div>`;
    return;
  }

  if (!results || results.length === 0) {
    container.innerHTML = `<div class="text-gray-400">No candidates found.</div>`;
    return;
  }

  const sortFn = {
    profit:   (a, b) => b.gross - a.gross,
    margin:   (a, b) => b.margin - a.margin,
    velocity: (a, b) => b.dc_vel - a.dc_vel,
    gpday:    (a, b) => b.est_gp_d - a.est_gp_d,
  }[cfg.opts.sortBy] || ((a, b) => b.gross - a.gross);

  const ordered = [...results].sort(sortFn).slice(0, cfg.opts.topN);

  let html = `
    <div class="mb-3 text-xs text-gray-400">${results.length.toLocaleString()} candidates found</div>
    <div class="overflow-x-auto">
      <table class="w-full text-xs">
        <thead class="text-gray-500 uppercase">
          <tr>
            <th class="text-left px-2 py-1">Item</th>
            <th class="text-right px-2 py-1">Buy</th>
            <th class="text-right px-2 py-1">Sell</th>
            <th class="text-right px-2 py-1 profit">Profit</th>
            <th class="text-right px-2 py-1">Margin</th>
            <th class="text-right px-2 py-1">GP/Day</th>
          </tr>
        </thead>
        <tbody>`;

  for (const r of ordered) {
    const profitClass = r.gross >= 1000 ? "text-gil-green" : "text-yellow-400";
    const marginClass = r.margin >= 15 ? "text-gil-green" : r.margin >= 5 ? "text-yellow-400" : "text-gil-red";
    html += `
      <tr class="border-b border-gray-700/30 hover:bg-gray-700/20">
        <td class="px-2 py-1 font-medium text-white">${escapeHtml(r.name || `Item ${r.id}`)}</td>
        <td class="px-2 py-1 text-right">${fmt(r.buy)}g</td>
        <td class="px-2 py-1 text-right">${fmt(r.home)}g</td>
        <td class="px-2 py-1 text-right font-bold ${profitClass}">${fmt(r.gross)}g</td>
        <td class="px-2 py-1 text-right ${marginClass}">${r.margin.toFixed(1)}%</td>
        <td class="px-2 py-1 text-right font-mono">${fmt(r.est_gp_d)}g</td>
      </tr>`;
  }

  html += `
        </tbody>
      </table>
    </div>`;

  container.innerHTML = html;
}

// ── core scan logic ─────────────────────────────────────────────────────────────

async function fetchTargets() {
  if (!worldMapCache) worldMapCache = await fetchWorldMap();
  if (!dcListCache) dcListCache = await fetchDcWorlds(DC_NAME);
  return { worldMap: worldMapCache, dcList: dcListCache };
}

async function executeScan(scanId) {
  const cfg = SCANS[scanId];
  const opts = cfg.opts;
  const sellWorld = $("sellWorld").value.trim() || DEFAULT_SELL_WORLD;

  renderScanCard(scanId, null, "running");
  running.add(scanId);
  log(`[${scanId}] Starting: ${cfg.label}`);
  log(`[${scanId}] Sell world: ${sellWorld}, scope: ${opts.scope}`);

  try {
    const { worldMap } = await fetchTargets();
    const sellId = worldMap[sellWorld.toLowerCase()];
    if (!sellId) throw new Error(`Sell world '${sellWorld}' not found.`);

    const sellWorldDc = await fetchDcName(sellId);
    log(`[${scanId}] ${sellWorld} (ID ${sellId}) [DC: ${sellWorldDc || "?"}]`);

    const results = await runScan({
      itemIds:        await fetchMarketable(),
      queryWorld:     sellWorld,
      sellWorldId:    sellId,
      ...opts,
      onLog: (msg) => log(`[${scanId}] ${msg}`),
      onBatchProgress: (done, total) => {
        const bar = $(`${scanId}`).querySelector(`#${scanId}-results`);
        // could update progress here, keeping simple for now
      },
    });

    log(`[${scanId}] ✅ ${results.length.toLocaleString()} candidates`);
    renderScanCard(scanId, results, "done");
  } catch (err) {
    log(`[${scanId}] ERROR: ${err.message}`);
    renderScanCard(scanId, null, "error");
  } finally {
    running.delete(scanId);
  }
}

// ── batch runner ───────────────────────────────────────────────────────────────

async function runAllScans() {
  $("runAllBtn").disabled = true;
  $("runAllBtn").textContent = "⏳ Running...";

  for (const id of Object.keys(SCANS)) {
    await executeScan(id);
  }

  $("runAllBtn").disabled = false;
  $("runAllBtn").textContent = "🚀 Run All Scans";
  log("All scans complete!");
}

// ── global for inline onclick handlers ─────────────────────────────────────────

window.runScanById = executeScan;
window.runAllScans = runAllScans;

// ── wire up the Run All button ─────────────────────────────────────────────────

$("runAllBtn").addEventListener("click", runAllScans);

// ── auto-intro message ────────────────────────────────────────────────────────

log("Targeted scanner ready. Click a Run button or Run All Scans to get started.");
