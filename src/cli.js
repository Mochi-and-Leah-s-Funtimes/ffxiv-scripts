#!/usr/bin/env node
// src/cli.js
//
// CLI wrapper for the FFXIV Market Board Cross-World Flipper.
// Zero external dependencies — uses native fetch + a tiny hand-rolled arg parser.
//
import process from "node:process";
import { writeFileSync } from "node:fs";
import {
  API_BASE,
  DC_NAME,
  DEFAULT_SELL_WORLD,
  FEE_RATE,
  BATCH,
  fetchMarketable,
  fetchWorldMap,
  fetchDcWorlds,
  fetchDcName,
  fetchItemNames,
  fetchHistoryBatch,
  processBatch,
  runScan,
  pool,
} from "./engine.js";

// ── tiny arg parser (no external deps) ────────────────────────────────────────

const ARG_SPEC = {
  "--min-velocity":      { type: "float",  def: 5.0,   desc: "World min daily sales velocity" },
  "--min-profit":        { type: "int",    def: 200,   desc: "Min net profit per unit gil" },
  "--min-margin-pct":    { type: "float",  def: 5.0,   desc: "Min profit margin %" },
  "--min-price-floor":   { type: "int",    def: 100,   desc: "Ignore items below this gil" },
  "--max-price-floor":   { type: "int",    def: null,  desc: "Ignore items above this gil" },
  "--max-sale-age-hours":{ type: "float",  def: null,  desc: "Ignore items last sold more than N hours ago" },
  "--history-entries":   { type: "int",    def: 5,     desc: "History depth per item" },
  "--workers":           { type: "int",    def: 5,     desc: "Parallel API requests" },
  "--sort-by":           { type: "choice", def: "profit", choices: ["profit","margin","velocity","gpday","score"], desc: "Sort results" },
  "--top-n":             { type: "int",    def: 50,    desc: "Rows to display" },
  "--show-velocity":     { type: "flag",   def: false, desc: "Print velocity-ranked table" },
  "--csv":               { type: "path",   def: null,  desc: "Export results to CSV" },
  "--quick":             { type: "flag",   def: false, desc: "Relax all filters (scan full list)" },
  "--sell-world":        { type: "str",    def: DEFAULT_SELL_WORLD, desc: "World to sell on" },
  "--scope":             { type: "choice", def: "region", choices: ["region","dc"], desc: "Price scope" },
  "--verbose":           { type: "flag",   def: false, desc: "Show batch count, scan progress" },
};

function parseArgs(argv) {
  const result = {};
  // initialize with defaults
  for (const [key, spec] of Object.entries(ARG_SPEC)) {
    result[key] = spec.def;
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "-v") {
      result["--verbose"] = true;
      continue;
    }
    if (token === "-h" || token === "--help") {
      result["--help"] = true;
      continue;
    }
    if (!token.startsWith("-")) continue;

    const spec = ARG_SPEC[token];
    if (!spec) {
      console.error(`Unknown argument: ${token}\n`);
      result["--help"] = true;
      continue;
    }

    if (spec.type === "flag") {
      result[token] = true;
      continue;
    }

    const val = argv[++i];
    if (val === undefined) {
      console.error(`Missing value for ${token}\n`);
      process.exit(1);
    }

    if (spec.type === "int")       result[token] = parseInt(val, 10);
    else if (spec.type === "float") result[token] = parseFloat(val);
    else if (spec.type === "str")    result[token] = val;
    else if (spec.type === "path")   result[token] = val;
    else if (spec.type === "choice") {
      if (!spec.choices.includes(val)) {
        console.error(`Invalid choice for ${token}: ${val}. Options: ${spec.choices.join(", ")}\n`);
        process.exit(1);
      }
      result[token] = val;
    }
  }
  return result;
}

function printHelp() {
  console.log(`FFXIV Market Board Cross-World Flipper

Usage: ffxiv-flip [options]

Options:
  --sell-world <str>        World to sell on               (default: ${DEFAULT_SELL_WORLD})
  --scope <choice>          Price scope: region | dc       (default: region)
  --sort-by <choice>        profit | margin | velocity | gpday | score  (default: profit)
  --top-n <int>             Rows to display                (default: 50)
  --csv <path>             Export results to CSV            (default: none)
  --show-velocity           Print velocity-ranked table      (default: off)
  --quick                   Relax all filters                (default: off)
  --min-price-floor <int>   Ignore items below this gil      (default: 100)
  --max-price-floor <int>   Ignore items above this gil      (default: none)
  --min-velocity <float>    Min daily units sold on server      (default: 5.0)
  --min-profit <int>        Min net profit per unit (gil)   (default: 200)
  --min-margin-pct <float>  Min profit margin (%)           (default: 5.0)
  --max-sale-age-hours <float>  Skip items sold > N hours ago  (default: none)
  --history-entries <int>   History rows per item            (default: 5)
  --workers <int>           Parallel API workers             (default: 5)
  -v, --verbose             Show batch count, scan progress
  -h, --help                Show this help

Examples:
  ffxiv-flip                              # default scan
  ffxiv-flip --quick                      # scan everything
  ffxiv-flip --sell-world Mateus --scope dc
  ffxiv-flip --min-price-floor 500 --max-price-floor 500000
  ffxiv-flip --sort-by gpday --csv flips.csv --top-n 200
  ffxiv-flip --quick --sort-by velocity --show-velocity --workers 8
  ffxiv-flip --sell-world Seraph --scope dc --min-profit 500
  ffxiv-flip --sell-world Faerie --max-sale-age-hours 72
`);
}

// ── display ────────────────────────────────────────────────────────────────────

const SORT_KEY = {
  profit:    (r) => r.gross,
  margin:    (r) => r.margin,
  velocity:  (r) => r.world_vel,
  gpday:     (r) => r.est_gp_d,
  score:     (r) => r.score,
};

function showTable(results, n = 50, sortBy = "profit") {
  if (results.length === 0) {
    console.log("No candidates.  Lower --min-profit / --min-velocity / --min-margin-pct.\n");
    return;
  }

  const key = SORT_KEY[sortBy] || ((r) => r.gross);
  const ordered = [...results].sort((a, b) => key(b) - key(a));

  const sep = "─".repeat(140);
  console.log(sep);
  console.log(
    ` ${pad("Item", 26)}  ${pad("ID", 9)}  ${pad("Buy", 9)}  ${pad("Home", 9)}` +
     `  ${pad("NetProfit", 9)}  ${pad("Margin", 6)}  ${pad("Vel/d", 8)}` +
    `  ${pad("Est GP/d", 10)}  ${pad("Conf", 6)}  ${pad("Score", 12)}` +
    `  ${pad("Last Sale", 20)}  ${pad("Avg Sale", 10)}`
  );
  console.log(sep);

  const slice = ordered.slice(0, n);
  for (const r of slice) {
    const avg = r.avg_sp ? `${Math.trunc(r.avg_sp).toLocaleString()} gil` : "—";
    const ageH = r.last_sale_age_h ?? 1e9;
    let lastStr;
    if (ageH >= 1e8) {
      lastStr = "—";
    } else if (ageH < 1) {
      lastStr = `${Math.trunc(ageH * 60)}m ago @ ${Math.trunc(r.last_sale_price).toLocaleString()}g`;
    } else if (ageH < 24) {
      lastStr = `${ageH.toFixed(1)}h ago @ ${Math.trunc(r.last_sale_price).toLocaleString()}g`;
    } else if (ageH < 168) {
      lastStr = `${(ageH / 24).toFixed(1)}d ago @ ${Math.trunc(r.last_sale_price).toLocaleString()}g`;
    } else {
      lastStr = `${Math.round(ageH / 24).toLocaleString()}d ago @ ${Math.trunc(r.last_sale_price).toLocaleString()}g`;
    }

    const name = r.name || `Item ${r.id}`;
    console.log(
      ` ${pad(name, 26)} ${String(r.id).padStart(9)}  ${r.buy.toLocaleString().padStart(9)} gil  ${r.home.toLocaleString().padStart(9)} gil` +
      `  ${r.gross.toLocaleString().padStart(9)} gil  ${r.margin.toFixed(1).padStart(5)}%` +
       `  ${r.world_vel.toFixed(1).padStart(8)}  ${r.est_gp_d.toLocaleString().padStart(10)} gil` +
      `  ${r.confidence.toFixed(1).padStart(5)}%  ${Math.trunc(r.score).toLocaleString().padStart(12)} gil` +
      `  ${lastStr.padStart(20)}  ${avg.padStart(10)}`
    );
  }
  console.log(sep);
  console.log(`Showing ${Math.min(n, results.length).toLocaleString()} of ${results.length.toLocaleString()} total.\n`);
}

function showVelocityTable(results, n = 30) {
  const ordered = [...results].sort((a, b) => b.world_vel - a.world_vel).slice(0, n);
  if (ordered.length === 0) return;

  console.log();
  console.log("═".repeat(86));
  console.log(`  ${"HIGHEST VELOCITY FLIPS".pad(84)}`);
  console.log("═".repeat(86));
  console.log(
    `  ${pad("Item", 26)}  ${pad("ID", 9)}  ${pad("Buy", 9)}  ${pad("Vel/d", 8)}  ${pad("Profit", 9)}  ${pad("Marg.", 6)}`
  );
  console.log("  " + "─".repeat(78));
  for (const r of ordered) {
    const ageH = r.last_sale_age_h ?? 1e9;
    let lastStr;
    if (ageH >= 1e8 || !r.last_sale_price) {
      lastStr = "—";
    } else if (ageH < 1) {
      lastStr = `${Math.trunc(ageH * 60)}m @ ${Math.trunc(r.last_sale_price).toLocaleString()}g`;
    } else if (ageH < 24) {
      lastStr = `${ageH.toFixed(0)}h @ ${Math.trunc(r.last_sale_price).toLocaleString()}g`;
    } else {
      lastStr = `${(ageH / 24).toFixed(1)}d @ ${Math.trunc(r.last_sale_price).toLocaleString()}g`;
    }
    const name = r.name || `Item ${r.id}`;
    console.log(
      `  ${pad(name, 26)} ${String(r.id).padStart(9)}  ${r.buy.toLocaleString().padStart(9)} gil` +
       `  ${r.world_vel.toFixed(1).padStart(8)}  ${r.gross.toLocaleString().padStart(9)} gil  ${r.margin.toFixed(1).padStart(5)}%  ${lastStr.padStart(20)}`
    );
  }
  console.log("═".repeat(86) + "\n");
}

function saveCsv(results, path) {
  const fields = [
    "id","name","buy","dc_min","home","fees","gross","margin",
    "avg_sp","world_vel","est_gp_d","confidence","score",
    "last_sale_age_h","last_sale_price","last_sale_qty",
  ];
  const rows = [...results].sort((a, b) => b.gross - a.gross);
  const lines = [fields.join(",")];
  for (const r of rows) {
    const row = fields.map((k) => {
      let v = r[k] ?? "";
      if (k === "last_sale_age_h") {
        v = (r.last_sale_age_h ?? 1e9) < 1e8 ? r.last_sale_age_h.toFixed(1) : "";
      } else if (typeof v === "number") {
        v = v.toLocaleString();
      }
      // Escape commas
      return String(v).includes(",") ? `"${v}"` : String(v);
    });
    lines.push(row.join(","));
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  console.log(`CSV → ${path}\n`);
}

// simple string pad (left-align / pad right)
function pad(str, len) {
  str = String(str ?? "");
  if (str.length >= len) return str;
  return str + " ".repeat(len - str.length);
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args["--help"]) {
    printHelp();
    process.exit(0);
  }

  const verbose = args["--verbose"];
  const vprint = (...msg) => {
    if (verbose) console.log(...msg);
  };

  if (args["--quick"]) {
    args["--min-velocity"] = 0;
    args["--min-profit"] = 0;
    args["--min-margin-pct"] = 0;
    args["--min-price-floor"] = 0;
    args["--max-price-floor"] = null;
    args["--max-sale-age-hours"] = null;
  }

  // ── Resolve targets ──
  vprint(`\n🎯  Sell on   : ${args["--sell-world"]}  [DC: ${DC_NAME}]`);
  vprint(`🌐  Buy scope : ${args["--scope"]}`);

  const worldMap = await fetchWorldMap();
  const dcList = await fetchDcWorlds(DC_NAME);

  const sellId = worldMap[args["--sell-world"].toLowerCase()];
  if (!sellId) {
    console.error(`ERROR: Sell world '${args["--sell-world"]}' not found.`);
    process.exit(1);
  }

  const sellWorldDc = await fetchDcName(sellId);
  vprint(`📊  Datacenter: ${DC_NAME}  worlds: ${dcList.join(", ")}`);

  const itemList = await fetchMarketable();
  vprint(`📦  Marketable items: ${itemList.length.toLocaleString()}\n`);

  const results = await runScan({
    itemIds: itemList,
    queryWorld: args["--sell-world"],
    sellWorldId: sellId,
    scope: args["--scope"],
    minVel: args["--min-velocity"],
    minProfit: args["--min-profit"],
    minPct: args["--min-margin-pct"],
    priceFloor: args["--min-price-floor"],
    maxPriceFloor: args["--max-price-floor"],
    maxSaleAgeH: args["--max-sale-age-hours"],
    historyEntries: args["--history-entries"],
    workers: args["--workers"],
    onLog: verbose ? vprint : null,
  });

  showTable(results, args["--top-n"], args["--sort-by"]);
  if (args["--show-velocity"]) showVelocityTable(results, 30);
  if (args["--csv"]) saveCsv(results, args["--csv"]);
}

// Graceful error handling
main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
