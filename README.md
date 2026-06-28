# FFXIV Market Board Cross-World Flipper

Find items to buy cheap and relist for profit on any world. Uses [Universalis](https://universalis.app) crowd-sourced market data and [xivapi.com](https://xivapi.com) for item names.

---

## Setup

```bash
pip install requests
python market_flipper.py --help
```

---

## All Flags at a Glance

| Flag | Type | Default | What it does |
|---|---|---|---|
| `--sell-world` | str | `Balmung` | World to sell on |
| `--scope` | choice | `region` | Price scope: `region` (all NA) or `dc` (same datacenter only) |
| `--sort-by` | choice | `profit` | Sort results: `profit`, `margin`, `velocity`, `gpday` |
| `--top-n` | int | `50` | Rows to display |
| `--csv` | path | — | Export results to CSV |
| `--show-velocity` | flag | — | Print a separate table sorted by sales velocity |
| `--quick` | flag | — | Disable all filters, scan everything |
| `--min-price-floor` | int | `100` | Ignore items below this price |
| `--max-price-floor` | int | — | Ignore items above this price (filters troll listings) |
| `--min-velocity` | float | `5.0` | Min daily units sold on the DC |
| `--min-profit` | int | `200` | Min net profit per unit (gil) |
| `--min-margin-pct` | float | `5.0` | Min profit margin (%) |
| `--max-sale-age-hours` | float | — | Skip items not sold in the last N hours |
| `--history-entries` | int | `5` | History rows to fetch per item (for recency display) |
| `--workers` | int | `5` | Parallel API requests |

---

## Where to Buy and Sell

The script queries one price snapshot per batch and extracts three prices:

| Field | Meaning |
|---|---|
| `world` | Cheapest on your sell world |
| `dc` | Cheapest on the same datacenter |
| `region` | Cheapest anywhere in North America |

A flip is profitable when the sell-world price exceeds the buy price plus fees (~13% for undercut + tax + retainer).

### `--scope region` vs `--scope dc`

| Scope | Buy price from | Travel required |
|---|---|---|
| `region` | Anywhere in NA | Maybe — different datacenter |
| `dc` | Same datacenter as sell world | No — just world-hopping |

Use `--scope dc` when you want to minimize travel and only flip within one datacenter.

---

## Filtering

### Price and velocity

These control which items make it into the results:

- **`--min-price-floor`** — drop junk items like Fire Shards (1 gil). Start at 100.
- **`--max-price-floor`** — kill absurd listings like someone pricing a sword at 50M. `500000` covers most legit gear.
- **`--min-velocity`** — only items that actually sell. 5/day is a solid default. Lower to 1 to see more.
- **`--min-profit`** — net profit floor after fees. 200 gil is minimum useful.
- **`--min-margin-pct`** — percentage floor. 5% avoids tiny-margin flips that get undercut instantly.

### Recency and history

- **`--max-sale-age-hours`** — reject items last sold more than N hours ago. `168` = one week. Stale markets have stale prices.
- **`--history-entries`** — how many history rows to pull (default: 5, only the most recent is displayed). Lower = faster.

---

## Sorting

`--sort-by` changes the primary order of the results table:

| Key | Best for |
|---|---|
| `profit` | Highest net profit per unit (default) |
| `margin` | Wildly underpriced items, regardless of price |
| `velocity` | Items that actually turn over — fastest flips |
| `gpday` | Estimated daily revenue (profit × velocity) — best for active market makers |

---

## Output

### Table columns

| Column | Meaning |
|---|---|
| `Item` | Item name (xivapi v1 batch + v2 fallback) |
| `ID` | Universalis item ID |
| `Buy` | Cheapest buy price on your chosen scope |
| `Balmung`/ Mateus etc | Cheapest on your sell world |
| `NetProfit` | `(Sell − 13% fees) − Buy` per unit |
| `Margin` | Net profit as a percentage of buy price |
| `DC Vel/d` | Units sold per day across the DC |
| `Est GP/d` | `NetProfit × DC Vel/d` — estimated daily revenue |
| `Last Sale` | Most recent sale: how long ago + price |
| `Avg Sale` | 4-day rolling average sale price on the DC |

### CSV fields

`id`, `name`, `buy`, `dc_min`, `balmung`, `fees`, `gross`, `margin`, `avg_sp`, `dc_vel`, `est_gp_d`, `last_sale_age_h`, `last_sale_price`, `last_sale_qty`

---

## Examples

### Default scan
Sensible filters, Balmung, cross-world NA.
```bash
python market_flipper.py
```

### Everything, nothing filtered
```bash
python market_flipper.py --quick
```

### Intra-datacenter flips to Mateus (no DC travel)
```bash
python market_flipper.py --sell-world Mateus --scope dc
```

### Mid-tier only (no 1-gil trash, no 50M troll listings)
```bash
python market_flipper.py \
  --min-price-floor 500 \
  --max-price-floor 500000
```

### Recently active, cross-world to Balmung
```bash
python market_flinger.py \
  --max-sale-age-hours 168 \
  --min-velocity 3 \
  --min-profit 500
```

### Sort by daily revenue, export to CSV
```bash
python market_flipper.py --sort-by gpday --csv flips.csv --top-n 200
```

### Fast scan with velocity ranking
```bash
python market_flinger.py --quick --sort-by velocity --show-velocity --workers 8
```

### Sell on Seraph, DC-scoped
```bash
python market_flipper.py --sell-world Seraph --scope dc --min-profit 500
```

### Sell on Faerie, only items that traded this week
```bash
python market_flipper.py --sell-world Faerie --scope dc --max-sale-age-hours 72
```

---

## Tips

- **Start with `--quick --sort-by gpday --show-velocity`** to see what's actually moving.
- **Use `--max-price-floor 500000`** to kill obvious troll listings.
- **Use `--max-sale-age-hours 168`** to skip dead markets — if nothing sold in a week, the price is probably wrong.
- **History depth vs speed**: `--history-entries 1` is fastest. More entries only matters for accuracy of the "last sale" display.
- **Rate limits**: The script backs off exponentially on 429s. Keep `--workers` ≤ 8 to stay friendly to Universalis.
