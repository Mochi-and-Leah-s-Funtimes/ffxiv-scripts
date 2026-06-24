# FFXIV Market Board Cross-World Flipper

Identifies profitable items to buy cheap on the Crystal DC and relist on Balmung using [Universalis](https://universalis.app) crowd-sourced market board data.

## Setup

```bash
pip install requests
python market_flipper.py --help
```

## Strategy

The script queries `aggregated/Balmung/{ids}` to get three prices in one call:
- **`region`** — cheapest anywhere in North America (your buy price)
- **`dc`** — cheapest on the Crystal DC
- **`world`** — cheapest on Balmung (your sell price)

A candidate must satisfy: **Balmung price > buy price + 13% fees**, and Balmung cannot already be the cheapest source.

## Fees (baked into every profit calc)

| Component | Rate |
|---|---|
| Undercut / market reduction | 3% |
| City GC tax (best case) | 1% |
| Retainer sales fee | 5% |
| **Total (conservative)** | **13%** |
| Total (minimum theoretical) | 9% |

## CLI Arguments

### Price & Velocity Filters

| Flag | Type | Default | Description |
|---|---|---|---|
| `--min-price-floor` | int | `100` | Ignore items cheaper than this (gil) |
| `--max-price-floor` | int | *none* | Ignore items more expensive than this (gil) — kills absurd 100M listings |
| `--min-velocity` | float | `5.0` | Minimum DC daily sales velocity (units/day) |
| `--min-profit` | int | `200` | Minimum net profit per unit (gil) |
| `--min-margin-pct` | float | `5.0` | Minimum profit margin (%) |

### History / Recency Filters

| Flag | Type | Default | Description |
|---|---|---|---|
| `--history-entries` | int | `5` | How many history rows to fetch per item |
| `--max-sale-age-hours` | float | *none* | Reject items last sold more than N hours ago |

History is fetched **only for candidates**, not all 16K marketable items. The script shows the most recent sale's price, quantity, and age in the output table and CSV.

### Output Controls

| Flag | Type | Default | Description |
|---|---|---|---|
| `--sort-by` | choice | `profit` | Sort key: `profit`, `margin`, `velocity`, `gpday` |
| `--top-n` | int | `50` | Number of rows to display |
| `--show-velocity` | flag | false | Print a separate table ranked by DC sales velocity |
| `--csv FILE` | str | *none* | Export results to a CSV file |

### Performance

| Flag | Type | Default | Description |
|---|---|---|---|
| `--workers` | int | `5` | Parallel API requests |
| `--quick` | flag | false | Set all filters to 0 / none (full unfiltered scan) |

## Examples

### Basic scan with sensible defaults
```bash
python market_flipper.py
```

### Full unfiltered scan
```bash
python market_flipper.py --quick
```

### Focus on mid-tier flips (rejects junk and whales)
```bash
python market_flipper.py \
  --min-price-floor 500 \
  --max-price-floor 500000
```

### Only recently-active items
```bash
python market_flipper.py \
  --max-sale-age-hours 168 \
  --min-velocity 3 \
  --min-profit 500
```

### Sort by estimated gil/day (profit × turnover)
```bash
python market_flipper.py --sort-by gpday --top-n 100
```

### Export to CSV with velocity ranking
```bash
python market_flipper.py \
  --sort-by profit \
  --show-velocity \
  --csv flips.csv \
  --top-n 200
```

### High-volume, fast scan
```bash
python market_flipper.py --workers 8 --quick
```

## Output Columns

| Column | Description |
|---|---|
| `Item ID` | Universalis item ID (lookup on xivapi.com) |
| `Buy` | Cheapest price anywhere in the region (excl. Balmung) |
| `Balmung` | Cheapest price on Balmung (your sell price) |
| `NetProfit` | `(Balmung − 13% fees) − Buy` per unit |
| `Margin` | Net profit as a percentage of buy price |
| `DC Vel/d` | Units sold per day across the Crystal DC |
| `Est GP/d` | `NetProfit × DC Vel/d` — estimated daily revenue |
| `Last Sale` | Most recent sale: age + price |
| `Avg Sale` | 4-day rolling average sale price on the DC |

## CSV Fields

`id`, `buy`, `dc_min`, `balmung`, `fees`, `gross`, `margin`, `avg_sp`,
`dc_vel`, `est_gp_d`, `last_sale_age_h`, `last_sale_price`, `last_sale_qty`

## Tips

- **Start with `--quick --sort-by gpday --show-velocity`** to surface what's actually moving.
- **Use `--max-price-floor 500000`** to filter out obvious troll/junk listings.
- **Use `--max-sale-age-hours 168`** to skip items that haven't traded in a week — stale markets are risky.
- **History depth vs speed**: `--history-entries 1` is fastest; `--history-entries 10` gives better recency accuracy but adds ~1–2s per batch of candidates.
- **Rate limits**: The script backs off exponentially on 429s. Keep `--workers` ≤ 8 to stay friendly to Universalis.
