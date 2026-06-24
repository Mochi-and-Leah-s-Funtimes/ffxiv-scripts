#!/usr/bin/env python3
"""
FFXIV Market Board Cross-World Flipper
=======================================
Identifies items you can buy cheaply outside Balmung and relist on Balmung.

Strategy:  cheapest cheapest cheapest cheapest cheapest cheapest v
             on Crystal DC ────────────────────────────────►

API : Universalis v2  (https://docs.universalis.app)
DC  : Crystal (North America)
Sell world: Balmung

Fee model baked into net-sell estimate:
    3%  undercut fee  +  ≤5% city GC tax  +  5% retainer fee  ≈ 13%

Usage examples:
    python market_flipper.py                           # sensible defaults
    python market_flipper.py --quick                   # unfiltered full scan
    python market_flipper.py --min-velocity 10 --min-profit 500
    python market_flipper.py --sort-by gpday --csv flips.csv
    python market_flipper.py --show-velocity --min-velocity 1
"""

from __future__ import annotations

import argparse
import csv
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

try:
    import requests
except ImportError:
    sys.exit("ERROR: 'requests' is required.  pip install requests")

# ── constants ─────────────────────────────────────────────────────────────────
API_BASE   = "https://universalis.app/api/v2"
DC_NAME    = "Crystal"
SELL_WORLD = "Balmung"
FEE_RATE   = 0.13          # 13 % — undercut + tax + retainer
BATCH      = 100           # Universalis max IDs per call

# ── HTTP ──────────────────────────────────────────────────────────────────────

def _get(url: str, retries: int = 4, timeout: int = 20) -> Any | None:
    for attempt in range(1, retries + 1):
        try:
            r = requests.get(url, timeout=timeout)
            if r.status_code == 429:
                wait = 2 ** attempt
                print(f"\n  ⏳ 429 — backing off {wait}s", flush=True)
                time.sleep(wait)
                continue
            r.raise_for_status()
            return r.json()
        except requests.exceptions.RequestException as exc:
            if attempt == retries:
                print(f"\n  ✗ fetch failed: {url}\n    {exc}", flush=True)
                return None
            time.sleep(1)
    return None

# ── Universalis helpers ────────────────────────────────────────────────────────

def fetch_marketable() -> list[int]:
    return _get(f"{API_BASE}/marketable") or []

def fetch_world_map() -> dict[str, int]:
    return {w["name"].lower(): w["id"] for w in (_get(f"{API_BASE}/worlds") or [])}

def fetch_dc_worlds(dc: str) -> list[int]:
    for entry in (_get(f"{API_BASE}/data-centers") or []):
        if entry["name"].lower() == dc.lower():
            return entry["worlds"]
    sys.exit(f"ERROR: datacenter '{dc}' not found.")


def fetch_item_names(item_ids: list[int], workers: int = 5) -> dict[int, str]:
    """
    Fetch item names from xivapi.com (v1 batch, then v2 fallback for unresolved).
    Returns {item_id: name}.
    """
    batches = [item_ids[i:i + 100] for i in range(0, len(item_ids), 100)]
    result: dict[int, str] = {}

    def _get_v1(batch):
        ids = ",".join(str(i) for i in batch)
        url = f"https://xivapi.com/item?ids={ids}"
        for attempt in range(3):
            try:
                r = requests.get(url, timeout=15)
                if r.status_code == 429:
                    time.sleep(2 ** attempt)
                    continue
                r.raise_for_status()
                data = r.json()
                if not isinstance(data, dict):
                    return {}
                results_list = data.get("Results") or []
                if not isinstance(results_list, list):
                    return {}
                out: dict[int, str] = {}
                for item in results_list:
                    if isinstance(item, dict):
                        out[item.get("ID", 0)] = item.get("Name", "")
                return out
            except requests.exceptions.RequestException:
                time.sleep(1)
        return {}

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(_get_v1, b): b for b in batches}
        for fut in as_completed(futures):
            result.update(fut.result())

    unresolved = [iid for iid in item_ids if not result.get(iid)]
    if unresolved:
        unresolved_names = _get_v2_batch(unresolved)
        result.update(unresolved_names)

    return result


def _get_v2_batch(item_ids: list[int], workers: int = 5) -> dict[int, str]:
    """
    Fallback: resolve unresolved IDs via v2.xivapi.com in parallel.
    """
    out: dict[int, str] = {}

    def _fetch_one(iid):
        url = f"https://v2.xivapi.com/api/sheet/Item/{iid}?fields=Name"
        for attempt in range(2):
            try:
                r = requests.get(url, timeout=10)
                if r.status_code == 429:
                    time.sleep(1)
                    continue
                r.raise_for_status()
                data = r.json()
                name = data.get("fields", {}).get("Name", "")
                return iid, name if name else None
            except requests.exceptions.RequestException:
                time.sleep(0.5)
        return iid, None

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(_fetch_one, iid): iid for iid in item_ids}
        for fut in as_completed(futures):
            iid, name = fut.result()
            if name:
                out[iid] = name
    return out


def fetch_history_batch(batch: list[int], target_world: str, entries: int = 5) -> dict[int, dict]:
    """
    Fetch sale history for a batch of items.
    Returns {item_id: {last_sale_ts, last_sale_price, last_sale_qty, last_sale_age_h}}.
    """
    ids = ",".join(str(i) for i in batch)
    url = f"{API_BASE}/history/{target_world}/{ids}?entries={entries}"
    raw = _get(url)
    if not raw:
        return {}

    history: dict[int, dict] = {}
    now = time.time()

    items_data = raw.get("items", {})
    for item_id_str, item_data in items_data.items():
        iid = int(item_id_str)
        entries_list = item_data.get("entries", [])
        if not entries_list:
            history[iid] = {"last_sale_ts": 0, "last_sale_price": 0,
                            "last_sale_qty": 0, "last_sale_age_h": 1e9}
            continue

        latest = entries_list[0]
        ts = latest.get("timestamp", 0)
        history[iid] = {
            "last_sale_ts":    ts,
            "last_sale_price": latest.get("pricePerUnit", 0),
            "last_sale_qty":   latest.get("quantity", 0),
            "last_sale_age_h": (now - ts) / 3600 if ts else 1e9,
        }

    return history

# ── per-batch processing ────────────────────────────────────────────────────────

def _process_batch(batch: list[int],
                   sell_world_id: int,
                   min_vel: float,
                   min_profit: int,
                   min_pct: float,
                   price_floor: int,
                   max_price_floor: int | None) -> tuple[list[dict], int]:
    """
    Fetch aggregated data for one batch.
    Returns (candidates, items_with_no_market_data).
    """
    ids    = ",".join(str(i) for i in batch)
    url    = f"{API_BASE}/aggregated/{SELL_WORLD}/{ids}"  # query Balmung → gets Balmung price + DC/region data
    raw    = _get(url)
    if not raw:
        return [], 0

    candidates: list[dict] = []
    no_data   = 0

    for d in raw.get("results", []):
        iid    = d["itemId"]
        nq     = d.get("nq", {})
        hq     = d.get("hq", {})
        market = (nq if nq.get("minListing")
                  else hq if hq.get("minListing") else None)
        if market is None:
            no_data += 1
            continue

        ml  = market["minListing"]
        vel = market.get("dailySaleVelocity", {})

        world_p  = ml.get("world",  {}).get("price")
        dc_p     = ml.get("dc",     {}).get("price")
        region_p = ml.get("region", {}).get("price")

        dc_vel     = vel.get("dc",    {}).get("quantity", 0)
        region_vel = vel.get("region", {}).get("quantity", 0)
        eff_vel    = max(dc_vel, region_vel)

        if eff_vel < min_vel:
            continue
        if not (world_p and dc_p and region_p):
            continue

        # skip if cheapest source or DC-cheapest world is Balmung itself
        if ml.get("region", {}).get("worldId")  == sell_world_id:
            continue
        if ml.get("dc",     {}).get("worldId")  == sell_world_id:
            continue

        # buy from cheapest anywhere (other than Balmung — already filtered above)
        buy_price   = region_p
        if buy_price < price_floor:
            continue
        if max_price_floor is not None and world_p > max_price_floor:
            continue

        fees      = int(world_p * FEE_RATE)
        net_sell  = world_p - fees
        gross     = net_sell - buy_price
        margin    = (net_sell - buy_price) / buy_price * 100 if buy_price else 0.0
        est_gp_d  = gross * eff_vel

        if gross < min_profit or margin < min_pct:
            continue

        avg_sp = market.get("averageSalePrice", {}).get("dc", {}).get("price")

        candidates.append({
            "id":        iid,
            "buy":       buy_price,
            "dc_min":    dc_p,
            "balmung":   world_p,
            "fees":      fees,
            "gross":     gross,
            "margin":    margin,
            "avg_sp":    avg_sp,
            "dc_vel":    dc_vel,
            "est_gp_d":  int(est_gp_d),
        })

    return candidates, no_data


# ── main scan ──────────────────────────────────────────────────────────────────

def run_scan(item_ids: list[int],
             sell_world_id: int,
             min_vel: float,
             min_profit: int,
             min_pct: float,
             price_floor: int,
             max_price_floor: int | None,
             max_sale_age_h: float | None,
             history_entries: int,
             workers: int = 5) -> list[dict]:
    batches = [item_ids[i:i + BATCH]
               for i in range(0, len(item_ids), BATCH)]
    total   = len(batches)
    print(f"    Batches    : {total}  ({len(item_ids):,} items @ {BATCH}/batch)\n")

    all_cand: list[dict] = []
    no_data  = 0
    done     = 0
    t0       = time.time()

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {
            ex.submit(_process_batch, b, sell_world_id,
                      min_vel, min_profit, min_pct,
                      price_floor, max_price_floor): b
            for b in batches
        }
        for fut in as_completed(futures):
            cand, nd = fut.result()
            all_cand.extend(cand)
            no_data  += nd
            done     += 1
            if done % 25 == 0 or done == len(batches):
                print(f"\r    [{done:>4}/{len(batches)} batch"
                      f"{'es' if len(batches)!=1 else ''}]  "
                      f"{time.time()-t0:5.1f}s  "
                      f"{len(all_cand):,} candidates",
                      end="", flush=True)

    elapsed = time.time() - t0
    print(f"\n\n✅  {len(batches)} batches in {elapsed:.1f}s"
          f"  |  {len(all_cand):,} flip candidates"
          f"  |  {no_data:,} items with no listings")

    # ── History enrichment ───────────────────────────────────────────────────
    if not all_cand:
        return all_cand

    cand_ids = [c["id"] for c in all_cand]
    hist_batches = [cand_ids[i:i + BATCH]
                    for i in range(0, len(cand_ids), BATCH)]
    print(f"    Fetching history for {len(cand_ids):,} candidates "
          f"({len(hist_batches)} batch{'es' if len(hist_batches)!=1 else ''})…")
    t1 = time.time()
    history_map: dict[int, dict] = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        h_futures = {
            ex.submit(fetch_history_batch, hb, SELL_WORLD, history_entries): hb
            for hb in hist_batches
        }
        for hf in as_completed(h_futures):
            history_map.update(hf.result())

    print(f"    History fetched in {time.time()-t1:.1f}s")

    # Merge history into candidates
    filtered_by_age = 0
    for c in all_cand:
        h = history_map.get(c["id"], {})
        c["last_sale_age_h"] = h.get("last_sale_age_h", 1e9)
        c["last_sale_price"] = h.get("last_sale_price", 0)
        c["last_sale_qty"]   = h.get("last_sale_qty", 0)
        c["last_sale_ts"]    = h.get("last_sale_ts", 0)

        if (max_sale_age_h is not None
                and c["last_sale_age_h"] > max_sale_age_h):
            c["_filtered_age"] = True
            filtered_by_age += 1
        else:
            c["_filtered_age"] = False

    if filtered_by_age:
        print(f"    Filtered out {filtered_by_age:,} items last sold > {max_sale_age_h:.0f}h ago")
        all_cand = [c for c in all_cand if not c.get("_filtered_age")]

    # ── Item-name enrichment ────────────────────────────────────────────────
    if all_cand:
        cand_ids = [c["id"] for c in all_cand]
        print(f"    Fetching item names for {len(cand_ids):,} candidates…")
        t2 = time.time()
        name_map = fetch_item_names(cand_ids, workers=workers)
        print(f"    Names fetched in {time.time()-t2:.1f}s")
        for c in all_cand:
            c["name"] = name_map.get(c["id"], f"Item {c['id']}")

    print(f"    Final candidates: {len(all_cand):,}\n")
    return all_cand

# ── display ────────────────────────────────────────────────────────────────────

def _show(results: list[dict], n: int = 50, sort_by: str = "gross") -> None:
    if not results:
        print("No candidates.  Lower --min-profit / --min-velocity / --min-margin-pct.\n")
        return

    key = {
        "profit":  lambda r: r["gross"],
        "margin":  lambda r: r["margin"],
        "velocity": lambda r: r["dc_vel"],
        "gpday":   lambda r: r["est_gp_d"],
    }.get(sort_by, lambda r: r["gross"])

    ordered = sorted(results, key=key, reverse=True)

    sep  = "─" * 118
    print(sep)
    print(f" {'Item':<26}  {'ID':>9}  {'Buy':>9}  {'Balmung':>9}"
          f"  {'NetProfit':>9}  {'Margin':>6}  {'DC Vel/d':>8}"
          f"  {'Est GP/d':>10}  {'Last Sale':>20}  {'Avg Sale':>10}")
    print(sep)

    for r in ordered[:n]:
        avg = f"{int(r['avg_sp']):,} gil" if r["avg_sp"] else "—"
        age_h = r.get("last_sale_age_h", 1e9)
        if age_h >= 1e8:
            last_str = "—"
        elif age_h < 1:
            last_str = f"{int(age_h*60)}m ago @ {int(r['last_sale_price']):,}g"
        elif age_h < 24:
            last_str = f"{age_h:,.1f}h ago @ {int(r['last_sale_price']):,}g"
        elif age_h < 168:
            last_str = f"{age_h/24:.1f}d ago @ {int(r['last_sale_price']):,}g"
        else:
            last_str = f"{age_h/24:,.0f}d ago @ {int(r['last_sale_price']):,}g"

        name = r.get("name", f"Item {r['id']}")
        print(f" {name:<26} {r['id']:>9}  {r['buy']:>9,} gil  {r['balmung']:>9,} gil"
              f"  {r['gross']:>9,} gil  {r['margin']:>5.1f}%"
              f"  {r['dc_vel']:>8.1f}  {r['est_gp_d']:>10,} gil  "
              f"{last_str:>20}  {avg:>10}")

    print(sep)
    print(f"Showing {min(n, len(results)):,} of {len(results):,} total.\n")


def _show_velocity(results: list[dict], n: int = 30) -> None:
    ordered = sorted(results, key=lambda r: r["dc_vel"], reverse=True)[:n]
    if not ordered:
        return
    print()
    print("═" * 86)
    print(f"  {'HIGHEST VELOCITY FLIPS':^84}")
    print("═" * 86)
    print(f"  {'Item':<26}  {'ID':>9}  {'Buy':>9}  {'Vel/d':>8}  {'Profit':>9}  {'Marg.':>6}")
    print("  " + "─" * 78)
    for r in ordered:
        age_h = r.get("last_sale_age_h", 1e9)
        if age_h >= 1e8 or not r.get("last_sale_price"):
            last_str = "—"
        elif age_h < 1:
            last_str = f"{int(age_h*60)}m @ {int(r['last_sale_price']):,}g"
        elif age_h < 24:
            last_str = f"{age_h:,.0f}h @ {int(r['last_sale_price']):,}g"
        else:
            last_str = f"{age_h/24:,.1f}d @ {int(r['last_sale_price']):,}g"
        name = r.get("name", f"Item {r['id']}")
        print(f"  {name:<26} {r['id']:>9}  {r['buy']:>9,} gil"
              f"  {r['dc_vel']:>8.1f}  {r['gross']:>9,} gil  {r['margin']:>5.1f}%  {last_str:>20}")
    print("═" * 86 + "\n")


def _save_csv(results: list[dict], path: str) -> None:
    fields = ["id","name","buy","dc_min","balmung","fees","gross",
              "margin","avg_sp","dc_vel","est_gp_d",
              "last_sale_age_h","last_sale_price","last_sale_qty"]
    with open(path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for r in sorted(results, key=lambda r: r["gross"], reverse=True):
            row = {k: r.get(k, "") for k in fields}
            row["last_sale_age_h"] = (
                f"{r['last_sale_age_h']:.1f}"
                if r.get("last_sale_age_h", 1e9) < 1e8 else ""
            )
            w.writerow(row)
    print(f"CSV → {path}\n")

# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(
        description="FFXIV Market Board Cross-World Flipper  (Crystal → Balmung)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__)
    ap.add_argument("--min-velocity",    type=float, default=5.0,
                    help="DC min daily sales velocity  (default: 5)")
    ap.add_argument("--min-profit",      type=int,   default=200,
                    help="Min net profit per unit gil (default: 200)")
    ap.add_argument("--min-margin-pct",  type=float, default=5.0,
                    help="Min profit margin %%          (default: 5.0)")
    ap.add_argument("--min-price-floor", type=int,   default=100,
                    help="Ignore items below this gil  (default: 100)")
    ap.add_argument("--max-price-floor", type=int,   default=None,
                    help="Ignore items above this gil  (default: no limit)")
    ap.add_argument("--max-sale-age-hours", type=float, default=None,
                    help="Ignore items last sold more than N hours ago (default: no limit)")
    ap.add_argument("--history-entries", type=int, default=5,
                    help="History depth to fetch per item (default: 5)")
    ap.add_argument("--workers",         type=int,   default=5,
                    help="Parallel API workers         (default: 5)")
    ap.add_argument("--sort-by",         choices=["profit","margin","velocity","gpday"],
                    default="profit")
    ap.add_argument("--top-n",           type=int,   default=50)
    ap.add_argument("--show-velocity",   action="store_true")
    ap.add_argument("--csv",             metavar="FILE")
    ap.add_argument("--quick",           action="store_true",
                    help="Relax all filters (scan full list)")
    args = ap.parse_args()

    if args.quick:
        args.min_velocity    = 0
        args.min_profit      = 0
        args.min_margin_pct  = 0
        args.min_price_floor = 0
        args.max_price_floor = None
        args.max_sale_age_hours = None

    world_map = fetch_world_map()
    dc_worlds = fetch_dc_worlds(DC_NAME)
    sell_id   = world_map.get(SELL_WORLD.lower())
    if not sell_id:
        sys.exit(f"ERROR: '{SELL_WORLD}' not found in world list.")

    print(f"\n🎯  Sell on   : {SELL_WORLD} (ID {sell_id})")
    print(f"🌐  Datacenter: {DC_NAME}  worlds: {', '.join(map(str, dc_worlds))}")

    item_list = fetch_marketable()
    print(f"📦  Marketable items: {len(item_list):,}\n")

    results = run_scan(
        item_ids           = item_list,
        sell_world_id      = sell_id,
        min_vel            = args.min_velocity,
        min_profit         = args.min_profit,
        min_pct            = args.min_margin_pct,
        price_floor        = args.min_price_floor,
        max_price_floor    = args.max_price_floor,
        max_sale_age_h     = args.max_sale_age_hours,
        history_entries    = args.history_entries,
        workers            = args.workers,
    )

    _show(results, args.top_n, args.sort_by)
    if args.show_velocity:
        _show_velocity(results)
    if args.csv:
        _save_csv(results, args.csv)


if __name__ == "__main__":
    main()
