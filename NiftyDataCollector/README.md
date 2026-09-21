# NiftyDataCollector

A standalone .NET worker that polls Dhan for option-chain data (ATM ± N strikes, for the nearest
tracked expiry) - NIFTY and, once you add it, BANKNIFTY - and writes it into TimescaleDB. Runs
independently of OptionAnalytics.Server - no project reference, no shared runtime state - see "Why
duplicated Dhan code?" below.

**Tracking more than one index**: `Collector:Underlyings` in `appsettings.json` is a list; it ships
with just NIFTY so a first backfill run stays focused on one index. To add BANKNIFTY (or run it on
its own), add `{ "Name": "BANKNIFTY", "StrikeStep": 100 }` to that list (in `appsettings.json` or
your own `appsettings.Local.json`) and restart - each index gets its own full cycle every poll, and
each security's own backfill checkpoint (see below) means adding one later never disturbs the
other's already-saved data or progress.

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
   in `Dhan:ClientId` plus either or both of:

   - **Static portal token** (`Dhan:AccessToken`) - paste a token from Dhan Web -> Profile -> DhanHQ
     Trading APIs. **This is used first whenever it's set**, and left alone for as long as it keeps
     working. Simplest option on its own, but expires in ~24h with no auto-recovery - you'd need to
     paste a fresh one and restart about once a day.
   - **TOTP auto-login** (`Dhan:Pin` + `Dhan:TotpSecret`, from that same Profile page -> Setup TOTP)
     - the automatic **fallback**: `DhanTotpAutoRenewalHostedService` stands by and only starts
       minting/renewing its own token once `Dhan:AccessToken` is either left empty, or is confirmed
       dead (rejected by Dhan) - from that point on it keeps the session authenticated automatically
       forever, with zero manual steps, same tested logic (backoff, Dhan's 2-minute cooldown
       handling) as OptionAnalytics.Server's own TOTP auto-login. There's no reverse handover: once
       the static token is confirmed dead, TOTP stays in charge until you restart with a fresh one.
   - Set **both** for "paste a token when convenient, but don't worry if it expires unattended" -
     the collector runs on the static token as long as it's valid and falls over to TOTP the moment
     it isn't, with no restart needed. Set **TOTP only** (leave `Dhan:AccessToken` empty) for
     zero-touch operation from the start.

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
| `Underlyings` | `[{"Name":"NIFTY","StrikeStep":50}]` | Which indices to track, each with its own strike spacing - add `{"Name":"BANKNIFTY","StrikeStep":100}` to track it too (see above) |
| `StrikesEachSide` | 10 | ATM ± this many strikes |
| `TrackedExpiryCount` | 1 | How many of the nearest listed expiries to track |
| `BackfillDays` | 500 | How far back a NEW contract's (or spot's) OHLC history reaches (OI/IV are unaffected - see above) |
| `SnapshotPollIntervalSeconds` | 60 | How often to poll the live option chain |
| `HistoricalRefreshIntervalMinutes` | 5 | (reserved for a future incremental-refresh pass) |

## Backfilling 500 days: chunking and checkpoints

Dhan's intraday endpoint caps a single call at roughly 90 days, so a 500-day backfill for one
security is fetched as several chunked calls (`DhanHistoricalDataClient`), each its own rate-limited
request. Each chunk is **saved and checkpointed as soon as it succeeds** (in the `backfill_progress`
table - one row per security, holding the last date its own backfill has *contiguously* reached) -
deliberately not buffered until the whole 500-day range is done:

- A transient failure partway through (a rate limit, a dropped connection) stops that security's
  backfill for the cycle **without losing the chunks that already saved** - the checkpoint sits at
  the end of the last good chunk.
- The next cycle resumes from `checkpoint + 1`, not from day one - so a partial failure costs you a
  retry of the one chunk, never a re-run of the whole 500 days.
- **If you ever spot bad data in a specific window**: delete those rows from `spot_bars_1m` /
  `option_bars_1m`, then rewind that security's own checkpoint so the next cycle refills it -
  `UPDATE backfill_progress SET completed_through = '<day-before-the-bad-window>' WHERE security_id
  = <id>` (or `DELETE FROM backfill_progress WHERE security_id = <id>` to redo its entire
  `BackfillDays` window from scratch). No restart needed either way - the very next cycle picks up
  the change.

## Rate limiting

Centralized in `Dhan/DhanRateLimiter.cs` rather than scattered per-class delays:
- Option chain + expiry list: 3.5s between calls (Dhan's documented "one request every 3 seconds").
- Historical intraday: 200ms between calls (OptionAnalytics.Server's own production-validated
  pacing for the same endpoint, reused rather than guessed) - applied per CHUNK now, not just per
  contract, since a 500-day backfill means multiple chunked calls per contract (see above).

A full cycle for `StrikesEachSide=10` polls up to 42 contracts (21 strikes x CE/PE) per tracked
underlying. Once each contract's 500-day history is fully backfilled (a one-time cost, several
chunks per contract at 200ms apiece), ongoing cycles only fetch a single day's worth per contract
and comfortably fit inside the 60s default poll interval; the very first run - and any run that adds
a new index or contract - will take noticeably longer while that initial backfill catches up,
which is expected.

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
