# OptionAnalytics

A live NIFTY / BANKNIFTY dashboard backed by the Dhan market feed: a spot candlestick chart with
an EMA 9/21 crossover overlay, a CE/PE cumulative delta volume (CDV) chart for the near-the-money
option chain, and Telegram alerts on EMA crossovers.

Pick an underlying from the dropdown and the page shows a live-updating candlestick chart (with
EMA 9/EMA 21 lines and crossover markers) plus the current spot price, rounded to the nearest
strike step (50 for NIFTY, 100 for BANKNIFTY), right below it - and, underneath that, a CE/PE CDV
line chart for the 17-strike (8 ITM + ATM + 8 OTM) window around the current ATM strike.

## Architecture

- `OptionAnalytics.Server` - ASP.NET Core 8 Web API.
  - Downloads Dhan's scrip master to resolve NIFTY/BANKNIFTY's security ids and the surrounding
    option chain, backfills 1-minute candles over Dhan's Historical Data API (falling back to
    TimescaleDB first if today's bars are already stored - see below), then keeps a live
    WebSocket connection to Dhan's market feed (Quote mode) and folds every tick into the current
    bar for both the spot index and its ATM +/- 8 strikes' CE/PE option contracts.
  - CDV is a tick-rule-classified, sigmoid-moneyness-delta-weighted running total per side (see
    `CdvUnderlyingState`), re-centered on the ATM strike every 30 minutes as spot moves.
  - EMA9/EMA21 (via `Skender.Stock.Indicators`) is computed both client-side (for the chart
    overlay) and server-side (`EmaCrossoverAlertService`, reacting to each bar's close) - the
    server-side copy is what drives Telegram alerts, since those need to fire even with nobody
    looking at the page.
  - Pushes updates to the browser over SignalR (`/hubs/spot`, both `spotUpdate` and `cdvUpdate`
    events) and also serves them over REST (`/api/spot/...`, `/api/cdv/...`).
- `optionanalytics.client` - Vite + React frontend (antd + lightweight-charts).

## Dhan credentials

Two ways to authenticate - set whichever you have:

- **TOTP (fully automatic, recommended)**: set `Dhan:ClientId`, `Dhan:Pin`, `Dhan:TotpSecret`
  (the base32 seed from Dhan Web -> Profile -> DhanHQ Trading APIs -> Setup TOTP). The app mints
  and renews its own access token forever, with nothing further to do.
- **Static token**: set `Dhan:ClientId` and `Dhan:AccessToken` (a portal-generated token, valid
  ~24h - needs refreshing roughly once a day).

**Never commit real credentials.** Set them via environment variables, or - for local dev - in
`OptionAnalytics.Server/appsettings.Local.json`, which is gitignored and loaded automatically if
present:

```bash
export Dhan__ClientId="your-dhan-client-id"
export Dhan__Pin="your-pin"
export Dhan__TotpSecret="your-totp-seed"
```

## Telegram alerts (optional)

Set `Telegram:Enabled=true`, `Telegram:BotToken`, and `Telegram:ChatId` to get a Telegram message
on every EMA 9/21 crossover (bullish or bearish) for NIFTY or BANKNIFTY, the moment a 1-minute bar
closes. Leave `Telegram:Enabled=false` (the default) to skip this - the rest of the app is
unaffected either way.

## Candle storage (optional)

Set `CandleStorage:Enabled=true` and `CandleStorage:ConnectionString` to a Postgres/TimescaleDB
connection string to persist every closed 1-minute bar to a TimescaleDB hypertable. This is purely
an archive/restart-recovery optimization - the live chart and CDV both run entirely off in-memory
state either way, and every part of the app runs identically with storage left disabled (the
default). What it buys you:

- **Restart recovery**: on startup, today's already-seen bars are restored from the database
  (near-instant) instead of always re-fetching from Dhan's REST API.
- **A growing multi-day archive** for backtesting/analysis later - Dhan's own historical API only
  goes back so far, and doesn't cover the option contracts this app streams at all.

Run TimescaleDB locally with Docker:

```bash
docker compose up -d timescaledb
```

Then set:

```bash
export CandleStorage__Enabled=true
export CandleStorage__ConnectionString="Host=localhost;Port=5432;Database=optionanalytics;Username=optionanalytics;Password=localdevpassword"
```

(Override `TIMESCALEDB_PASSWORD` before `docker compose up` to use a different password.) The
`candles` hypertable and its indexes are created automatically on first use - no separate
migration step.

## Running locally

Backend (from `OptionAnalytics.Server/`):

```bash
dotnet run
```

Listens on `http://localhost:5080` by default (see `Properties/launchSettings.json`).

Frontend (from `optionanalytics.client/`, in a separate terminal):

```bash
npm install
npm run dev
```

Opens on `http://localhost:5173` and proxies `/api` and `/hubs` to the backend (see
`vite.config.js` - override the target with `BACKEND_URL` if the backend runs on a different
port).

## Production build

`dotnet publish` on `OptionAnalytics.Server` runs `npm install && npm run build` in the client
project and copies its output into `wwwroot`, so the published app serves the frontend itself -
no separate Node process needed in production.
