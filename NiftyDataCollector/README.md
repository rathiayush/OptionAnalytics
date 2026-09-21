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

**The "oi" open question**: Dhan's docs for `/charts/intraday` describe an optional `"oi": true`
request field that returns an `open_interest` array. This collector always sets it for option
contracts. Dhan's own doc example shows all zeros, which proves nothing either way - run this for
real and check `option_bars_1m.open_interest` yourself. If it comes back with real non-zero
history, that's a genuinely new capability (OptionAnalytics.Server's own OI-based strategy was
removed specifically because OI was believed to be live-only everywhere in Dhan's API).

## Setup

1. **Postgres/TimescaleDB**: nothing to create by hand - point `ConnectionStrings:Timescale` (step 2
   below) at whatever database name you want (it does not need to exist yet) and the collector
   creates it and applies `Db/Schema.sql` automatically on every startup (both steps are
   idempotent, so this is also just as safe to let run again on a database that already has
   everything). The connecting Postgres role needs `CREATEDB` privilege for this - the default
   `postgres` superuser role always has it.
2. **Dhan credentials**: copy `appsettings.Local.json.example` to `appsettings.Local.json` and fill
   in `Dhan:ClientId` plus ONE of:

   - **TOTP auto-login (no daily manual step)**: set `Dhan:Pin` + `Dhan:TotpSecret` (Dhan Web ->
     Profile -> DhanHQ Trading APIs -> Setup TOTP) and leave `Dhan:AccessToken` empty.
     `DhanTotpAutoRenewalHostedService` mints and renews its own token automatically forever -
     same tested logic (backoff, Dhan's 2-minute cooldown handling) as OptionAnalytics.Server's own
     TOTP auto-login.
   - **Static portal token**: paste a token from that same Profile page into `Dhan:AccessToken`
     and leave `Pin`/`TotpSecret` empty. Simpler, but expires in ~24h - you'll need to paste a
     fresh one and restart about once a day.

   **The real tradeoff between the two, if you're also running OptionAnalytics.Server against the
   same Dhan account**: TOTP mode here means TWO independent processes can each mint a fresh login
   against one account - a fresh login commonly invalidates whichever token the OTHER process is
   currently holding, which can silently break the live dashboard's own session (or vice versa).
   If both need to run at once against the same account, the static-token option above is the
   zero-risk choice; TOTP here is safe if only one of the two is ever running TOTP mode at a time
   (e.g. the dashboard uses a static token, or you don't run them concurrently).
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
2. **Independent auth lifecycle.** Both TOTP auto-login and a static token are supported here too
   (see `Dhan/DhanOptions.cs`), but as a completely separate login from OptionAnalytics.Server's
   own - see the Setup section above for the real tradeoff if both run TOTP mode against the same
   account at once.
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
