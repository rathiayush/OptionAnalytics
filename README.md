# OptionAnalytics

A live NIFTY / BANKNIFTY spot price chart, backed by the Dhan market feed.

Pick an underlying from the dropdown and the page shows a live-updating candlestick chart plus
the current spot price, rounded to the nearest strike step (50 for NIFTY, 100 for BANKNIFTY),
right below it.

## Architecture

- `OptionAnalytics.Server` - ASP.NET Core 8 Web API. Downloads Dhan's scrip master to resolve
  NIFTY/BANKNIFTY's security ids, backfills today's (or the last trading day's) 1-minute candles
  over Dhan's Historical Data API, then keeps a live WebSocket connection to Dhan's market feed
  and folds every tick into the current bar. Pushes updates to the browser over SignalR
  (`/hubs/spot`) and also serves them over REST (`/api/spot/...`).
- `optionanalytics.client` - Vite + React frontend (antd + lightweight-charts).

## Dhan credentials

Set `Dhan:ClientId` and `Dhan:AccessToken` (a portal-generated access token from Dhan Web ->
Profile -> DhanHQ Trading APIs - these are the same two values used by other Dhan-integrated apps,
so an already-working pair can be reused here). **Never commit real credentials** - set them via
environment variables instead of editing `appsettings.json` directly:

```bash
export Dhan__ClientId="your-dhan-client-id"
export Dhan__AccessToken="your-dhan-access-token"
```

(Portal tokens are valid 24 hours, so this needs refreshing roughly once a day.)

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
