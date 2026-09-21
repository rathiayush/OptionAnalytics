# NiftyDataCollector

A standalone .NET worker that polls Dhan for NIFTY option-chain data (ATM ± N strikes, for the
nearest tracked expiry) and writes it into TimescaleDB. Runs independently of OptionAnalytics.Server
- no project reference, no shared runtime state - see "Why duplicated Dhan code?" below.

## What it collects, and why two different tables

Dhan's API genuinely offers two different shapes of data, and this schema keeps them honestly
separate rather than pretending one is the other:

| Table | Source | Real history? |
|---|---|---|
| `spot_bars_1m` | `/charts/intraday` (INDEX) | Yes - backfillable for any past window Dhan still serves |
| `option_bars_1m` | `/charts/intraday` (OPTIDX) | Yes - OHLC + volume, and possibly `open_interest` (see below) |
| `option_chain_snapshots` | `/optionchain` (live only) | **No** - `implied_volatility` and the greeks have no history anywhere in Dhan's API; this table only ever has data from whenever the collector was actually running |
| `dhan_raw_responses` | every call above | The EXACT response body, verbatim, plus the exact request that produced it |

**Everything Dhan returns, not just what's in the structured columns above**: every single Dhan
call this collector makes - the expiry list, each option-chain poll, each historical bars fetch -
also gets its complete, untouched response body archived into `dhan_raw_responses` (a JSONB
column), append-only, alongside the request that produced it. The structured tables are a
convenience view for querying; this table is the source of truth if a field ever turns out to be
missing from them, or Dhan adds a new one your running collector predates - which matters far more
for `option_chain_snapshots` than anywhere else, since a missed live IV/OI/greeks instant can never
be re-fetched from Dhan afterward. Query it with plain Postgres JSON operators, e.g.:
`SELECT response_json -> 'data' -> 'oc' FROM dhan_raw_responses WHERE endpoint = 'optionchain' ORDER BY time DESC LIMIT 1;`

**The "oi" open question**: Dhan's docs for `/charts/intraday` describe an optional `"oi": true`
request field that returns an `open_interest` array. This collector always sets it for option
contracts. Dhan's own doc example shows all zeros, which proves nothing either way - run this for
real and check `option_bars_1m.open_interest` yourself. If it comes back with real non-zero
history, that's a genuinely new capability (OptionAnalytics.Server's own OI-based strategy was
removed specifically because OI was believed to be live-only everywhere in Dhan's API).

## Setup

1. **Postgres/TimescaleDB**: create a database and run `Db/Schema.sql` against it - or just start
   the collector once with a valid connection string; it applies the schema automatically on every
   startup (every statement is idempotent).
2. **Dhan credentials**: copy `appsettings.Local.json.example` to `appsettings.Local.json` and fill
   in `Dhan:ClientId` / `Dhan:AccessToken` and `ConnectionStrings:Timescale`.

   **Use a static portal token here (Dhan Web -> Profile -> DhanHQ Trading APIs), not
   Pin/TotpSecret** - even though this collector is meant to "share the session" with the main
   OptionAnalytics dashboard, it must never independently log in against the same Dhan account. If
   the dashboard is running in TOTP auto-renewal mode, generate a SEPARATE static token for this
   collector instead of reusing Pin/TotpSecret - a second independent login commonly invalidates
   whichever token the other process is currently holding, which would silently break the live
   dashboard. If the dashboard already uses a static `Dhan:AccessToken` (not TOTP), you can safely
   paste that exact same value here.

   Portal tokens are valid ~24h, so you'll need to refresh this file's `AccessToken` about once a
   day for continuous running.
3. Run it: `dotnet run --project NiftyDataCollector`

## Configuration (`Collector` section)

| Key | Default | Meaning |
|---|---|---|
| `StrikeStep` | 50 | NIFTY's strike spacing |
| `StrikesEachSide` | 10 | ATM ± this many strikes |
| `TrackedExpiryCount` | 1 | How many of the nearest listed expiries to track |
| `BackfillDays` | 5 | How far back a NEW contract's OHLC history reaches (OI/IV are unaffected - see above) |
| `SnapshotPollIntervalSeconds` | 60 | How often to poll the live option chain |
| `HistoricalRefreshIntervalMinutes` | 5 | (reserved for a future incremental-refresh pass) |

## Rate limiting

Centralized in `Dhan/DhanRateLimiter.cs` rather than scattered per-class delays:
- Option chain + expiry list: 3.5s between calls (Dhan's documented "one request every 3 seconds").
- Historical intraday: 200ms between calls (OptionAnalytics.Server's own production-validated
  pacing for the same endpoint, reused rather than guessed).

A full cycle for `StrikesEachSide=10` fetches history for up to 42 contracts (21 strikes x CE/PE) -
at 200ms spacing that's under 9 seconds, well inside the 60s default poll interval.

## Why duplicated Dhan code, instead of referencing OptionAnalytics.Server?

Three reasons, in order of importance:
1. **Zero risk to the live dashboard.** This project has no build or runtime dependency on
   OptionAnalytics.Server at all - a bug here cannot break the other, and vice versa.
2. **Different auth model.** OptionAnalytics.Server supports TOTP auto-login; this collector
   deliberately does not (see `Dhan/DhanOptions.cs`), since two independent logins against one
   Dhan account can invalidate each other.
3. **Precedent already set by this codebase.** OptionAnalytics.Server itself was originally ported
   from a sibling project (LiveSpreadCalculator) the same way - copied and trimmed, not shared via
   a library.

## Example row (once real data lands)

`option_chain_snapshots` (live, IV/greeks/OI - one row per leg per poll):

| time | underlying | expiry | strike | option_type | last_price | implied_volatility | open_interest | delta | spot_price |
|---|---|---|---|---|---|---|---|---|---|
| 2026-09-21 10:32:00+05:30 | NIFTY | 2026-09-25 | 25650 | CE | 134.00 | 9.79 | 3786445 | 0.5387 | 25642.80 |

`option_bars_1m` (real history, OHLC + volume + maybe OI):

| time | underlying | expiry | strike | option_type | open | high | low | close | volume | open_interest |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-21 09:15:00+05:30 | NIFTY | 2026-09-25 | 25650 | CE | 138.20 | 140.00 | 137.50 | 139.10 | 42500 | *(TBD - see "oi" open question above)* |
