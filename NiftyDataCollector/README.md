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
| `rolling_option_bars_1m` | `/charts/rollingoption` (opt-in - see below) | **Yes, including OI and IV** - a genuinely different endpoint from the other three; see its own section below |

**The "oi" open question (for `/charts/intraday` specifically)**: Dhan's docs for `/charts/intraday`
describe an optional `"oi": true` request field that returns an `open_interest` array. This
collector always sets it for option contracts. Dhan's own doc example shows all zeros, which
proves nothing either way - run this for real and check `option_bars_1m.open_interest` yourself.
This is a SEPARATE question from `/charts/rollingoption`'s own OI/IV history (see below), which
Dhan's docs describe unambiguously - the two endpoints are independent and this open question is
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
| `ExpiryCodes` | `[0, 1]` | Which "cycles out" to track - nearest 2 expiries by default |
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

**`expiryCode` caution**: Dhan's own docs don't spell out this field's exact semantics beyond "expiry
of the instrument" - the working assumption here (consistent with "cycles out" conventions
elsewhere in Dhan's API) is `0` = the currently-rolling nearest cycle, `1` = the one after that, and
so on; `RollingOption:ExpiryCodes` defaults to `[0, 1]` (nearest 2 expiries) per the user's own
spec. Worth spot-checking `expiryCode: 1`'s resolved values against a known date before trusting a
large backfill built on it, same "verify, don't just trust the docs" caution this project already
applies to `/charts/intraday`'s own "oi" flag.

## Rate limiting

Centralized in `Dhan/DhanRateLimiter.cs` rather than scattered per-class delays:
- Option chain + expiry list: 3.5s between calls (Dhan's documented "one request every 3 seconds").
- Historical intraday: 200ms between calls (OptionAnalytics.Server's own production-validated
  pacing for the same endpoint, reused rather than guessed) - applied per CHUNK now, not just per
  contract, since a long backfill means multiple chunked calls per contract (see above).
- Rolling option: 250ms between calls (Dhan's own documented "5 requests/second" cap for Data
  APIs, with margin).
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

`option_chain_snapshots` (live, IV/greeks/OI - one row per leg per poll):

| time | underlying | expiry | strike | option_type | last_price | implied_volatility | open_interest | delta | spot_price |
|---|---|---|---|---|---|---|---|---|---|
| 2026-09-21 10:32:00+05:30 | NIFTY | 2026-09-25 | 25650 | CE | 134.00 | 9.79 | 3786445 | 0.5387 | 25642.80 |

`option_bars_1m` (real history, OHLC + volume + maybe OI):

| time | underlying | expiry | strike | option_type | open | high | low | close | volume | open_interest |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-21 09:15:00+05:30 | NIFTY | 2026-09-25 | 25650 | CE | 138.20 | 140.00 | 137.50 | 139.10 | 42500 | *(TBD - see "oi" open question above)* |

`rolling_option_bars_1m` (real history, OHLC + volume + OI + IV, resolved strike included since it
can shift day to day as spot moves and expiries roll):

| time | underlying | expiry_flag | expiry_code | strike_offset | option_type | strike | spot_price | close | volume | open_interest | implied_volatility |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-21 09:15:00+05:30 | NIFTY | WEEK | 0 | ATM+3 | CE | 25800 | 25642.80 | 145.30 | 18900 | 2145300 | 10.12 |
