# FFXIV Market Board Cross-World Flipper

Find items to buy cheap and relist for profit on any world. Uses [Universalis](https://universalis.app) crowd-sourced market data and [xivapi.com](https://xivapi.com) for item names.

Now rewritten in **JavaScript** with zero runtime dependencies — one shared engine powers the CLI, a full web scanner, and a targeted static scan page.

---

## Three ways to run

### 1. CLI (Node.js)

```bash
node src/cli.js --help
```

Zero dependencies — uses the native `fetch` built into Node 20+.

| Flag | Type | Default | What it does |
|---|---|---|---|
| `--sell-world` | str | `Balmung` | World to sell on |
| `--scope` | choice | `region` | Price scope: `region` (all NA) or `dc` (same datacenter only) |
| `--sort-by` | choice | `profit` | Sort results: `profit`, `margin`, `velocity`, `gpday`, `score` |
| `--top-n` | int | `50` | Rows to display |
| `--csv` | path | — | Export results to CSV |
| `--show-velocity` | flag | — | Print a separate table sorted by sales velocity |
| `--quick` | flag | — | Disable all filters, scan everything |
| `--min-price-floor` | int | `100` | Ignore items below this price |
| `--max-price-floor` | int | — | Ignore items above this price (troll filter) |
| `--min-velocity` | float | `5.0` | Min daily units sold on the DC |
| `--min-profit` | int | `200` | Min net profit per unit (gil) |
| `--min-margin-pct` | float | `5.0` | Min profit margin (%) |
| `--max-sale-age-hours` | float | — | Skip items last sold more than N hours ago |
| `--history-entries` | int | `5` | History rows per item |
| `--workers` | int | `5` | Parallel API requests |
| `-v, --verbose` | flag | — | Show batch count, scan progress |

#### Examples

```bash
node src/cli.js                                           # default scan
node src/cli.js --quick                                   # scan everything
node src/cli.js --sell-world Mateus --scope dc            # intra- datacenter, no DC travel
node src/cli.js --min-price-floor 500 --max-price-floor 500000  # mid-tier only
node src/cli.js --sort-by gpday --csv flips.csv --top-n 200     # daily revenue + CSV
node src/cli.js --quick --sort-by velocity --show-velocity -v   # fast scan w/ velocity
```

### 2. Web Scanner

A full-featured browser scanner with all the same filters, live progress, and a styled results table.

Open `web/index.html` in your browser (must be served over HTTP, not `file://`):

```bash
npx --yes http-server .     # then visit http://localhost:8080/web/
# or
python3 -m http.server 8080  # then visit http://localhost:8080/web/
```

**Features:**
- All filter controls from the CLI in a clean Tailwind UI
- ⚡ Quick Scan preset button
- Live progress bar and scan log
- Color-coded results table (green = good profit, red = low margin)
- CSV export directly from the browser

### 3. Static Targeted Scans

A pre-configured page that runs four targeted scans with strategy-specific settings, ideal for quickly surveying the market.

Open `static/index.html` in your browser (served over HTTP):

```
http://localhost:8080/static/
```

**Predefined scans:**

| Scan | Strategy | Key filters |
|---|---|---|
| 💰 High Profit | Premium items, large absolute profit | min-profit 1000, min-margin 10% |
| 📈 High Margin | Deeply underpriced, high % return | min-margin 25%, dc-scoped |
| ⚡ High Velocity | Fastest turnover, items that sell daily | min-velocity 10, min-profit 50 |
| 🏆 Daily Revenue | Best profit × velocity | min-profit 300, gpday sort |

Click **"Run All Scans"** to execute all four in sequence, or run them individually.

---

## Architecture

```
src/
  engine.js   ← Pure JS core: API calls, filtering, scoring (ES module)
  cli.js      ← Node CLI wrapper (imports engine, no deps)

web/
  index.html  ← Full scanner UI (Tailwind via CDN)
  app.js      ← Web UI logic (imports ../src/engine.js)

static/
  index.html  ← Targeted scan cards (Tailwind via CDN)
  app.js      ← Predefined scan runner (imports ../src/engine.js)
```

The **engine** (`src/engine.js`) contains all market-data logic and is shared by all three entry points:
- Uses native `fetch` (no `axios`/`node-fetch`)
- Uses `Promise`-based concurrency pool (no `p-limit` or worker pools)
- Exposes `runScan()`, `fetchMarketable()`, `fetchWorldMap()`, `fetchDcWorlds()`, `fetchItemNames()`, `processBatch()`

**Zero npm packages required.**

## How it works

1. Fetch all marketable item IDs from Universalis
2. Query `/aggregated/{world}/{ids}` in batches of 100 to get min-listing + velocity data
3. Apply filters: velocity threshold, price floor/ceiling, profit margin, recency
4. Fetch sale history to enrich candidates with last-sale info and compute confidence
5. Resolve item names via xivapi (v1 batch → v2 fallback)
6. Score = gross profit × DC velocity × confidence

## Deploy

All three modes are static — just serve the directory:

```bash
npx --yes http-server .    # CLI users: npm i -g or use npx
python3 -m http.server 8080
```

GitHub Pages works out of the box — no build step, no npm install.

---

*Original Python implementation (`market_flipper.py`) is preserved for reference.*
