# OptionAnalytics - notes for every session

## The strategy scanner is the most important part of the app

The Order Flow page's strategy scanner (`optionanalytics.client/src/strategyEngine.js`,
`StrategyScanner.jsx`, `scannerCore.js`, fed by `useDayOi.js`, `liveFeeds.js`, `orderFlowMath.js`, `profiles.js`, `suddenOi.js` and `dayRegime.js`) decides when a trade
is signalled, at what entry, stop-loss and target, how a trailing stop moves, when a trade exits and
what the paper / live option trade does. A mistake there costs real money.

After ANY change to those files (or to anything they read):

```
cd optionanalytics.client
npm test          # node --test: every strategy's scenarios, the outcome rules, no look-ahead
npm run lint
npx vite build
```

All must pass before committing. The SAME scanner also runs on the server for NIFTY, BANKNIFTY and SENSEX
(`optionanalytics.client/scanner-runner/`, bundled by `npm run build:runner`, started by the server's
`ScannerRunnerHostedService`): the page and the runner share `scannerCore.js` / `liveFeeds.js`, so a change
there changes both - `tests/scanner-core.test.mjs` and `tests/scanner-runner.test.mjs` cover them. The runner is
paper only: its "Runner" role cannot reach the live-trading API.

When adding or changing a strategy:

- add a scenario test in `optionanalytics.client/tests/` - it fires on its rules (LONG and SHORT where
  it trades both) and does NOT fire when each key condition is missing;
- update the strategy count in the tests (`STRATEGIES.length`) and check what the default Top 15
  alerts on (`topFifteen`, `priority`, the `DEFAULT_*` lists);
- keep `tests/audit.test.mjs` passing - it is the guard on the rules below.
- per-strategy filters (`STRATEGY_FILTERS`, the scanner's Filters button): a filter's DEFAULT must be
  the rule as written and tested (an untouched strategy behaves exactly as before); read them through
  `strategyFilters(id, input.filters?.[id])`, and test that loosening each one lets its case through;
- every strategy also has the TRADE filters (`TRADE_FILTERS`: sides, entry window, stop / target size, time stop,
  trailing stop), applied by `applyTradeFilter` - defaults change nothing. The strategy tuning (`strategyTuning.js`,
  `scanDay.js`, `scanner-runner/tune.mjs`, the Strategy tuning page) measures settings through the same function and
  the same day scan as the scanner; keep `tests/strategy-tuning.test.mjs` (tuning == scanner) passing;
- a strategy that measures as losing is RETIRED (`retired: true` in `STRATEGIES`), not deleted: it is
  not run, listed, alerted or scored (`ACTIVE_STRATEGIES`); tests can still run it with `includeRetired`.

### Rules the scanner must keep (checked by `tests/audit.test.mjs`)

- **No look-ahead.** A setup at clock T uses only what was known at T: completed minute bars, prints
  up to T, and OI / premiums / spot / futures of FINISHED minutes. OI-replay points are 1-minute bars
  stamped at their start but holding their close, so a replayed day's context is built with
  `buildOiContext(run, expiry, { live: false })` (points read at their minute's end); only today's live
  context (`live: true`, ticks folded into the running minute) reads the running minute.
- **Entry** = the futures price at the clock: the last tape print, else the last completed minute's
  close (`replayView` / `priceAt`) - never the last big print or volume-spike minute.
- **Outcome** (`simulateOutcome`): bars from the one starting at the entry (a bar already running at a
  mid-minute live entry is skipped); stop before target in the same bar; a bar opening beyond the stop
  fills at its open; target at the target; the trailing stop moves after each completed bar and only
  tightens; time stop and the 15:10 square-off at the bar's close; no entries after 14:45.
- **Option trades**: entry premium = the last finished minute's; their own Max SL / Target are checked
  from the first full minute after the entry, at the level; a SL / target / trail change applies to
  open trades only, FROM the minute it is made (`levelLog` on the position, `trailLog` for the futures
  signals' trailing SL; `optionStopTargetHit` / `simulateOutcome` follow them - what already passed is
  never rewritten and a trailing stop is never loosened by a change); paper trades are all sized by the current lots setting (live trades keep their quantity).

## Other rules

- OI Replay's TODAY comes from the server's memory, not Dhan, after one backfill per series per day: the live feed
  (`OiReplayLiveFeedService`) keeps every tracked index's option legs and near futures as 1-minute bars
  (`LiveOptionLegStore`, all day, page open or not), spot is the spot feed's own day (`SpotFeedHostedService`), and
  `OiReplayService` joins the one backfill (`TodayFetchShare`) to the feed's bars since (`MergeTodayLive`) - so
  switching index on the live page asks Dhan nothing. The page's Clear cache drops it (`refresh=true`).
  `TodayWarmupService` keeps every index ready before anyone switches: in market hours, every 5 minutes, it asks each
  index's live run and Order Flow backfill (Dhan once a day, memory after; a restart is ready again within one pass).
  The Order Flow page's live engines already run all three indices' near futures all day (`OrderFlowService`).
- Every PAST day of the Dhan Data API (intraday spot / futures / option candles, the rolling / expired-option chain - NIFTY,
  BANKNIFTY, SENSEX alike) is kept on disk by `DhanDataCache` (`Storage:DhanCachePath`, the persistent volume in
  docker-compose), ONE FILE PER INSTRUMENT AND DAY (`DhanDayWindow`): any window reads the days kept from disk and asks Dhan
  for the rest in one call - so a window running into today (the chart backfills) still keeps its past days. A day is kept
  when it is before today and Dhan sent a full session of it (its own timestamps - a thin option strike's untraded minutes
  come at a 0 price the parser drops, and still count, or BANKNIFTY's monthly strikes were never kept) or a later past day
  in the same answer (a holiday is then kept empty, a short session short); today, empty answers and a half LAST day go to
  Dhan again. Older whole-window files are still read for their exact request and split into days. The folder is held to
  `Storage:DhanCacheMaxGb` (10 GB): over it, the files read least recently go first (`TrimNow`). A new Dhan data call for
  past days goes through `DhanHistoricalDataService` / `DhanRollingOptionDataService` so it is cached too
  (`DhanDataCacheTests.cs`). `GET /api/oi-replay/{u}/run?forceFetch=true` (the OI Replay page's "Force fetch from Dhan" tick) skips the saved days -
  the cache's reads miss (`DhanDataCache.ForceRefreshScope`), the stored database and the in-memory futures are not used - and writes what Dhan sends over the cache.

- Never commit local-only auth bypasses, credentials or `appsettings.Local.json`; never change Dhan
  credentials. Don't run the real server against Dhan just to test - use the tests, `vite preview` with
  a mocked `/api`, or a local feeder.
- Live order placement only ever happens behind the explicit, confirmed "Auto-place on alert" switch in
  Live (Dhan) mode; alerts and the default auto trade are paper.
