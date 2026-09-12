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

Listens on `http://localhost:5080` by default (see `Properties/launchSettings.json`). Login works
out of the box using the credentials in `appsettings.json`'s `Auth` section - see [Login](#login).

Frontend (from `optionanalytics.client/`, in a separate terminal):

```bash
npm install
npm run dev
```

Opens on `http://localhost:5173` and proxies `/api` and `/hubs` to the backend (see
`vite.config.js` - override the target with `BACKEND_URL` if the backend runs on a different
port).

## Production build

`dotnet publish` on `OptionAnalytics.Server` runs `npm ci && npm run build` in the client project
and publishes its output as the app's `wwwroot`, so the published app serves the frontend itself -
no separate Node process needed in production.

`appsettings.Local.json` is deliberately excluded from both the build output and the publish output
(see the csproj), so a publish folder never carries local Dhan credentials. Production reads them
from environment variables instead - see below.

## Deploying

`Dockerfile` builds a single self-contained image (client + server), and `docker-compose.yml` runs
it. Nothing secret is committed: every credential comes from the environment.

```bash
docker compose up -d --build
```

Configuration, using ASP.NET Core's `__` section separator (`Dhan__ClientId` sets `Dhan:ClientId`):

| Variable | Required | Notes |
| --- | --- | --- |
| `DHAN_CLIENT_ID` | yes | Dhan client id |
| `DHAN_ACCESS_TOKEN` | either this... | A long-lived access token |
| `DHAN_PIN` + `DHAN_TOTP_SECRET` | ...or these | TOTP auto-login; the app then renews its own token |
| `TELEGRAM_ENABLED` | no | `true` to send trigger alerts |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | if enabled | |
| `AUTH_ADMIN_EMAIL` | no | Overrides the admin account's email (default `admin@backtest.com`) |
| `AUTH_USER_EMAIL` | no | Overrides the user account's email (default `user@backtest.com`) |
| `HTTP_PORT` | no | Host port, default `8080` |

The app listens on `8080` inside the container.

### Login

The whole app requires signing in - there is no anonymous access, and no self-service signup.
Exactly two accounts exist, both fixed by configuration (see `AuthOptions`/`AuthService`):

- **Admin** (`admin@backtest.com` by default) - sees every page, including Triggers (arms real
  Dhan orders) and Contracts (the raw scrip-master/subscription diagnostic).
- **User** (`user@backtest.com` by default) - sees Dashboard and Backtrack only; Triggers and
  Contracts are both hidden in the nav and rejected server-side (`403`) if requested directly.

Passwords are fixed in `OptionAnalytics.Server/appsettings.json`'s `Auth` section (not read from
the environment) - edit them there and redeploy to change them. Only the emails are overridable via
`AUTH_ADMIN_EMAIL`/`AUTH_USER_EMAIL` in Dokploy's Environment tab or a `.env` file next to
`docker-compose.yml`.

### Persistence

All market data is in memory and refetched from Dhan on every start, so the container is
effectively stateless - **except** for armed strategy triggers, which are configuration rather than
market data (see `StrategyTriggerStore`). Those live in a JSON file whose location is set by
`Storage__TriggersPath`; compose points it at the `optionanalytics-data` volume, so triggers survive
a redeploy. Without that volume they reset every deploy.

The login cookie's Data Protection key ring is persisted the same way (`Storage__DataProtectionKeysPath`,
also on the `optionanalytics-data` volume) - without it, every redeploy would generate a fresh key
ring and silently sign everyone out, regardless of the cookie's own 14-day expiry.

### Dokploy

Create an application pointed at this repository, choose the branch to deploy, and pick either
build type:

- **Dockerfile** - path `Dockerfile`, port `8080`.
- **Compose** - path `docker-compose.yml`.

Set the variables above in Dokploy's Environment tab (not in a committed file), attach a domain,
and deploy. Note the first start fetches 30 trading days of history for ~68 option contracts, so
give it a few minutes before the option charts fill in.

Startup is slower than a typical web app and the Dhan token endpoint is rate-limited to one call
every two minutes, so avoid redeploy loops that restart the container repeatedly.
