#!/usr/bin/env node
// src/run_scans.js
//
// Parent orchestrator: launches N scan workers in parallel, each bound to a
// different local IP, then writes a summary index.json.
//
// Usage:
//   node src/run_scans.js --sell-world Balmung --prefix ""
//
// Arguments:
//   --sell-world <str>   World to scan (default: Balmung)
//   --prefix <str>       Filename prefix for JSON output (default: "")
//                        e.g. --prefix "mateus_" → mateus_high_tier.json
//
// IPs are read from the SCAN_IPS env var (comma-separated):
//   SCAN_IPS=2603:c021:1:a500:7588::1,2603:c021:1:a500:7588::2,2603:c021:1:a500:7588::3,2603:c021:1:a500:7588::4 node src/run_scans.js
//
// If SCAN_IPS is not set, the script auto-detects available IPv6/IPv4 addresses.
//
// Output: web/scans/<prefix><scan-name>.json  +  web/scans/index.json
//

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const OUTPUT_DIR = join(PROJECT_ROOT, "web", "scans");

// ── Argument parsing ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let SELL_WORLD = "Balmung";
let PREFIX = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--sell-world" && args[i + 1]) {
    SELL_WORLD = args[++i];
  } else if (args[i] === "--prefix" && args[i + 1]) {
    PREFIX = args[++i];
  }
}

// ── Scan configurations ────────────────────────────────────────────────────────
// Mirrors the user's bash script of Python market_flipper.py invocations.
// Each scan targets a different price tier on the configured sell world (DC scope).

const DEFAULT_OPTS = {
  scope:        "dc",
  minPct:       5.0,
  historyEntries: 5,
  workers:      6,
  topN:         15,
};

const SCANS = [
  {
    name:  "gillionaire",
    label: "High Tier (500k–10M)",
    opts: {
      ...DEFAULT_OPTS,
      minProfit:  100000,
      priceFloor: 500000,
      maxPriceFloor: 10000000,
      maxSaleAgeH: 72,
      minVel:     5,
      sortBy:     "score",
    },
  },
  {
    name:  "high",
    label: "Mid-High (100k–1M)",
    opts: {
      ...DEFAULT_OPTS,
      minProfit:  50000,
      priceFloor: 100000,
      maxPriceFloor: 1000000,
      maxSaleAgeH: 48,
      minVel:     10,
      sortBy:     "score",
    },
  },
  {
    name:  "mid",
    label: "Mid Tier (50k–250k)",
    opts: {
      ...DEFAULT_OPTS,
      minProfit:  10000,
      priceFloor: 50000,
      maxPriceFloor: 250000,
      maxSaleAgeH: 16,
      minVel:     15,
      sortBy:     "profit",
    },
  },
  {
    name:  "low",
    label: "Low Tier (10k–100k)",
    opts: {
      ...DEFAULT_OPTS,
      minProfit:  5000,
      priceFloor: 10000,
      maxPriceFloor: 100000,
      maxSaleAgeH: 4,
      minVel:     30,
      sortBy:     "velocity",
    },
  },
];

// ── IP detection ───────────────────────────────────────────────────────────────

function getLocalIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const iface of Object.values(nets)) {
    for (const addr of iface) {
      if (addr.internal) continue;
      if (addr.family === "inet6" && addr.scopeid !== 0) continue; // skip link-local
      const key = addr.family + ":" + addr.address;
      if (!ips.includes(key)) ips.push(addr.address);
    }
  }
  // Prefer IPv6 first, then IPv4
  return ips.sort((a, b) => {
    const a6 = a.includes(":"); const b6 = b.includes(":");
    if (a6 && !b6) return -1;
    if (!a6 && b6) return 1;
    return 0;
  });
}

const IPS = process.env.SCAN_IPS
  ? process.env.SCAN_IPS.split(",").map((s) => s.trim()).filter(Boolean)
  : getLocalIps();

// ── Worker spawning ────────────────────────────────────────────────────────────

function spawnWorker(scan, ip, outputFile) {
  const workerScript = join(__dirname, "scan_worker.js");
  const child = spawn("node", [workerScript, ip, JSON.stringify({ ...scan, sellWorld: SELL_WORLD }), outputFile], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.on("data", (data) => process.stdout.write(data));
  child.stderr.on("data", (data) => process.stderr.write(data));

  return new Promise((resolve) => {
    child.on("close", (code) => {
      resolve({ scan, ip, code, outputFile });
    });
  });
}

async function main() {
  if (IPS.length < SCANS.length) {
    console.error(`⚠  Need at least ${SCANS.length} IPs, got ${IPS.length}.`);
    console.error(`   Set SCAN_IPS env var (comma-separated) or ensure ${SCANS.length} IPv4 addresses are available.`);
    console.error(`   Detected: ${IPS.join(", ")}`);
    process.exit(1);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const startedAt = new Date().toISOString();
  console.log(`🚀 Starting ${SCANS.length} parallel scans on ${IPS.slice(0, SCANS.length).join(", ")}`);
  console.log(`   Started at: ${startedAt}\n`);

  const promises = SCANS.map((scan, i) => {
    const ip = IPS[i];
    const outputFile = join(OUTPUT_DIR, `${PREFIX}${scan.name}.json`);
    return spawnWorker({ ...scan, sellWorld: SELL_WORLD }, ip, outputFile);
  });

  const results = await Promise.all(promises);

  const completedAt = new Date().toISOString();
  const successCount = results.filter((r) => r.code === 0).length;

  const summary = {
    startedAt,
    completedAt,
    sellWorld: SELL_WORLD,
    prefix: PREFIX || "(none)",
    datacenter: "Crystal",
    ips: IPS.slice(0, SCANS.length),
    totalScans: SCANS.length,
    succeeded: successCount,
    failed: SCANS.length - successCount,
    scans: results.map((r) => ({
      name:       r.scan.name,
      label:      r.scan.label,
      ip:         r.ip,
      status:     r.code === 0 ? "completed" : "failed",
      exitCode:   r.code,
      outputFile: r.code === 0 ? `${PREFIX}${r.scan.name}.json` : null,
    })),
  };

  writeFileSync(join(OUTPUT_DIR, "index.json"), JSON.stringify(summary, null, 2));

  console.log(`\n✅ ${successCount}/${SCANS.length} scans completed. Summary → ${join(OUTPUT_DIR, "index.json")}`);
  if (successCount < SCANS.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
