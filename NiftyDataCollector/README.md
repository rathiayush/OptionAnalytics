# NiftyDataCollector

A standalone .NET worker that backfills real historical option data (ATM ± N strikes, for the
nearest tracked expiry) - NIFTY and, once you add it, BANKNIFTY - into TimescaleDB. No live/current-
instant data is ever stored (see "No live data" below); it also polls Dhan's live option chain, but
only to discover which strikes/contracts to pull real history for, never to persist that live
response itself. Runs independently of OptionAnalytics.Server - no project reference, no shared
runtime state - see "Why duplicated Dhan code?" below.

**Tracking more than one index**: `Collector:Underlyings` in `appsettings.json` is a list; it ships
with just NIFTY so a first backfill run stays focused on one index. To add BANKNIFTY (or run it on
its own), add `{ "Name": "BANKNIFTY", "StrikeStep": 100 }` to that list (in `appsettings.json` or
your own `appsettings.Local.json`) and restart - each index gets its own full cycle every poll, and
each security's own backfill checkpoint (see below) means adding one later never disturbs the
other's already-saved data or progress.

## What it collects, and why different tables

This collector does NOT store live data - every table here is real, replayable history, never a
live/current-instant snapshot (see "No live data" below for what that ruled out and why):

| Table | Source | Real history? |
|---|---|---|
| `spot_bars_1m` | `/charts/intraday` (INDEX) | Yes - backfillable for any past window Dhan still serves |
| `option_bars_1m` | `/charts/intraday` (OPTIDX) | Yes - OHLC + volume, and possibly `open_interest` (see below) - only for expiries the collector was tracking (see below - the LIVE option chain is still used server-side to compute ATM/discover strikes, that response just isn't persisted) |
| `rolling_option_bars_1m` | `/charts/rollingoption` (opt-in - see below) | **Yes, including OI and IV**, for ANY past date within the last 5 years - a genuinely different endpoint from the other two; see its own section below |

## No live data

Per explicit request, this collector never persists a live/current-instant snapshot - every row in
every table above is real historical OHLC (or, for `rolling_option_bars_1m`, real historical
OI/IV too), never "whatever Dhan reported at the moment we happened to be polling." One real
consequence: **greeks (delta/theta/gamma/vega) are not collected at all** - Dhan's ONLY source for
them was ever the live option chain, and there's no history-preserving way to store them without
reintroducing a live snapshot; this project isn't doing that.

**Why `option_bars_1m` can go empty for an already-expired week**: this table's contracts are
discovered from Dhan's LIVE option chain (`/optionchain`, which only ever lists currently
listed/future expiries) - it has no way to discover a contract whose expiry has already passed,
since Dhan's own live endpoint stops listing it. So `option_bars_1m` can only ever hold data for an
expiry the collector was ALREADY tracking (`Collector:TrackedExpiryCount`) *before* it expired. If
you want a specific week's data after that week has already passed (e.g. last week's expiry), the
ONLY path is `rolling_option_bars_1m` (see below) - it resolves ATM strikes server-side for any
past date regardless of whether a contract is still live, which is exactly what a rolling/expired
options endpoint is for.

**The "oi" open question (for `/charts/intraday` specifically)**: Dhan's docs for `/charts/intraday`
describe an optional `"oi": true` request field that returns an `open_interest` array. This
collector always sets it for option contracts. Dhan's own doc example shows all zeros, which
proves nothing either way - run this for real and check `option_bars_1m.open_interest` yourself.
This is a SEPARATE question from `/charts/rollingoption`'s own OI/IV history (see below), which
Dhan's docs describe unambiguously - the two endpoints are independent, and this open question is
scoped to `/charts/intraday` only.

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

## Configuration (`RollingOption` section)

See "Rolling Options" below for what this feature is and the recommended rollout workflow.

| Key | Default | Meaning |
|---|---|---|
| `Enabled` | `false` | Turn on to start the rolling-option backfill |
| `StartDate` | last 30 days | How far back to backfill - widen this later (e.g. `"2023-03-01"`) once a small test run looks right |
| `ExpiryFlag` | `"WEEK"` | `"WEEK"` or `"MONTH"` - which expiry cycle to roll across |
| `ExpiryCodes` | `[1, 2]` | Which "cycles out" to track (1-indexed: 1 = nearest, 2 = next) - nearest 2 expiries by default |
| `PollIntervalMinutes` | 60 | How often to re-sweep every series once the initial catch-up finishes |

## Backfilling long ranges: chunking and checkpoints

Dhan's intraday endpoint caps a single call at roughly 90 days (30 for `/charts/rollingoption` -
see below), so a long backfill for one series is fetched as several chunked calls, each its own
rate-limited request. Each chunk is **saved and checkpointed as soon as it succeeds** (in the
`backfill_progress` table - one row per series, holding the contiguous `[completed_from,
completed_through]` window it currently covers) - deliberately not buffered until the whole range
is done:

- A transient failure partway through (a rate limit, a dropped connection) stops that series'
  backfill for the pass **without losing the chunks that already saved** - `completed_through`
  sits at the end of the last good chunk.
- The next pass resumes from `completed_through + 1`, not from day one - so a partial failure costs
  you a retry of the one chunk, never a re-run of the whole range.
- **Widening a range later** (raising `BackfillDays`, or moving `RollingOption:StartDate` further
  back, after an earlier smaller-range run already completed) is picked up automatically as a
  BACKWARD extension: the next pass fetches from the new, earlier start up to the old
  `completed_from - 1` and, only once that whole extension succeeds end to end, moves
  `completed_from` back to match - it never disturbs or re-fetches what was already covered. A
  failed backward extension leaves `completed_from` untouched and simply retries the full
  extension again next pass (safe to retry - upserts make redoing an already-saved chunk a no-op).
- **If you ever spot bad data in a specific window**: delete those rows from the bars table, then
  adjust that series' own checkpoint so the next pass refills it - e.g.
  `UPDATE backfill_progress SET completed_through = '<day-before-the-bad-window>' WHERE series_key
  = '<key>'` (or `DELETE FROM backfill_progress WHERE series_key = '<key>'` to redo its entire
  range from scratch). No restart needed either way - the very next pass picks up the change.

### Watching progress without writing SQL: `backfill_progress.csv`

Every successful checkpoint write also refreshes a plain CSV, `backfill_progress.csv`, sitting next
to the running `.exe` (`AppContext.BaseDirectory` - e.g.
`NiftyDataCollector/bin/Debug/net8.0/backfill_progress.csv`). One row per series:

| Column | Meaning |
|---|---|
| `series_key` | A security id (spot/option contract) or a `ROLLING:...` key |
| `underlying` | NIFTY, BANKNIFTY, etc. |
| `completed_from` / `completed_through` | The contiguous window this series currently covers |
| `completed_through_days_behind` | `today - completed_through` - **0 or 1 means current; a large or growing number means that series is stuck** |
| `updated_at_utc` | Last time this series' checkpoint actually advanced |

Open it in Excel (or just re-open/refresh the tab) any time to see, at a glance, exactly which
series are current and which need attention - if `completed_through_days_behind` isn't shrinking
for a series across several checks, look in the console log for that series' own key (e.g. `grep
"ROLLING:NIFTY:WEEK:1:ATM+3:CE"`) for the actual error, fix it if needed, and restart - everything
resumes from its own last-good checkpoint automatically, nothing is lost.

If the file is open in Excel when an update tries to land, that one update is skipped (logged as a
warning, not a crash) and simply retried on the next successful checkpoint - close and reopen the
file to see the latest state.

## Rolling Options: multi-year ATM±N backtesting data

`RollingOptionBackfillHostedService` backfills Dhan's separate "Rolling Options" API
(`POST /charts/rollingoption`, see `Dhan/DhanRollingOptionClient.cs`'s own doc comment for full
detail) into `rolling_option_bars_1m`. This is genuinely different from everything else this
collector does: instead of naming one fixed contract, you name a RULE - "the `{ExpiryCode}`-th
`{ExpiryFlag}` cycle's `ATM±N` strike" - and Dhan resolves that rule fresh for every day in the
range, stitching together whichever actual contract matched each day into one continuous series.
That's what makes a multi-year "always the nearest weekly ATM+3 CE" backtest possible without
manually enumerating years of past expiries - and, notably, this endpoint's response includes real
historical `open_interest` and `implied_volatility`, unlike the live-only OI/IV elsewhere in this
project (see the "oi" open question above - that's a different endpoint's open question, not this
one's).

**Off by default** (`RollingOption:Enabled: false`) - a full multi-year backfill is genuinely a lot
of Dhan API calls (`StrikesEachSide=10` means 21 relative strikes x 2 legs = 42 series per
underlying per expiry code, each needing several 30-day chunks per year of history). Recommended
workflow, matching how this was actually rolled out:

1. Turn it on with the default `RollingOption:StartDate` (last 30 days) and let it run - a quick,
   cheap way to confirm the resolved `strike`/`spot`/`open_interest`/`implied_volatility` values
   coming back actually look right for your account before committing to a much bigger range.
2. Once confirmed, widen `RollingOption:StartDate` in `appsettings.Local.json` (e.g. `"2023-03-01"`)
   and restart - the existing 30-day window's data and checkpoint are untouched; the wider range is
   picked up as a checkpointed BACKWARD extension (see "Backfilling long ranges" above).

**`expiryCode` is 1-indexed** - confirmed against a real account: `1` is the currently-rolling
nearest cycle, `2` the one after that, and so on. **`0` is NOT valid** - Dhan's API rejects it
outright with `Input_Exception: expiryCode is required` (a literal `0` is treated the same as
omitting the field, not as "cycle zero"). `RollingOption:ExpiryCodes` defaults to `[1, 2]` (nearest
2 expiries) per the user's own spec.

## Rate limiting

Centralized in `Dhan/DhanRateLimiter.cs` rather than scattered per-class delays:
- Option chain + expiry list: 3.5s between calls (Dhan's documented "one request every 3 seconds").
- Historical intraday: 200ms between calls (OptionAnalytics.Server's own production-validated
  pacing for the same endpoint, reused rather than guessed) - applied per CHUNK now, not just per
  contract, since a long backfill means multiple chunked calls per contract (see above).
- Rolling option: 250ms between calls (Dhan's own documented "5 requests/second" cap for Data
  APIs, with margin).
- **`Dhan:GlobalCallSpacingMilliseconds` (default 300ms) - a minimum gap between LITERALLY EVERY
  Dhan call, across all endpoints combined**, on top of the per-endpoint spacing above. Added
  after hitting a real `Rate_Limit: Too many requests on server from single user breaching rate
  limits.` error running the option-bars backfill and the rolling-option backfill at the same
  time - each was individually within its own budget, but Dhan's limit turned out to be PER
  ACCOUNT, not per endpoint, so their combined rate (up to ~9 req/s) burst past what a single
  account is allowed. If you still see `Rate_Limit` errors with multiple backfills running
  together, raise this further; if you confirm your account tolerates faster, you can lower it.
- **Daily budget, across ALL of the above combined**: Dhan's own documented cap is 7,000
  requests/day for Data APIs; `DhanApiClient` tracks a sliding 24h count of every Dhan call this
  process makes and PAUSES (never drops) once within margin of that ceiling, logging clearly -
  relevant mainly if `RollingOption` is enabled with a wide date range, since that can genuinely
  run into the thousands of calls.

A full cycle for `StrikesEachSide=10` polls up to 42 contracts (21 strikes x CE/PE) per tracked
underlying. Once each contract's history is fully backfilled (a one-time cost, several chunks per
contract at 200ms apiece), ongoing cycles only fetch a single day's worth per contract and
comfortably fit inside the 60s default poll interval; the very first run - and any run that adds a
new index, contract, or widens a backfill range - will take noticeably longer while that catch-up
runs, which is expected.

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

`option_bars_1m` (real history, OHLC + volume + maybe OI):

| time | underlying | expiry | strike | option_type | open | high | low | close | volume | open_interest |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-21 09:15:00+05:30 | NIFTY | 2026-09-25 | 25650 | CE | 138.20 | 140.00 | 137.50 | 139.10 | 42500 | *(TBD - see "oi" open question above)* |

`rolling_option_bars_1m` (real history, OHLC + volume + OI + IV, resolved strike included since it
can shift day to day as spot moves and expiries roll):

| time | underlying | expiry_flag | expiry_code | strike_offset | option_type | strike | spot_price | close | volume | open_interest | implied_volatility |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-21 09:15:00+05:30 | NIFTY | WEEK | 0 | ATM+3 | CE | 25800 | 25642.80 | 145.30 | 18900 | 2145300 | 10.12 |
