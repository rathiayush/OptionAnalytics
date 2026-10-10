# Handoff - where the work stands (9 Oct 2026)

Branch `feature/gocharting-and-strategy-tuning`. `main` = `0198554` (option-trade tuning + 3 option-chain strategies).
The date-range tuning (`7a3d6ee`) is on the feature branch and NOT merged: the trader merges only when they say "merge".
Checks before any commit (CLAUDE.md): `cd optionanalytics.client && npm test && npm run lint && npx vite build && npm run build:runner`,
and `dotnet test` in the repo root (one server test is rarely flaky, not reproduced in ~35 runs).

## Open work, in small parts (do one part per session; each ends green, committed, pushed, not merged)

### Part 1 - why BANKNIFTY / SENSEX show only ~4 strategies (the trader's question)
No code restricts strategies by index. The cause is thresholds / units that fit NIFTY only, or data BANKNIFTY / SENSEX lack.
Method (cheap): for ONE strategy at a time, take its scenario test in `optionanalytics.client/tests/` (strategies-core,
strategies-17-23, strategies-profile, strategy-16-weak-wall, strategy-24-squeeze, strategy-27-vwap-pullback), confirm it fires at NIFTY
scale, re-key it to BANKNIFTY (price x2.3 ~52,000, strike step 100, footprint row 5, TPO row 10, lot 30, BANKNIFTY has MONTHLY options
only - `liveFeeds.expiryFlagOf`) and SENSEX (x3.6 ~82,000, step 100, row 5, lot 20), and find the condition that stops it.
Known so far: `weakWall` (strategyEngine.js ~1099-1125) mixes % bands with strike steps: on SENSEX the spot must sit 23+ pts BELOW the
level; the probe in this session showed 15 setups at NIFTY scale, 17 BANKNIFTY, 5 SENSEX. Also check data: does the server have market
depth / heatmap for BSE SENSEX futures and for BANKNIFTY? Strategies needing the book / heatmap (`confirm()`, `liquiditySignals`,
`pullStackSignals`) go quiet without it. A fix must keep NIFTY's output IDENTICAL (scale a fixed number by price / NIFTY price, by step / 50,
by row size or by lot) and add a test that the strategy fires at BANKNIFTY and SENSEX scale.
Order suggested: weakWall, wallBreak, buildUp, then the rest.

Findings so far (read from the code, 9 Oct):
- SENSEX (BSE): Dhan's 20-level and 200-level depth are NSE-only, so SENSEX futures have only the Full packet's 5 book levels
  (`DhanDepthFeedClient`, `OrderFlowService`). The heatmap / liquidity / pull-stack signals and the 20-level `bookShare` are thin or absent
  there, so strategies that need them (`confirm()`, `liquiditySignals`, `pullStackSignals`: wallBreak, trap, cvdDivergence, the wall-absorption
  ones) fire far less on SENSEX. BANKNIFTY is NSE: by default `OrderFlow:MaxTwoHundredDepth` = 2 sockets, so NIFTY and BANKNIFTY get the
  200-level book - depth is NOT the BANKNIFTY cause.
- SENSEX OI / spot are live-only (NiftyDataCollector never stored SENSEX): past-day OI for SENSEX always calls Dhan (`OiReplayService`).
- BANKNIFTY options are MONTHLY only (`expiryFlagOf`); `indexScanner.load()` uses `expiries.month` for it - check the OI chain loaded is the
  monthly one, and that weekly-based assumptions (days to expiry, `isExpiryDay`, max pain) hold.
- `weakWall` mixes percent bands with strike steps (SENSEX needs the spot 23+ pts under the level; 5 setups vs 15 at NIFTY scale on the test day).
  Candidate fix keeping NIFTY identical: cap `pct(0.0006)` at ~0.35 x the strike step (NIFTY ~13.6 < 17.5 unchanged, BANKNIFTY 31 < 35 unchanged,
  SENSEX 49 -> 35). Needs the scaled scenario test first.
- STILL NEEDED to name the cause: what exactly the trader sees as "4" (which 4 strategies, on the page's list or on the server scanner's
  signals / alerts) - and whether profile strategies (vaRejection, tpo80, pocReaction, lvnRun, ibBreakout) are the missing ones: they need the
  previous session's bars (`fetchPreviousSession`), which are held in memory only ("Nothing is stored on disk" - OrderFlowService) so a restart
  or a BSE contract Dhan no longer lists leaves `profile` null and kills all five.

### Part 2 - two more strategies
Judge's inputs were not collected (workflow stopped to save limit). Ideas worth a scenario test each, spot + options engine
(`src/spotEngine.js`, ids spot*, registered in `SPOT_STRATEGIES` in strategyEngine.js):
 a) ATM straddle premium decay vs expansion (sold-straddle regime): ATM CE+PE premium below its session average and falling, CE and PE OI
    both rising at ATM -> range; fade the edges / sell premium.
 b) Writers migrating (the biggest CE or PE wall moves one strike toward the price over 15 min) with the price following.
Each: LONG and SHORT, fires on its rules, does not fire when each key condition is missing, scale-safe (percent / step / ATR), no look-ahead.

### Part 3 - strategies that never alert by default
`flush`, `range`, `maxPain`, `weakWall`, `vwapFade`, `ibFade` are active but not in the default Top 15 (they show in the list, no alert / paper
trade / Telegram until one wins). Fix = mark them `trial: true` like `vwapPullback` (alerted beside the 15). Also `weakWall` needs futures OI
(`f15.oiPct == null -> continue`, strategyEngine.js ~1116): on past days after a contract expires there is none - accept price direction alone.
`range` (#7) has no scenario test (CLAUDE.md requires one); `maxPain` (#10) has none and never runs on past days (isExpiryDay is false).
DONE on branch `claude/never-fire-fixes` (not merged): the six are `trial: true`; weakWall takes the futures price alone when there is
no futures OI; a replayed day knows it was an expiry (`wasExpiryDay`: its front-month futures expiry, or the weekly weekday agreed by
the listed weekly expiry and that month's futures expiry); scenario tests for #6, #7, #10, #12, #13, #14 (none fired in a test before).
Still open (data, not rules): #4 / #5 / #6 / #19 / #24 need futures OI (none on a past day after the contract expired); #11-#14 need
the previous session's profile (memory only); #27 needs the heatmap (thin on SENSEX's 5-level book).

### Part 4 - the rest of the "never fire" audit (16 strategies not yet audited) and the OI plan items not built
OI plan (in the earlier synthesis): richer `oiCtx` fields into the audit `sig`, a `keepVetoed` measurement of the options-OI veto, the
tuner honesty items (min days, day-clustered error, held-out final check), `openingBias` live-vs-replay mismatch, expiry calendar.

## Long tuning jobs and the Trades page (10 Oct) - built
- `scanner-runner/tuneFetch.mjs`: retries (429 / 5xx / timeouts / DH-904 / "not authenticated" while TOTP renews; 5 s x3 up to 6 tries,
  Retry-After honoured), a gzip disk cache of each PAST day's raw data (`{tuning}/cache/v1/...`, size-capped `StrategyTuning:CacheMaxMb`,
  least-recently-read pruned), `X-Request-Priority: background` in market hours (server: `DhanDataApiRateLimiter.BackgroundScope`, middleware
  in Program.cs - the job's Dhan calls use the background lane). `tune.mjs`: per-day checks (>= 300 of 375 minutes of bars / spot / option OI,
  else skipped with the reason), an incomplete OI day (a strike series failed for the load - `/run`'s new `optionErrors`) fetched again
  (30 s, 90 s) and never cached, busy days retried once at the end, every trade written to `{U}-trades-latest.json` (Trades page).
- Server: `OiReplayResult.OptionErrors` (a failed strike fetch is reported, not passed off as empty), intraday + rolling-option calls retry
  Dhan's rate limit (429 status too, 2/4/8 s), NSE contract-master / chart caches evict least-recently-used (was: the file just fetched)
  and a timeout is a plain failure (was: an unhandled 500, stuck in the cache). StrategyTuningService: `--max-old-space-size`
  (`StrategyTuning:MaxMemoryMb`, 4096), a job interrupted by a server stop is resumed after the restart (`current-job.json`,
  `StrategyTuningResumeHostedService`); the Stop button forgets it.
- Dhan limits (https://dhanhq.co/docs/v2/ - Data APIs 5/s and 100,000/day, no minute / hour cap; DH-904 / 805 = rate limit,
  805 warns of blocking): the server never sends over 5/s (a full queue waits), background work uses interactive permits nobody
  is waiting for (up to 5/s when the app is quiet), rate limits are retried after 1 / 2 / 4 s (job: 2 / 4 / 8 / 16 / 30 s; longer
  only for a renewing session / network), calls are counted per IST day (`/api/strategy-tuning/dhan-usage`) and a job stops before
  the last 10%. Possible next step (needs a check against real Dhan first): `/charts/rollingoption` serves up to 30 days a call -
  one call per strike per expiry cycle instead of per day; `expiryCode` counts from fromDate, so only within one cycle, and the
  expiry day itself may differ from today's per-day call.
- Data limits that remain (not code): the server keeps only the last 3 recorded order-flow days in memory, so a long futures run uses
  estimated days (1-minute candles, no tape / depth); estimated futures older than ~2.5 months need NSE's chart service (blocked from
  some hosting IPs) - those days are skipped with the reason; SENSEX futures only for the current contract. Spot + options mode needs
  no futures and covers the whole range. Ideas: persist recorded order-flow days to disk; reuse `ExpiredOptionDataStore` for `/run`.
- SPEED (10 Oct). Measured on 120 days: tuning one strategy's trade settings took 53-97 s; the 7,200 combinations hold
  only 400 different answers (sides / window / OI pick WHICH setups are taken, never what a taken one does), so an
  outcome cache keyed by `outcomeKey` (stop, target, time stop, trail) + walking combinations in that order gives
  ~4.4x (13.5 / 22 s). Each combination keeps its place (`at`) so ties still resolve as before; old vs new compared
  over 32 runs, identical. Limiter: background work uses the whole 5/s while nothing interactive asked in the last 5 s,
  else leaves one permit free. The job scans `TUNE_DAYS_AT_ONCE` (3) days at once, shares identical in-flight fetches
  and writes cache files under a unique temp name.
- OPTION CHAIN A CYCLE AT A TIME (10 Oct): `GET /api/oi-replay/{U}/range?from&to` returns each day in the same shape
  as `/run`, fetched one Dhan call per strike per EXPIRY CYCLE (windows never cross an expiry; the expiry day itself
  stays per-day). `GET .../range-check?date=` fetches one day BOTH ways and compares every OI point. `/run` is
  unchanged (`viaRange=true` is opt-in). Off switch `StrategyTuning:FastOiRange`. The job (`prefetchOi` in tune.mjs)
  runs range-check on a day of ITS OWN plan first and only then prefetches, putting each healthy day into the same
  disk cache the per-day path reads (`fetcher.putDay`) - so any day not seeded is simply fetched the old way.
  `TUNE_FAST_OI=off`, `TUNE_RANGE_DAYS` (7). NOT verified against real Dhan: that a multi-day window returns the same
  per-minute values as a single-day call (that is what range-check is for), per-day ATM+-K resolution inside a window,
  holiday-shifted expiries, multi-day futures `oi:true`.
- Fine-tune HISTORY, CSV only (10 Oct): every run is kept under `{tuning}/history/` - `runs.csv` (a row per run),
  `{run_id}-trades.csv` and `{run_id}-settings.csv` (`scanner-runner/tuneHistory.mjs`; run_id = `{INDEX}-{data}-{yyyyMMdd-HHmmss}` IST).
  A run is never overwritten, so a strategy can be compared run by run; the Trades page lists the runs, defaults to the newest
  per index and clubs the picked runs' trades (any index) by date then time, with a "Tuned settings" view of each run's
  parameters and scores. Server: `HistoryRuns` / `HistoryRows` / `HistoryPath` (a run id from the URL is checked against a
  pattern AND must exist - no path escapes), `PruneHistory` keeps `StrategyTuning:HistoryRuns` (100). The old
  `{U}-trades-latest.json` is gone.
- Trades page (`/trades`, `TradesPage.jsx`): the latest tuning run's trades (every strategy as written on every day, with why it fired;
  the tuned ones' best setting) and the scanner's record (`/api/scanner-log/rows/{kind}`: signals and live / paper option trades, page and
  server), filters, totals, CSV.

## Security - needs the trader
`NiftyDataCollector/appsettings.json` is tracked in git with a Dhan PIN, a TOTP secret and a database password. Rotate the PIN / TOTP /
password yourself, then remove the file from the repo (move the values to an ignored `appsettings.Local.json`). Never commit credentials.

## Where things are
- Strategy tuning: `src/strategyTuning.js`, `scanner-runner/tune.mjs`, `src/StrategyTuningPage.jsx`, server `StrategyTuning{Controller,Service}.cs`.
- Spot + options strategies: `src/spotEngine.js`; tests `tests/spot-strategies*.test.mjs`; option-trade tuning `tests/option-tuning.test.mjs`.
- OI filters: `TRADE_FILTERS`, `oiGatePasses`, `oiCtx` in `src/strategyEngine.js`; tests `tests/oi-confirmation.test.mjs`, `oi-hygiene.test.mjs`.
