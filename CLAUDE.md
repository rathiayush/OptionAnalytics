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
  docker-compose), ONE GZIP JSON FILE PER INSTRUMENT AND DAY (`DhanDayWindow`; gzip only - no CSV): any window reads the
  days kept from disk and asks Dhan for the rest in one call - so a window running into today (the chart backfills) still keeps its past days. A day is kept
  when it is before today and Dhan sent a full session of it (its own timestamps - a thin option strike's untraded minutes
  come at a 0 price the parser drops, and still count, or BANKNIFTY's monthly strikes were never kept) or a later past day
  in the same answer (a holiday is then kept empty, a short session short); today, empty answers and a half LAST day go to
  Dhan again. Older whole-window files are still read for their exact request and split into days. The folder is held to
  `Storage:DhanCacheMaxGb` (10 GB): over it, the files read least recently go first (`TrimNow`). Whether it works is shown: OI Replay's load panel counts the days "saved to disk"
  and failed writes (`LoadProgress`), and at start the folder is checked writable and on a volume kept across a deploy
  (`DhanDataCache.CheckFolder`, `StorageVolume` from /proc/self/mountinfo) - logged, and an admin header tag when not
  ("Dhan cache not writable" / "Dhan cache lost at every deploy"); what it held at start is counted (`CountKept`) and
  shown as "Dhan cache ✓ N files" (days saved before the start = kept through the restart) or "Dhan cache started empty". A new Dhan data call for
  past days goes through `DhanHistoricalDataService` / `DhanRollingOptionDataService` so it is cached too
  (`DhanDataCacheTests.cs`). EVERY Dhan REST call goes through `DhanApiClient`'s Polly pipeline (stale-token retry -> chart
  "too many requests" retry, never an order -> rate limiter -> a data call's 20 s timeout from when it is SENT), whose rate
  limiter is the ONE shared `DhanRestRateLimiter` (each attempt, retries included): Dhan's limits are per account and per
  category - orders 10/s, 250/min, 1000/h, 7000/day (.NET sliding windows; one past the minute / hour / day limit is refused,
  not held), data 5/s (`DhanDataApiRateLimiter`: evenly spaced, page loads first), quotes 1/s, the rest 20/s
  (`DhanDataApiSharedLimitTests.cs`). Never call Dhan's REST API around `DhanApiClient`. No loops of a failing request (Dhan
  support flagged them): failures are NOT cached - every call goes to Dhan - but a background timer whose Dhan call failed
  slows down (`RetryBackoff` / `KeyedBackoff`: today warm-up and spot volume 10 min doubling to 1 h, CDV 30 s doubling to
  30 min) instead of asking again at its normal pace; any new timer that calls Dhan must do the same
  (`DhanRepeatGuardTests.cs`). NOTHING polls Dhan outside market hours - IST weekdays 09:00 - 16:00 (`MarketHours`): every
  hosted service's loop runs in `MarketHours.BackgroundScope()`, as do the server scanner's requests and a page's TIMER
  refreshes (the `X-Poll` header - `POLL_HEADERS` in `shared.jsx`), and `DhanApiClient` does not send a background polling
  call (positions, orders, the option chain / OI, quotes - everything but `/charts/...`) outside the window; the positions /
  orders refresh and the kill switch check also skip their rounds (`MarketHours.IsOpen`). Candle backfills (`/charts/...`)
  are not polling and go at any hour, as do a page's first load or a click; token renewal has its own HttpClient. A new hosted service or page timer must do the same (`MarketHoursTests.cs`). What reached Dhan in the last 15 min: `GET /api/system/dhan-calls` (admin). `GET /api/oi-replay/{u}/run?forceFetch=true` (the OI Replay page's "Force fetch from Dhan" tick) skips the saved days -
  the cache's reads miss (`DhanDataCache.ForceRefreshScope`), the stored database and the in-memory futures are not used - and writes what Dhan sends over the cache.
  What NSE answers for a PAST day (the contract list - `NseFuturesContractArchive` - and an expired contract's 1-minute bars - `NseChartHistory`) is kept on
  disk too (`NseDayStore`, `{DhanCachePath}/nse`), and after NSE does not answer it is not asked again for 10 minutes (`NseBackoff`) - callers fall back at once
  instead of waiting out a 20 - 30 s timeout per request. Dhan's scrip master is ONE kept file shared by the spot / futures / option-chain masters
  (`DhanScripMasterFile`, `{DhanCachePath}/scrip-master`, re-downloaded after 4 h; a failed download uses the copy kept) - not three downloads after every start.

- Charts show MARKET HOURS only - the F&O session, weekdays 09:15 - 15:30 IST (15:29 the last minute): after the close
  Dhan keeps re-sending snapshots and the book. Server: `MarketHours.InTradingSession` - the OI Replay live feed keeps no
  bar / sends no chart tick outside it (only each leg's last reading), the Order Flow engine takes no heatmap column, the
  spot feed (`SpotUnderlyingState.ApplyTick`) builds no spot candle / volume outside it (the last price still follows the
  index; the first tick after the close ends the 15:29 bar, so `spotUpdate` then carries no forming bar).
  Page: `marketSession.js` - `groupByStrike` (every OI chart, heatmap, totals, walls, the External page),
  `mergeFuturesLive`, and the OI Replay / External spot candles and VWAP (loaded and live) drop readings outside it. A new
  chart feed must do the same (`tests/market-session.test.mjs`, `SpotUnderlyingStateTests.cs`).

- Never commit local-only auth bypasses, credentials or `appsettings.Local.json`; never change Dhan
  credentials. Don't run the real server against Dhan just to test - use the tests, `vite preview` with
  a mocked `/api`, or a local feeder.
- The External account (`AuthRoles.External`, `Auth:ExternalEmail` / `Auth:ExternalPasswordHash` - a PBKDF2 hash, never the
  plain password) sees only `ExternalPage.jsx` (tabs: OI Replay's CE / PE / Net OI totals, the Order Flow liquidity heatmap with
  big-order dots, OI Replay's spot chart with its timeframe, VWAP and OI S-R walls ("Top 5" off by default, "Δ and S-R only" short labels on by default), OI Replay's
  chain-wide CE / PE OI with its Total / Since open switch - those pages' own exported components
  and code, not copies) and reaches only `/api/external/...`
  (`ExternalController`, NIFTY / BANKNIFTY, read-only, today - or, for the OI and chart, one of the last 5 trading days, `?date=`, allowed list from `days`), `/api/auth/...` and `/hubs/spot`, where it may join only
  "of:{U}", "of:{U}:{expiry}", "c:{U}:N1" and "u:{U}" (`ExternalAccess.MayJoin`); what used to go to every hub connection goes to
  `SpotHub.StaffGroup`, which it never joins. `ExternalAccess` answers 403 to every other API, hub and swagger for it, deny by
  default (`ExternalAccessTests.cs` checks every controller and that nothing is sent to Clients.All). Never widen it.
- The OI totals S/R break and 🎯 high-probability alerts (`oiLevelBreaks.js`) run in TWO places with ONE step
  (`stepOiBreakAlerts`): the OI Replay page while it is open (pop-up, chime, voice) and the server scanner for every enabled
  index with no page open (`IndexScanner.checkOiBreaks`, Telegram tagged [Server]). 🎯 = a cumulative-line break AND the CE or PE
  OI at ATM ± 1 shifting `atmShiftPct` % (default 20) of its size the same way, within the window. Settings (on / window / %) are
  `config.oiBreakAlerts`, shown and saved by the page; the Telegram keys are the same (`breakAlertKey` /
  `highProbabilityAlertKey`), so a message goes once; the page sends Telegram itself only when the server is not covering
  the index. `tests/oi-break-alerts-server.test.mjs` / `tests/oi-level-breaks.test.mjs`.
- OI Replay's ATM straddle card (`StraddleCard.jsx`, `straddle.js`): from a set time (09:15 by default, "From") the range
  the options priced - by default ("Range: Today") the ATM strike ± today's share of the straddle (0.8 x spot x ATM IV x
  sqrt(minutes left to 15:30 / (252 x 375)), never more than the straddle: the straddle itself prices the move to EXPIRY);
  "To expiry" = strike ± the straddle. The ATM straddle (nearest strike each minute) against its VWAP from the start; the
  "Held" straddle - the one taken at the start, shifted to the new ATM once spot is "Re-centre after" N strikes from it
  (default 2), with the range read again from there. The read (sideways / premium bought / trend / breakout / not
  confirmed) uses the start's range. It runs on the replay clock (nothing after it - `tests/straddle.test.mjs`) and live;
  the read describes the day, it is not a measured signal and feeds no strategy.
- OI Replay's GEX card (`GexCard.jsx`, `gex.js` - `gexDay` / `gexUpTo`): gamma exposure minute by minute from the run's
  option points - Black-Scholes gamma (no carry, each option's own IV, the ATM IV where it has none or one outside 0.5 -
  2x the ATM IV) x the dealers' OI (Dhan's OI is in units - no lot size) x S^2 x 1% = rupees of index per 1% move. The
  time to expiry is IMPLIED each minute from the ATM straddle at the ATM IV (`impliedYears`), so a past day needs no
  expiry date and it follows Dhan's IV day count. Sign ("Sign"): Standard = calls +, puts -; OI build-up = the first
  reading's OI as standard, then each minute's OI change adds -|change in OI| x sign(change in premium). Levels: net GEX,
  the gamma flip (the spot where the net would cross zero, OI / IV kept, within +/- 3%, nearest spot), call / put wall
  (most call / put gamma x OI), max gamma (most of both). Only ATM +/- 10 strikes count (partial totals). Every minute
  uses only readings up to it (`tests/gex.test.mjs`); the day is worked out once and cut at the replay clock, live at
  most every 5 s. It feeds no strategy.
- OI Replay's Option CDV / OBV card IS the dashboard's: today, live, its own series (`dashboardFlow.js`); a past day, worked
  out from the day's 1-minute option bars with the server's formulas (`optionFlow.js` = `CdvUnderlyingState`: CDV weighted
  by each minute's spot, bar-proxy delta; OBV weighted by the LATEST spot - the replay clock's - rebased to the day's first
  minute, EMA 9). CDV is drawn raw like the dashboard's chart ("Smooth CDV (EMA 9)" checkbox for the Pine look). One fixed
  day is held to the same numbers on both sides (`CdvParityTests.cs`, `tests/option-flow.test.mjs`) - change one, change both.
- The visitor log (admin-only Visitors page, `GET /api/system/visitors`): every page a browser opens - every account and
  visitors with no account (the login screen, `POST /api/auth/visit` from `visits.js`) - plus sign-ins, failed sign-ins and
  sign-outs, with the city / region / country of the connection (`VisitorLog`, `VisitRecorder`, one CSV file per IST day -
  `{yyyy-MM-dd}.csv`, a header row, formula-safe cells - under `Storage:VisitorLogPath`, 90 days; the page's Download CSV is
  `GET /api/system/visitors.csv`, admin only; Clear history is `DELETE /api/system/visitors`, admin only - it leaves one "cleared"
  entry naming who cleared it). NEVER store or show an IP address: `ClientAddress` gives the address only for the
  lookup (`GeoLocator` - DB-IP's free city database kept on this server under `Storage:GeoDbPath`, refreshed monthly by
  `GeoDbUpdater`, so addresses are never sent to any service) and the beacon's rate limit; `VisitorLogTests.cs` checks no address
  reaches the file.
- Live order placement only ever happens behind the explicit, confirmed "Auto-place on alert" switch in
  Live (Dhan) mode; alerts and the default auto trade are paper.
