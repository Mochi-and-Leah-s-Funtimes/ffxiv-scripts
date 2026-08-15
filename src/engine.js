// src/engine.js
//
// Shared FFXIV Market Board flip-scan engine.
//
// Written as an ES module so it can be imported by:
//   • Node CLI  (src/cli.js)
//   • Web scanner (web/app.js)
//   • Static page (static/app.js)
//
// Zero external dependencies — relies on the native `fetch` available in
// Node >= 18 and all modern browsers.
//
// ── constants ─────────────────────────────────────────────────────────────────

export const API_BASE = "https://universalis.app/api/v2";
export const DC_NAME = "Crystal";
export const DEFAULT_SELL_WORLD = "Balmung";
export const FEE_RATE = 0.13; // 13 % — undercut + tax + retainer
export const BATCH = 100;     // Universalis max IDs per call

// ── small utilities ────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Concurrency-limited map over an array (replaces Python ThreadPoolExecutor).
//
// The callback `fn` is invoked with each item; at most `concurrency` invocations
// run simultaneously. Results are returned in the same order as the input.

export async function pool(items, fn, concurrency, onLog) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        if (onLog) onLog(`worker error: ${err.message}`);
        results[i] = null;
      }
    }
  }

  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

export async function httpGet(url, { retries = 4, timeoutMs = 20000, onLog } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (res.status === 429) {
        const wait = Math.pow(2, attempt);
        if (onLog) onLog(`429 — backing off ${wait}s`, url);
        await sleep(wait * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) {
        if (onLog) onLog(`fetch failed: ${url}`, err.message);
        return null;
      }
      await sleep(1000);
    }
  }
  return null;
}

// ── Universalis helpers ────────────────────────────────────────────────────────

export async function fetchMarketable() {
  return (await httpGet(`${API_BASE}/marketable`)) || [];
}

// Returns { worldNameLower: worldId }
export async function fetchWorldMap() {
  const worlds = (await httpGet(`${API_BASE}/worlds`)) || [];
  const map = {};
  for (const w of worlds) {
    map[w.name.toLowerCase()] = w.id;
  }
  return map;
}

// Returns array of world IDs belonging to the given datacenter.
export async function fetchDcWorlds(dc) {
  const dcs = (await httpGet(`${API_BASE}/data-centers`)) || [];
  for (const entry of dcs) {
    if (entry.name.toLowerCase() === dc.toLowerCase()) {
      return entry.worlds;
    }
  }
  throw new Error(`datacenter '${dc}' not found.`);
}

// Returns the human-readable DC name for a world ID (for display / scope logic).
export async function fetchDcName(worldId) {
  const dcs = (await httpGet(`${API_BASE}/data-centers`)) || [];
  for (const entry of dcs) {
    if (Array.isArray(entry.worlds) && entry.worlds.includes(worldId)) {
      return entry.name;
    }
  }
  return null;
}

// ── Item name resolution (xivapi) ──────────────────────────────────────────────

// v1 batch endpoint: https://xivapi.com/item?ids=1,2,3,...
async function fetchV1Batch(batch) {
  const ids = batch.join(",");
  const url = `https://xivapi.com/item?ids=${ids}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 429) {
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      if (!data || typeof data !== "object" || !Array.isArray(data.Results)) return {};
      const out = {};
      for (const item of data.Results) {
        if (item && typeof item === "object") {
          out[item.ID] = item.Name;
        }
      }
      return out;
    } catch (err) {
      clearTimeout(timer);
      if (attempt < 2) await sleep(1000);
    }
  }
  return {};
}

// v2 single-item fallback: https://v2.xivapi.com/api/sheet/Item/{id}?fields=Name
async function fetchV2Single(iid) {
  const url = `https://v2.xivapi.com/api/sheet/Item/${iid}?fields=Name`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 429) {
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      // v2 may nest under .fields.Name or return Name directly
      const name = data?.fields?.Name || data?.Name || "";
      return name || null;
    } catch (err) {
      clearTimeout(timer);
      if (attempt < 3) await sleep(1000);
    }
  }
  return null;
}

export async function fetchItemNames(itemIds, { workers = 5, onLog } = {}) {
  if (itemIds.length === 0) return {};

  // Chunk into batches of 100 for the v1 endpoint
  const batches = [];
  for (let i = 0; i < itemIds.length; i += 100) {
    batches.push(itemIds.slice(i, i + 100));
  }

  const result = {};
  const batchResults = await pool(
    batches,
    (b) => fetchV1Batch(b),
    workers,
    onLog
  );
  for (const partial of batchResults) {
    if (partial) Object.assign(result, partial);
  }

  // v2 fallback for anything still unresolved
  const unresolved = itemIds.filter((id) => !result[id]);
  if (unresolved.length > 0) {
    if (onLog) onLog(`Falling back to v2.xivapi for ${unresolved.length} items`);
    const v2Results = await pool(
      unresolved,
      (iid) => fetchV2Single(iid),
      workers,
      onLog
    );
    for (let i = 0; i < unresolved.length; i++) {
      const name = v2Results[i];
      if (name) result[unresolved[i]] = name;
    }
  }

  return result;
}

// ── Sale history ───────────────────────────────────────────────────────────────

// Fetch sale history for a batch of items on targetWorld.
// Returns { itemId: { last_sale_ts, last_sale_price, last_sale_qty, last_sale_age_h } }
export async function fetchHistoryBatch(batch, targetWorld, entries = 5) {
  const ids = batch.join(",");
  const url = `${API_BASE}/history/${targetWorld}/${ids}?entries=${entries}`;
  const raw = await httpGet(url);
  if (!raw) return {};

  const history = {};
  const now = Date.now() / 1000; // seconds, matching Python time.time()

  const itemsData = raw.items || {};
  for (const [itemIdStr, itemData] of Object.entries(itemsData)) {
    const iid = parseInt(itemIdStr, 10);
    const entryList = itemData?.entries || [];
    if (!entryList || entryList.length === 0) {
      history[iid] = {
        last_sale_ts: 0,
        last_sale_price: 0,
        last_sale_qty: 0,
        last_sale_age_h: 1e9,
      };
      continue;
    }

    const latest = entryList[0];
    const ts = latest?.timestamp || 0;
    history[iid] = {
      last_sale_ts: ts,
      last_sale_price: latest?.pricePerUnit || 0,
      last_sale_qty: latest?.quantity || 0,
      last_sale_age_h: ts ? (now - ts) / 3600 : 1e9,
    };
  }

  return history;
}

// Fetch active listings for a batch of items on targetWorld.
// Returns { itemId: total_quantity } — sum of all quantities listed on that world.
export async function fetchListingsBatch(batch, targetWorld) {
  const ids = batch.join(",");
  const url = `${API_BASE}/${targetWorld}/${ids}`;
  const raw = await httpGet(url);
  if (!raw) return {};

  const supply = {};
  const items = raw.items || {};
  for (const [itemIdStr, itemData] of Object.entries(items)) {
    const iid = parseInt(itemIdStr, 10);
    const qty = itemData?.unitsForSale ?? 0;
    supply[iid] = qty;
  }

  return supply;
}

// ── Per-batch processing ───────────────────────────────────────────────────────

// Fetch aggregated data for one batch of item IDs and apply filter logic.
// Returns { candidates: [...], noData: number }
export async function processBatch(
  batch,
  queryWorld,
  sellWorldId,
  scope,
  minVel,
  minProfit,
  minPct,
  priceFloor,
  maxPriceFloor
) {
  const ids = batch.join(",");
  const url = `${API_BASE}/aggregated/${queryWorld}/${ids}`;
  const raw = await httpGet(url);
  if (!raw) return { candidates: [], noData: 0 };

  const candidates = [];
  let noData = 0;

  for (const d of raw.results || []) {
    const iid = d.itemId;
    const nq = d.nq || {};
    const hq = d.hq || {};

    // Pick NQ if it has a minListing, else HQ if it has one, else skip
    const market = nq.minListing ? nq : hq.minListing ? hq : null;
    if (market === null) {
      noData++;
      continue;
    }

    const ml = market.minListing;
    const vel = market.dailySaleVelocity || {};

    const worldP = ml.world?.price;
    const dcP = ml.dc?.price;
    const regionP = ml.region?.price;

    const worldVel = vel.world?.quantity || 0;
    const dcVel = vel.dc?.quantity || 0;
    const regionVel = vel.region?.quantity || 0;
    const effVel = worldVel || dcVel || regionVel;

    if (effVel < minVel) continue;
    if (!worldP) continue;

    // Determine buy price from scope
    let buyPrice;
    if (scope === "dc") {
      buyPrice = dcP;
      if (ml.dc?.worldId === sellWorldId) continue; // sell world is cheapest on DC
    } else {
      buyPrice = regionP;
      if (ml.region?.worldId === sellWorldId) continue;
    }

    if (!buyPrice) continue;
    if (buyPrice < priceFloor) continue;
    if (maxPriceFloor !== null && worldP > maxPriceFloor) continue;

    const fees = Math.trunc(worldP * FEE_RATE);
    const netSell = worldP - fees;
    const gross = netSell - buyPrice;
    const margin = buyPrice ? (netSell - buyPrice) / buyPrice * 100 : 0;
    const estGpD = gross * effVel;

    if (gross < minProfit || margin < minPct) continue;

    const avgSp = market.averageSalePrice?.dc?.price;
    const buyWorldId = scope === "dc" ? ml.dc?.worldId : ml.region?.worldId;

    candidates.push({
      id: iid,
      buy: buyPrice,
      dc_min: dcP,
      buy_world_id: buyWorldId,
      home: worldP,
      fees: fees,
      gross: gross,
      margin: margin,
      avg_sp: avgSp,
      world_vel: worldVel,
      est_gp_d: Math.trunc(estGpD),
      home_supply: 0,
    });
  }

  return { candidates, noData };
}

// ── Main scan ──────────────────────────────────────────────────────────────────

// Run the full flip scan.
//
// Options:
//   itemIds            number[]          — marketable item IDs to scan
//   queryWorld         string            — sell-world name (Universalis path param)
//   sellWorldId        number            — numeric world ID for scope checks
//   scope              "dc" | "region"   — buy price scope
//   minVel             float             — min daily sales velocity
//   minProfit          int               — min net profit per unit
//   minPct             float             — min profit margin %
//   priceFloor         int               — min price to consider
//   maxPriceFloor      int | null        — max home price (troll filter)
//   maxSaleAgeH        float | null      — reject items last sold > N hours ago
//   historyEntries     int               — history depth per item
//   workers            int               — parallel API workers
//   onLog              (msg) => void      — debug / progress messages
//   onBatchProgress    (done, total) => void — batch completion counter
//
export async function runScan({
  itemIds,
  queryWorld,
  sellWorldId,
  scope,
  minVel,
  minProfit,
  minPct,
  priceFloor,
  maxPriceFloor,
  maxSaleAgeH,
  historyEntries,
  workers = 5,
  onLog = null,
  onBatchProgress = null,
} = {}) {
  const batches = [];
  for (let i = 0; i < itemIds.length; i += BATCH) {
    batches.push(itemIds.slice(i, i + BATCH));
  }
  const total = batches.length;
  if (onLog) onLog(`Batches: ${total} (${itemIds.length.toLocaleString()} items @ ${BATCH}/batch)`);

  let allCand = [];
  let noData = 0;
  let done = 0;
  const t0 = Date.now();

  const batchResults = await pool(
    batches,
    (b) =>
      processBatch(
        b,
        queryWorld,
        sellWorldId,
        scope,
        minVel,
        minProfit,
        minPct,
        priceFloor,
        maxPriceFloor
      ),
    workers,
    onLog
  );

  for (const { candidates, noData: nd } of batchResults) {
    if (candidates) allCand.push(...candidates);
    noData += nd || 0;
    done++;
    if (onBatchProgress) onBatchProgress(done, total);
    if (onLog && (done % 25 === 0 || done === total)) {
      const elapsed = (Date.now() - t0) / 1000;
      onLog(
        `[${done}/${total}] ${elapsed.toFixed(1)}s — ${allCand.length.toLocaleString()} candidates`
      );
    }
  }

  const elapsed = (Date.now() - t0) / 1000;
  if (onLog)
    onLog(
      `${total} batches in ${elapsed.toFixed(1)}s | ${allCand.length.toLocaleString()} flip candidates | ${noData.toLocaleString()} items with no listings`
    );

  // ── History enrichment ────────────────────────────────────────────────────
  if (allCand.length === 0) return allCand;

  const candIds = allCand.map((c) => c.id);
  const histBatches = [];
  for (let i = 0; i < candIds.length; i += BATCH) {
    histBatches.push(candIds.slice(i, i + BATCH));
  }
  if (onLog)
    onLog(
      `Fetching history for ${candIds.length.toLocaleString()} candidates (${histBatches.length} batches)`
    );

  const t1 = Date.now();
  const historyMap = {};
  const histResults = await pool(
    histBatches,
    (hb) => fetchHistoryBatch(hb, queryWorld, historyEntries),
    workers,
    onLog
  );
  for (const partial of histResults) {
    if (partial) Object.assign(historyMap, partial);
  }
  if (onLog) onLog(`History fetched in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  // Merge history + age filter
  let filteredByAge = 0;
  for (const c of allCand) {
    const h = historyMap[c.id] || {};
    c.last_sale_age_h = h.last_sale_age_h ?? 1e9;
    c.last_sale_price = h.last_sale_price ?? 0;
    c.last_sale_qty = h.last_sale_qty ?? 0;
    c.last_sale_ts = h.last_sale_ts ?? 0;

    if (maxSaleAgeH !== null && c.last_sale_age_h > maxSaleAgeH) {
      c._filteredAge = true;
      filteredByAge++;
    } else {
      c._filteredAge = false;
    }
  }

  if (filteredByAge) {
    if (onLog)
      onLog(`Filtered out ${filteredByAge.toLocaleString()} items last sold > ${maxSaleAgeH.toFixed(0)}h ago`);
    allCand = allCand.filter((c) => !c._filteredAge);
  }

  // ── Supply enrichment ────────────────────────────────────────────────────────
  if (allCand.length > 0) {
    const ids = allCand.map((c) => c.id);
    const supplyBatches = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      supplyBatches.push(ids.slice(i, i + BATCH));
    }
    if (onLog)
      onLog(
        `Fetching supply data for ${ids.length.toLocaleString()} candidates (${supplyBatches.length} batches)`
      );

    const t3 = Date.now();
    const supplyMap = {};
    const supplyResults = await pool(
      supplyBatches,
      (sb) => fetchListingsBatch(sb, queryWorld),
      workers,
      onLog
    );
    for (const partial of supplyResults) {
      if (partial) Object.assign(supplyMap, partial);
    }
    if (onLog) onLog(`Supply fetched in ${((Date.now() - t3) / 1000).toFixed(1)}s`);

    for (const c of allCand) {
      c.home_supply = supplyMap[c.id] || 0;
    }
  }

  // ── Score computation ────────────────────────────────────────────────────────
  // A flip's attractiveness is driven by three factors:
  //   gross      — absolute profit per unit (gil)
  //   world_vel  — daily sales velocity on the sell world
  //   confidence — last_sale_price / current home price (0-1)
  //
  // Raw product `gross * vel * confidence` spans orders of magnitude because
  // velocity can range from ~0.5 to 600+. We dampen velocity with sqrt() so
  // extreme outliers don't completely dominate, then scale to a readable range.

  // Compute confidence + score
  for (const c of allCand) {
    const target = c.home;
    const last = c.last_sale_price || 0;
    c.confidence = target && target > 0 ? Math.min(1.0, last / target) : 0;

    const gross = Math.sqrt(Math.min(c.gross, 500_000));              // cap extreme outliers
    const vel = Math.sqrt(Math.max(1, c.world_vel));        // diminishing returns on velocity
    const conf = Math.max(0.05, c.confidence);            // floor so unknowns don't score 0

    // supply factor: 1.0 when <3 items listed, 0.05 when >=20 items, linear between
    const supply = c.home_supply || 0;
    const supplyFactor = supply >= 20 ? 0.05 : supply < 3 ? 1.0 : 1.0 - ((supply - 3) / 17) * 0.95;

    c.score = (gross * vel * conf * supplyFactor) / 10;
  }

  // ── Item-name enrichment ──────────────────────────────────────────────────
  if (allCand.length > 0) {
    const ids = allCand.map((c) => c.id);
    if (onLog) onLog(`Fetching item names for ${ids.length.toLocaleString()} candidates`);
    const t2 = Date.now();
    const nameMap = await fetchItemNames(ids, { workers, onLog });
    if (onLog) onLog(`Names fetched in ${((Date.now() - t2) / 1000).toFixed(1)}s`);
    for (const c of allCand) {
      c.name = nameMap[c.id] || `Item ${c.id}`;
    }
  }

  if (onLog) onLog(`Final candidates: ${allCand.length.toLocaleString()}`);
  return allCand;
}
