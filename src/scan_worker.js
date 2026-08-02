#!/usr/bin/env node
// src/scan_worker.js
//
// Worker script: runs a single flip scan bound to a specific local IP.
// Spawned by run_scans.js (one worker per scan config).
//
// Usage:
//   node src/scan_worker.js <ip> <json-config> <output-file>
//
// The worker overrides globalThis.fetch with an IP-bound version (from
// ip_fetch.js) before invoking the engine, so every API call — including
// item-name lookups via xivapi — is sourced from the assigned IP.
//

import { writeFileSync } from "node:fs";
import { createIpFetch } from "./ip_fetch.js";
import {
  fetchMarketable,
  fetchWorldMap,
  fetchDcWorlds,
  fetchDcName,
  runScan,
  DC_NAME,
  DEFAULT_SELL_WORLD,
} from "./engine.js";

const ip = process.argv[2];
const config = JSON.parse(process.argv[3]);
const outputFile = process.argv[4];

const label = `[${config.name || "scan"}]`;

// ── Bind all fetch calls to the assigned IP ───────────────────────────────────

const ipFetch = createIpFetch(ip);
globalThis.fetch = ipFetch;

const SORT_KEY = {
  profit:    "gross",
  margin:    "margin",
  velocity:  "dc_vel",
  gpday:     "est_gp_d",
  score:     "score",
};

async function main() {
  const sellWorld = config.sellWorld || DEFAULT_SELL_WORLD;
  const opts = config.opts || {};

  console.log(`${label} Starting scan on IP ${ip}, sell world: ${sellWorld}`);

  // Resolve world ID
  const worldMap = await fetchWorldMap();
  const sellId = worldMap[sellWorld.toLowerCase()];
  if (!sellId) throw new Error(`Sell world '${sellWorld}' not found.`);

  const sellWorldDc = await fetchDcName(sellId);
  console.log(`${label} ${sellWorld} (ID ${sellId}) [DC: ${sellWorldDc || "?"}]`);

  // Fetch marketable item list
  const itemList = await fetchMarketable();
  console.log(`${label} ${itemList.length.toLocaleString()} marketable items`);

  // Run the scan
  const results = await runScan({
    itemIds:    itemList,
    queryWorld: sellWorld,
    sellWorldId: sellId,
    ...opts,
    onLog: (msg) => console.log(`${label} ${msg}`),
  });

  // Sort by configured key
  const key = SORT_KEY[opts.sortBy] || SORT_KEY.profit;
  results.sort((a, b) => {
    const va = a[key] ?? 0;
    const vb = b[key] ?? 0;
    return vb - va;
  });

  const topN = opts.topN || 50;
  const output = {
    name: config.name || "scan",
    label: config.label || config.name || "Scan",
    sellWorld,
    datacenter: sellWorldDc || DC_NAME,
    generatedAt: new Date().toISOString(),
    count: results.length,
    worlds: worldMap,
    results: results.slice(0, topN),
  };

  writeFileSync(outputFile, JSON.stringify(output, null, 2));
  console.log(`${label} ✅ ${results.length.toLocaleString()} candidates → ${outputFile}`);
}

main().catch((err) => {
  console.error(`${label} ERROR: ${err.message}`);
  process.exit(1);
});
