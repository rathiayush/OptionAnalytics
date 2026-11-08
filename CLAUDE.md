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
  Dhan again. So a HOLIDAY asked ALONE would go to Dhan on every load (the Signal backtest's days, the previous day's
  profile walking back over one, the expiry check): an INDEX day goes through `GetIndexDayCandlesAsync` - a past day
  that comes back empty is asked once more through the closed days after it (`HolidayProofDays`, 7) and, a later day's
  minutes in that answer, is kept empty (holiday) with the days after it - every later load reads it from disk; a run of
  a PAST day fetches its spot BEFORE its futures (`RunAsync`), so a holiday stops at the spot with no futures / option
  call. An EXPIRED futures contract (most past days of a backtest - Dhan keeps intraday history for live contracts only):
  NSE's chart first (kept on disk - `PastFuturesCandles`), then Dhan, whose empty answer for it is final and kept empty
  (`keepEmpty` / `DhanDayWindow.KeepEmpty`); a live contract's empty day is never kept. `BacktestCachingTests.cs` holds it
  end to end through the REAL `OiReplayService` on a fake Dhan, NIFTY / BANKNIFTY / SENSEX: a backtest day (the run - spot,
  42 option series, futures - and its previous day's profile) asks Dhan once, then the same backtest and a restart ask it
  NOTHING; a holiday is proved once with no futures / option call and never asked again. Older whole-window files are still read for their exact request and split into days. The folder is held to
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
  index with no page open (`IndexScanner.checkOiBreaks`, Telegram tagged [Server]). They are the APP'S alerts: Telegram
  (the server's, and the page's own when the server is not covering) only when the OI totals card's "Telegram" switch is
  on (`config.oiBreakAlerts.telegram`, OFF by default - a config saved before the switch has none and reads as off; the
  card then says "In the app only"); the server still lists what it raised for the page, and the switch does not restart
  its watch. On the page they are run by the PAGE
  (`useOiBreakAlerts` + `useOiBreakAlertSettings` in `OiReplayPage`), not by a card - a card scrolled off-screen stops
  re-rendering (`LiveSection`) and a hidden one is not there, and both used to silence them; the "OI totals" card
  (`oiTotals`: the CE / PE / Net Δ and cumulative Δ table, Charts, the bucket the alerts read and these settings -
  `OiChangeHeatmapSection show="totals"` with the page's `alerts`; the heatmap card is `show="strikes"`, no alerts) only
  shows the settings. LIVE ONLY, after the OI net rows, the card (Numbers and Heatmap, and the N quick view) adds the near
  futures' ORDER FLOW in the same buckets (asked for - "order flow's delta and cumulative delta after the OI net cumulative,
  per 3 min"): "Futures Δ (buy − sell)" = each bucket's aggressor buy - sell volume, "Futures cumulative Δ" = from the
  session's first minute (the Order Flow page's / futures panes' CVD) - `withOrderFlowRows` in `oiTotalsHeatmap.js` on the
  page's `futuresFlow` minutes (loaded live whatever the futures chart's Δ / ΣΔ switch, kept up to date by the
  "orderFlowDelta" push), a minute counted once the clock reaches it, the newest column the bucket still trading; green
  buyers ahead / red sellers, the shade what the bucket did; estimated minutes (a day recorded part way) italic / faded.
  Not on a replayed day, not on the External page (it passes no flow) - `tests/oi-totals-heatmap.test.mjs`. A PAST DAY REPLAYED raises them too, on the replay's clock (`stepReplayOiBreakAlerts`: the end of
  the last minute shown, completed buckets only - nothing after it; the slider taken back starts the watch again, a jump
  announces only what is fresh), marked "replay", never to Telegram (`tests/oi-replay-alerts.test.mjs`). Which alerts
  the page raises - live and replayed - is its "Alerts" dropdown in the controls (`oiAlertTypes.js`,
  `optionanalytics.oiReplay.alertTypes`): by default 🎯 high probability and the CE / PE S/R breaks; Net S/R break, the
  big OI shift near ATM (the beep and box over the spot chart, with its threshold) and the premium / discount zone (the
  server's, live) are one click away (`pickOiAlerts` - the 🎯 watch still sees every break). The server's Telegram is not
  changed by that choice. 🎯 = a cumulative-line break AND the CE or PE
  OI at ATM ± 1 shifting `atmShiftPct` % (default 20) of its size the same way, within the window. Settings (on / window / %) are
  `config.oiBreakAlerts`, shown and saved by the page; the Telegram keys are the same (`breakAlertKey` /
  `highProbabilityAlertKey`), so a message goes once; with Telegram on, the page sends it itself only when the server is not
  covering the index. `tests/oi-break-alerts-server.test.mjs` / `tests/oi-level-breaks.test.mjs`.
- OI Replay's ATM straddle card (`StraddleCard.jsx`, `straddle.js`) draws the two straddle charts the option tools draw
  (Sensibull's "Auto ATM" and a fixed strike), each against the VWAP of its combined premium from a set time (09:15 by
  default, "From"): AUTO ATM - the strike nearest the expiry's futures price (a weekly has none: the synthetic one,
  strike + call - put over the 3 strikes nearest spot), switching from the minute it changes; FIXED - the start's ATM or
  a strike picked on the card, kept all day and NEVER shifted (an adjustment is the trader's, not the chart's), with what
  a seller of it has made. The range the options priced at the start: by default ("Range: Today") the ATM strike ±
  today's share of the straddle - straddle x sqrt(trading minutes left today / trading minutes left to the expiry, the
  run's `optionExpiry`; on expiry day the straddle itself - the straddle prices the move to EXPIRY); "To expiry" = strike
  ± the straddle. It is read from the option PRICES and the expiry date only - no futures data, not the feed's IV (the ATM
  IV shown is the straddle's own), so a past day replayed and today live are worked out the same way; only without an
  expiry date does the range fall back to the feed's IV. TIME DECAY is shown, not taken out of the Auto ATM line: a dotted
  "Decay only" line - the start's straddle with only time passing (start straddle x futures / start futures x sqrt(trading
  minutes left to expiry / those at the start), IV unchanged); the Auto ATM over it = premium bought beyond the decay (IV
  up), under it = sold faster (IV down) - and a "sellers" read whose straddle is not under that line says its fall is
  time decay, not selling. TRADE IDEAS (option buying, `tradeIdeas` / `TRADE_DEFAULTS`): BUY CE (PE) when the premium is
  expanding - the Auto ATM straddle over its VWAP 3 min and over the decay-only line - and the synthetic futures moved up
  (down) >= 25% of today's priced half-range over "Read over" minutes and are still going that way; the ATM option at
  that minute's close, then on its own 1-minute bars: a bar opening through the stop fills at its open, stop before
  target, else out when the straddle is 2 min back under its VWAP, or 15:10; no entries after 14:45, one at a time, 10 min
  after an exit; stop / target % on the card. Ideas only - nothing is placed, no strategy or alert is fed. The read (sideways / premium
  bought / trend / breakout / not confirmed) is the Auto ATM straddle vs its VWAP and spot vs that range. It runs on the
  replay clock (nothing after it - `tests/straddle.test.mjs`) and live; it describes the day, it is not a measured
  signal and feeds no strategy.
- OI Replay's GEX card (`GexCard.jsx`, `gex.js` - `gexDay` / `gexUpTo`): gamma exposure minute by minute from the run's
  option points - Black-Scholes gamma ON THE FORWARD (d1 from ln(F / K); F = put-call parity at the three strikes nearest
  spot, call - put = F - K, the middle one, spot when none or > 2% off - `parityForward`, as professional systems do; the
  carry-less version put a monthly option's gamma ~1.5 strikes low) with each strike's IV WORKED OUT FROM ITS OWN PREMIUM
  (Black-76 on the forward, the out-of-the-money leg first - `impliedVol`; one IV a strike; Dhan's IV field only where no
  premium gives one; outside 0.5 - 2x the ATM IV, the ATM IV) - the premium fixes sigma x sqrt(T), all gamma depends on, so
  Dhan's IV convention and even a time to expiry a day off change no gamma - x the dealers' OI (Dhan's OI is in units - no
  lot size) x S^2 x 1% = rupees of index per 1% move. Checked against an independent textbook implementation (Black-Scholes
  with a rate, each option's own IV) on weekly / expiry-day / skewed / monthly chains: net within 0.2%, flip within 0.3
  points, also with Dhan's IV field 50% off (`tests/gex.test.mjs` holds the forward, the IV and the invariance). The
  time to expiry runs to 15:30 IST on the options' expiry day, 365-day years: the run's `optionExpiry` /
  `optionExpirySource` (`OptionExpiryResolver`, filled by `GET /api/oi-replay/{u}/run`): from today on Dhan's listed expiry
  (holiday moves included); a past one the weekday rule (`ExpiryCalendar.NearestOptionExpiry` / `OptionExpiryWeekday`:
  NIFTY / BANKNIFTY Tuesday, SENSEX Thursday, BANKNIFTY monthly the last Tuesday - from 1 Sep 2025; NSE Thursday and SENSEX
  Tuesday (2025) / Friday before) checked against Dhan - a rule day with no spot candles was a holiday, the trading day
  before is the expiry (`OptionExpiryResolverTests.cs`). No expiry (or past it): T implied from the ATM straddle at the
  ATM IV (`impliedYears`, Dhan's ATM IV) - kept on each minute too; no warning any more, since the IV from the premiums makes the
  gamma independent of T. Sign ("Sign"): Standard = calls +, puts -; OI build-up = the first
  reading's OI as standard, then each reading's OI change adds -|change in OI| x sign(change in the option's OWN IV) -
  Black-76 from its premium at that minute's forward and time to expiry (`stepBuildup`), so spot's move and the time decay
  are out: IV up = buyers pushed (dealers short), down = writers (dealers long). It was the PREMIUM's sign, which over a
  minute follows spot - every call added in a rally read as bought, call writers selling into it included, every put as
  written: the trend, not who traded. A change whose IV moved by under half a premium tick's worth (vega x change < 0.025)
  or that has no IV (a premium under its intrinsic value) counts as standard - it used to be dropped (`tests/gex.test.mjs`
  holds the rally both ways, flat IV, the tick and the put side); both are worked
  out always, each with its flip (the card shows either), and a line says whether their regimes agree (`gexAgreement` -
  agree = act on it, disagree = unclear; `flips: false` leaves a flip out for a caller that needs only the net and walls). Levels, as the GEX tools publish them (SpotGamma, MenthorQ,
  the Indian GEX pages): net GEX; the gamma flip / zero gamma (the spot where the net would cross zero, OI / IV kept -
  the GEX PROFILE, `gexProfile`, drawn on the card - within +/- 3% of spot AND the strikes loaded, nearest spot;
  `flipEdge` = within a strike step / 1-sigma move of their edge, "rough"); the CALL WALL = the strike ABOVE spot with
  the most call gamma x OI (resistance), the PUT WALL = the strike BELOW spot with the most put gamma x OI (support), MAX
  GAMMA = the most call + put gamma x OI of any strike (the magnet). A level moves to another strike only with 10% more
  gamma x OI (`WALL_SWITCH` - no flicker between two strikes about level); above / below spot keep a dead zone of a
  quarter strike step (`WALL_ZONE`): a strike becomes a wall only once spot is that far from it, a wall breaks (rolls on
  to the next strike) only once spot is that far through it. Only ATM +/- 10 strikes count (partial totals). Every minute
  uses only readings up to it (`tests/gex.test.mjs`); the day is worked out ONCE on the page for both signs (`useGexDays`,
  live at most every 5 s) and cut at the replay clock by the GEX card and the entry checklist. It feeds no strategy. The
  ENTRY CHECKLIST (`entryChecklist.js`, option buying) has one GEX check from it: gamma - dealers short gamma (net GEX
  negative) under both signs (disagreeing = unknown) - `tests/entry-checklist.test.mjs`. (A "room to the GEX wall"
  check was removed on request.) SMART DETECTION (`gexTrend.js` - `gexTrend` / `gexTrendDay`, the "Smart detection" line
  under the card's controls, always shown): the trader's TRUTH TABLE of GEX behaviour x price behaviour (`GEX_TREND_TABLE`,
  nine rows, their words kept - in the ⓘ tooltip, the row matched now lit, with "The trend today": the day's reads in
  order) read over the last N minutes (5 / 10 / 15 / 30, default 15, `optionanalytics.oiReplay.gexTrendWindow`) of the net
  GEX of the Sign shown: a change of sign (the start clearly on one side - outside the near-zero band - now past zero),
  near zero (within 10% of the gross GEX, every strike's call and put counted positive), increasing / decreasing (10% of
  its size further from / nearer zero), else steady; price rising / falling = spot moved 0.1%, else sideways. A pair the
  table has no row for is NAMED, no read made up. Each minute from its own window only (`tests/gex-trend.test.mjs`); it
  says since when the read holds and the one before it ("was"). AT THE LEVELS (`gexLevelsNear`, `GEX_LEVEL_TABLE`, a line
  each under it and a second table in the tooltip): spot within 0.15% of the PUT WALL (support), the CALL WALL
  (resistance) or MAX GAMMA (the magnet), read by the net GEX's sign now - positive: support / resistance likely to hold,
  the magnet pins; negative: a break can accelerate, the magnet is weak; "weak" when the net GEX is near zero. A read,
  not a signal - it feeds no strategy or alert. The tables open as a hover TOOLTIP with a mouse (70vh, scrolls) and, on a
  touch screen / phone ((hover: none) or <= 768 px), as a POPUP a tap opens - full width, its body scrolling, closed by its
  ✕ (a tooltip there ran past the bottom of the screen with no way to scroll or close it); both start with what it
  reads NOW (the read and the levels spot is at).
  (A DEX - delta exposure - card was built beside it and removed on request, code and all: its lean repeated the OI
  reads already on the page, and "delta" next to the order flow's cumulative delta / CDV confused the two.)
- PAGE PREFERENCES are kept for the ACCOUNT on the server (`UserPreferencesStore` - one JSON file per account under
  `Storage:PreferencesPath`, `/app/data/preferences` on the persistent volume; `GET` / `PUT /api/preferences`, Admin and
  User only - the External account never reaches it, `ExternalAccessTests`): every `optionanalytics.*` localStorage key a
  page writes (layouts, cards shown, folds, timeframes, EMAs, tabs, switches) so a refresh, a restart / deploy, another
  browser or computer opens the pages as they were left. `prefsSync.js` does it with no page code: it watches
  localStorage's `setItem` / `removeItem` and sends changes (gathered ~0.8 s, at once when the tab is hidden or closed,
  retried when they fail), and `loadPreferences()` puts the server's values into localStorage BEFORE any page draws (on a
  page load already signed in and on login - `App.jsx`); the first time (nothing saved for the account) this browser's
  own preferences go up instead. A load that fails sends nothing for that page's life - a fresh browser's defaults never
  overwrite what was saved. NOT kept (`LOCAL_ONLY`): caches and records (the live day cache, the scanner's history /
  paper / fired / trail logs, sent-Telegram keys), the visitor id, the paper positions and trade levels (the server
  keeps those itself) and the scanner's Paper / Live choice - live trading is never switched from another browser. A new
  setting only has to use `usePersistedState` (or localStorage) with an `optionanalytics.` key; one that must stay in
  this browser goes in `LOCAL_ONLY` (`tests/prefs-sync.test.mjs`, `UserPreferencesStoreTests.cs`). A new `Storage:*` path
  goes in BOTH `docker-compose.yml` and the `Dockerfile`'s `ENV` (the Dockerfile's list was missing four).
- The site NAVIGATION (`NavBar` in `shared.jsx`, `.oa-sidenav-*` in `index.css`): over 768 px a SIDEBAR down the left - the
  name, the menu (an icon a page), the server's status tags, the email and Log out - portalled to <body> and fixed; the
  page makes room with `body.oa-sidenav`'s padding (NavBar sets the class while it is mounted), and the page's own
  "Option Analytics" title beside NavBar is hidden. Its fold button narrows it to the icons (64 px, `STORED_SIDENAV_COLLAPSED`).
  At 768 px and under there is no sidebar: the ☰ drawer and the header row's status, as before. A page opened from the
  menu opens at its TOP (`go` scrolls the window first - the router kept the scroll, so after OI Replay a page opened at
  its bottom). OI Replay's controls
  card folds to one row (Live, index, expiry, day, timeframe, Load day, "More" - `STORED_CONTROLS_COLLAPSED`); its
  warnings, errors and the load's progress show either way, and its own "Option Analytics" row is not shown over 768 px.
- OI Replay's DASHBOARD (`dashboardLayout.js`, `DashboardGrid.jsx`, `DashboardCard.jsx`, the `.oi-dash-*` rules in
  `oiMobile.css`): on a wide screen the cards are a FREE 12-COLUMN GRID (`react-grid-layout`, its legacy API) - any card
  dragged by its ⠿ grip to any place, resized from its bottom-right corner. Each is `{ i, x, y, w, h }`, h in grid ROWS
  (`GRID_ROW_HEIGHT` + `GRID_MARGIN` each - `rowsToPx`), saved whole in `STORED_LAYOUT`. The model is all pure functions
  (`defaultLayout` / `reconcileGridLayout` / `presetLayout` / `isDefaultLayout` / `nextFitScale`,
  `tests/dashboard-layout.test.mjs`); the dragging, collisions and packing are the library's. Dragging starts ONLY from
  `.oa-dash-grip` (`draggableHandle`) - otherwise scrubbing a chart would move its card. The page takes the WHOLE window
  (no max width - a 3440 px monitor was a third empty at the old 2600 cap); a card is at least `MIN_W` (2) columns,
  the grid's `minW` too, so a card is never dragged narrower than it is read back. "Cards a row" 1 - 4, and 6 from a
  `SIX_A_ROW_PX` (2400) window (`cardsARowChoices`) - `presetLayout` lays out the SHOWN cards only (a hidden one left
  a hole), never makes the spot / entry card (three charts) under half (`PRESET_MIN_SPAN`), fills a row with the next
  cards that still fit and gives a row closed short its last card the rest of the width. The spot / entry card's three
  charts END ON ONE LINE while side by side (`useEvenChartBottoms`: each chart gets `extraHeight` = how much shorter
  its card's header / footer is than the tallest - card height less chart height, which never depends on the chart, so
  the measure cannot chase itself; stacked, nothing). "Fit
  heights", "Reset" (place, width AND height back) and "Free placement" (`compactType` null: a card stays exactly where it is
  dropped, gaps and all; off, the cards pack upwards). `preventCollision` is always OFF - on, a card dropped on an occupied
  place sprang back, which reads as "I cannot move this card"; off, whatever is in the way moves aside. "Arrange" only
  outlines the grid - dragging works either way. The page OPENS as a dashboard, not a column: `defaultLayout` packs the
  cards left to right at `defaultSpan` (full width only for the snapshot, the checklist, the heatmap, the spot / entry and
  futures charts; the rest half) and wraps; a layout saved as the old all-full-width stack (`isStackedLayout`) is dropped
  once (`LAYOUT_VERSION`) so this default takes over. A card added since a layout was saved goes RIGHT UNDER the card
  before it in the page's order, everything below moving down (`reconcileGridLayout`) - with none of those saved, at the
  bottom. A card SPLIT OUT of another (`SECTION_SPLITS`: the OI totals out of the heatmap) is added to a saved "Sections
  shown" wherever its old card is shown, ONCE (`withSplitSections`, `SECTIONS_VERSION`) - hiding it afterwards sticks;
  without it the totals and their alerts would have vanished for anyone with a saved choice. Reset is offered only when something was arranged:
  `isDefaultArrangement` (each SHOWN card's column, width and order down its column - not its height, which follows the
  content) - the grid saves only the cards on the page, so a hidden card comes back elsewhere and must not count.
  UNDER `WIDE_LAYOUT_PX` (1100) THERE IS NO GRID AT ALL: `DashboardGrid` stacks the cards full width at their own height,
  as the page always did, so a layout dragged out on a monitor can never leave a phone with a sliver of a chart.
  A card in the grid is in ONE OF TWO MODES (`DashboardCard`): AUTO (the default) - its body stands at its content's own
  height, is measured (ResizeObserver, next frame) and the card is fitted to it (`fitLayoutHeights`, `rowsToHold` - the
  fewest rows that hold it ALL, never the nearest row: the card clips), so NO card scrolls inside itself; the fit context
  is null there, so the charts stand at their own height - that is what stops measure / fill chasing each other.
  SIZED - its corner was dragged (`onResizeStop` -> `STORED_SIZED`): it keeps that width and height and its CONTENT
  FOLLOWS - every chart's height (`useFitHeight`: lightweight charts, the SVG GEX profile, the OI heatmap's row height)
  and every table box (`CardFitBox`: the ladder, GEX by strike - the box scrolls inside, the card does
  not) is its own height x ONE scale for the card, measured until the content is the card's height (`nextFitScale`:
  secant steps, the first by the heights that scale; 0.25 - 4x; at most 8 steps a size). Only text (a checklist) cannot
  stretch - a card of it made taller has room under it. A chart's new height is APPLIED to the chart there is
  (`useChartHeight` / `applyOptions`), never drawn again: a chart drawn again had no data until the next update (a
  paused replay's chart went blank). While a card is resized or dragged the grid holds the height it had (`minHeight`):
  shrinking the bottom card shortened the page, the browser scrolled up, the corner left the pointer and the card ran
  down to its minimum. "Fit heights" puts every card back to AUTO.
  The CARD never scrolls (`.react-grid-item.oa-dash-card { overflow: hidden }`), its BODY does (`.oa-dash-body`), and the
  resize corner - which react-resizable hands in WITH the children (key `resizableHandle-*`) - is rendered on the card
  beside the body, not in it: inside the scrolling box the scrollbar swallowed every drag of it. The corner is 26 px,
  blue and always faintly shown (`.oi-dash-grid` scoped - the library's stylesheet loads after `oiMobile.css`). The
  charts follow their container's WIDTH (each has a ResizeObserver). `useCardOrder` is still read on this page, but only
  to SEED the default layout's order - nothing drags through it any more. "Compact" hides the cards' long explanatory paragraphs (the
  `oa-note` class). The WHOLE structure is saved, not just the grid: which cards are shown too (`STORED_SECTIONS`,
  `reconcileSections` - anything saved that no longer exists is dropped, and an empty set falls back rather than
  leaving a blank page), and the page starts on `DEFAULT_SECTION_VALUES` - every card but Snapshot and Market Read,
  whose numbers all appear on the cards below them; both are one tick away in "Sections shown". (OI Replay's own
  "Liquidity map" card - the per-strike imbalance / zone / bias table - was removed on request, code and all; a saved
  layout or "Sections shown" naming it just drops it. The Order Flow page's liquidity map, which strategies read, is a
  different thing and stays.)
- OI Replay's QUICK VIEWS (`quickViews.js` - `QUICK_VIEWS` / `quickViewForKey`): a popup for a quick scan of one card -
  a SINGLE KEY (no Ctrl / Alt / Shift - the user's ask; Alt was tried first): Z Day OI since the open, X the OI totals
  charts (CE / PE / Net), C GEX, V the ATM straddle, B the futures chart, N the OI change heatmap and totals, M the option
  premium charts (ATM by default) - the bottom row of the keyboard (the same again or Esc closes, another letter switches;
  not from a box being typed in, not a key held down, not while the order ticket or its review is open - the ticket's own
  C / P pick the option). With Ctrl / Cmd a letter stays the browser's (Ctrl + C copies, Ctrl + N a new window). B is
  Futures, so the order ticket's BUY is F1 only (S / F2 still sell). The old Ctrl + Shift + 1 - 7 (`digit`) still open
  the same views. Or the "Quick view" buttons
  under "Sections shown" - shown even when the card is hidden. The popup renders the card's OWN content (the page's
  `dayOiContent` / `premiumPickers` / `premiumCharts` elements, `OiChangeHeatmapSection` with no `alerts` - so no
  second set of alerts - `StraddleCard`, `GexCard` on the shared `useGexDays`, `OiTotalsChartsPopup`, the futures card's `futuresControls` / `futuresContent` -
  its DOM button stays on the card), live with the page
  (`tests/quick-views.test.mjs`). On a phone / touch screen (no keyboard, a long page) a small floating button
  (`QuickViewFab.jsx`, 40 px) opens them: it starts at the BOTTOM LEFT of the page, right of the sidebar (`fabDefault`,
  `useSideNavInset` in `useScreen.js` - never over the menu), dragged anywhere (kept on the screen), a tap opens the seven
  views as small labelled icons (up or down, wherever they fit), a tap on one opens its popup. Where it was dropped is
  kept as its distance from the NEAREST CORNER (`fabAnchor` / `fabFromAnchor`, `optionanalytics.oiReplay.quickFabAnchor`)
  - an account preference, so a phone and a monitor share it: kept in pixels from the top left (the old
  `...quickFab`, no longer read), a spot picked on a phone put the button in the middle of a monitor's spot chart. It
  shows on EVERY screen (it saves the same scrolling on a monitor) - the page's "Quick button" tick turns it off.
  The REPLAY BAR (`FloatingReplayBar.jsx`, asked for - "replay bar also should be floating"): on a REPLAYED day, once the
  Spot card's own replay controls are out of sight (`useOnScreen` on them; or that card is hidden), a slim bar floats at
  the bottom of the window - Start / Pause, Reset, the minute shown, the slider (no handle tooltip), the speed - the SAME
  handlers and state as the inline controls (`toggleReplay` / `resetReplay` / `scrubReplay` / `changeReplaySpeed`), which,
  with their "Float" panel, are unchanged; not while that panel floats, never live. It starts right of the quick button
  while that sits in its row (`fabInBarRow`), at most 980 px wide, centred; the page keeps 72 px of room at its bottom
  for both. The "Replay bar" tick beside "Quick button" turns it off (`optionanalytics.oiReplay.replayBarOn`).
- The POP-UP ALERTS (antd's static `notification` - every page's: OI Replay's S/R breaks and 🎯 signals, the scanner's,
  price / profile alerts, order errors) are set up ONCE in `main.jsx` (`notificationStack.jsx`, rules in
  `notificationStackRules.js`): STACKED - past `notificationStackThreshold` (1 on a phone, 3 wider) they fold into one pile,
  the newest in front, a tap / hover spreads it out (antd's own stack; the static API takes it only from an antd `App`
  around its holder - `ConfigProvider.config({ holderRender })` - not from `notification.config`); COMPACT on a phone
  (`.ant-notification` rules in `index.css`: tighter padding and type, a long text cut to three lines until the pile is
  opened - one used to take a third of the screen); "CLEAR ALL (N)" over them while two or more are open
  (`NotificationClearAll`, `notification.destroy()`; on a phone beside the ☰, not over it). A new alert needs nothing:
  `notification.open` as before (`tests/notification-stack.test.mjs`).
- OI Replay's keyboard order ticket (F1 buy - B is the Futures quick view; S / F2 sell) is not taken from a box being TYPED in (`isTypingField` in
  `quickViews.js`): a text / number / date box, a searchable or tags dropdown, a text area. A checkbox, a radio (antd's
  Segmented), a switch or a plain dropdown (antd marks its input read-only) only hold the focus after a click - they used
  to count as typing, so after ticking VWAP or picking a timeframe B / S did nothing (`tests/quick-views.test.mjs`).
- OI Replay's Day OI card: the "Day so far" read and the Total OI lookback table each fold to one line (the verdict and
  its reason; the shortest lookback's CE / PE change) - `STORED_DAY_READ_OPEN` / `STORED_LOOKBACK_OPEN`.
- The cards' TEXT BLOCKS fold to one line and open again (`FoldText.jsx` - a ▸ / ▾ button, the folded line its `summary`
  or its own text cut with an ellipsis, a click on it opens it; `useFold.js`; `foldText.js` the pure rules). The CHARTS
  are the cards' main part, so EVERY block starts FOLDED - the reads (straddle read and numbers, GEX regime and the two
  signs' verdict, the checklist's reasons, the live-order note) and the explanations (heatmap, ladder, futures chart
  notes, liquidity map, profiles, footprint, Market Read, paper trades, the page intro, the chart captions) alike; the
  GEX number row is not a text block and always shows. Each block keeps its own click (`optionanalytics.fold.<id>` -
  an account preference like every other, `prefsSync.js`); the controls card's "Text: Fold all / Open all" sets
  `optionanalytics.foldAll` and drops every block's own click, so blocks not on the page follow too. An explanation keeps
  the `oa-note` class on its FoldText, so "Compact" still hides it whole. A new block of text on a card: wrap it in
  `FoldText` with its own id (`tests/fold-text.test.mjs`).
- CHARTS BIG, TEXT SMALL on OI Replay: where a card is not sized (a sized card's own fit decides), every chart stands
  `CHART_GROW` (1.35) times the height it asks for, up to 62% of the window (360 - 560 px) and never shorter than asked;
  in a quick-view popup `POPUP_CHART_GROW` (2), up to 72% (360 - 900 px) - `chartGrow` / `grownChartHeight` in
  `dashboardLayout.js`, given by `<ChartGrow>` (`DashboardCard.jsx`) and applied in `useFitHeight`, which every chart
  goes through (`{ grow: false }` for tables and the OI heatmap's rows). The window height is followed on a new width
  only - a phone's browser bar coming and going must not make the charts jump. The text is small: the page's
  `COMPACT_TEXT_THEME` (antd component tokens - Statistic 16 px numbers / 11 px titles, a compact Alert with a
  description) wraps the page AND its popups (they are portalled outside `.oi-mobile-page`, whose own clamp() rules in
  `oiMobile.css` cap at the same sizes); the popup's keyboard hint is hidden on a touch screen / phone. Another page
  (the External page too) has no ChartGrow - its charts are as asked (`tests/dashboard-layout.test.mjs`).
- OI Replay's Option CDV / OBV card IS the dashboard's: today, live, its own series (`dashboardFlow.js`); a past day, worked
  out from the day's 1-minute option bars with the server's formulas (`optionFlow.js` = `CdvUnderlyingState`: CDV weighted
  by each minute's spot, bar-proxy delta; OBV weighted by the LATEST spot - the replay clock's - rebased to the day's first
  minute, EMA 9). CDV is drawn raw like the dashboard's chart ("Smooth CDV (EMA 9)" checkbox for the Pine look). One fixed
  day is held to the same numbers on both sides (`CdvParityTests.cs`, `tests/option-flow.test.mjs`) - change one, change both.
- OI Replay's DELTA PROFILES (asked for - "like volume profile and market profile we need to build delta profile: the delta
  profile of option data on the spot chart, and also on the futures chart - add two more components on OI Replay"; two
  cards, `optionDeltaProfile` / `futuresDeltaProfile` - `DeltaProfileCard.jsx`, the maths `deltaProfile.js`, the drawing
  `deltaProfilePrimitive.js`): the candles with, at the right of the plot (`PANEL_SHARE`, the time axis's right offset
  leaving it empty, at least `MIN_SPAN` candle widths), a VOLUME column (how much traded at each price row - grey, the value
  area brighter, the POC amber, also a faint band across the candles: the big volume node) and a DELTA column (buyers minus
  sellers there - green right of its centre line, red left); the row under the crosshair outlined and read out under the
  chart; timeframe 1 / 3 / 5 / 15 and the row size per index (`PROFILE_ROWS` / `PROFILE_ROW_CHOICES`, shared by both cards -
  `optionanalytics.oiReplay.deltaProfileRows`). OPTIONS ON SPOT (`optionDeltaProfile`): the run's option bars (live ones
  added - `flowCePoints`) given a side as the Option CDV does - `barProxyDelta` (where the close sits in the bar's range) x
  `deltaWeight` (the strike's delta at that minute's spot; volume weighted the same) - added up a minute and SPREAD over the
  spot rows that minute's spot bar covered (its last price when it has none); Net = CE Δ − PE Δ (+ bullish: calls bought /
  puts sold), CE / PE alone their own buying (+) / selling (−); in lots of the index (`PAPER_TRADE_LOT_SIZE`). FUTURES
  (`futuresDeltaProfile`): the Order Flow day's footprint (`/api/order-flow/{u}/day/{date}` at the row size, with
  `backfillBars` - the minutes the server did not record live estimated from 1-minute candles and TAGGED, a whole day
  estimated when it holds none), `dayVolumeProfile` regrouped, delta = buy − sell, in lots (`meta.lotSize`); live it is
  loaded again every minute (a page timer - `POLL_HEADERS`; the server's memory, not Dhan). Both count only the minutes up
  to the replay clock (`asOfMs`; live the latest) - `tests/delta-profile.test.mjs` (worked values, the sides, the value
  area, a profile at a clock = the one built from the minutes before it). Their charts fit the whole day THEMSELVES
  (`fitContent` after setting the right offset, until the viewer drags / zooms - `useChartUserControl`): the shared
  `fitWholeDay` reads the visible range back at once while the chart applies a change a frame later, and from a one-candle
  start it kept the first zoom's cap for good. The cards are in "Sections shown" and added ONCE to a choice saved before
  them (`SECTION_ADDITIONS`, `withAddedSections`, `SECTIONS_VERSION` 4 - only the cards added since the version a choice was
  saved at, so one hidden since stays hidden; `tests/dashboard-layout.test.mjs`). A read, not a signal - it feeds no
  strategy or alert.
- OI Replay's paper trade panel (`paperStops.js`, `paperExit.js`): each position keeps the levels it was punched with (the
  panel's, or the keyboard ticket's) in its `levelLog`; a panel change (once it has settled a second - typing 25 passes
  through 2) reaches the OPEN positions of THAT index only, from the minute it is made (`withPaperLevelChange`): a minute is
  judged with the last change made in it or before, so the minutes already passed are never judged again. In the minute of
  the entry or of a change only the point's own price counts - its high / low partly came before it (live, the forming
  minute's range holds the ticks before the entry). The trailing stop only tightens: what a bar earned is kept through a
  change of the trail (wider, or off). A long log folds into `checkpoint` (the server keeps a position to 4 KB). A No SL
  position is squared off at 15:15 (`tests/paper-stops.test.mjs`). Each position keeps its entry and exit time (`entryTime` /
  `exitTime`, shown HH:MM:SS under its prices): the clock at a punch or a manual exit (live, to the second); an auto exit's
  the second it was seen live, else the minute it hit in (`paperExitTime`, `tests/paper-exit.test.mjs`). MORE THAN ONE INDEX
  on a REPLAYED day (`tradeIndex.js`): "Also load" beside Load day (a multi-select, `optionanalytics.oiReplay.alsoLoad`)
  holds other indices' days with the charts' - the same `/run` (calls, puts, spot, futures), 1-minute, their series =
  the charts' Weekly / Monthly, BANKNIFTY Monthly - in `dayRuns`, one per index and day (the day loaded's only; the charts'
  own run is stored there too when it loads). FETCHED ONLY WHEN ASKED: Load day (the charts' index + the "Also load"
  ones), an index added to "Also load" with a day loaded, the paper panel's "Load X", or the charts switched to an index
  not held - never by picking a trade index. The INDEX PICKER on a replayed day SWITCHES THE CHARTS to that index's held
  day at the SAME replay minute (`switchReplayIndex` / `applyReplayIndex`: its run becomes `result`, `barsShownAt` keeps
  the minute, its own Weekly / Monthly with it, NO reload, the paper trades untouched; not held: "switching to X…" while
  it is fetched) and the index left joins "Also load". The paper trades go to the index on screen by default ("Trade in"
  / the panel's picker choose another held one - `paperUnderlying`), each takes ITS ATM (`tradeAtmAt` - its spot bar of
  the minute shown, nothing after the clock), step, premiums, lot size and SL / target / lots / trail, and each position
  is priced and exited from ITS OWN index's held day at the replay clock (`chainOfPosition`) whatever the charts show;
  one with none held waits (never the wall clock). Live it is always the index on screen - a live order is never sent
  for another index from here (`tests/trade-index.test.mjs`).
- OI Replay's "Σ 3 EXPIRIES" (asked for - "cumulative delta combined ... current expiry, current + 1 and the month's last
  expiry - these 3 sum ... at every component level"; then "check / uncheck ... in replay of a previous day or the current
  day which is live, and the page reflects it"; the checkbox beside the expiry picker, `optionanalytics.oiReplay.sumExpiries`,
  ALWAYS clickable - a replayed day (past or today) and live; live it sums on the current expiry N1 only, another live expiry
  shown alone with a line saying so; UNTICKED THE PAGE IS EXACTLY AS BEFORE - checked card by card against the page before
  it, and `gexDay` with no `chains` equals the old one minute for minute): the CURRENT expiry + the NEXT (the live feed's N2) + the MONTHLY (its MONTH chain) -
  the monthly only when it is neither of the other two (the month's last weeks; BANKNIFTY lists monthlies only), so no
  expiry is counted twice (`summedExpiries` in `expirySum.js`; live from the listed expiries, a replayed day from ITS current
  / next / monthly - `GET /api/oi-replay/{u}/summed-expiries?date&expiryFlag`, `OiReplayService.SummedExpiryDatesAsync` on
  `OptionExpiryResolver`). Every OI read - the OI totals' Δ / cumulative Δ, Day OI,
  Total OI, the heatmap, the walls, Market Read (its OI build-up near ATM too), the ladder, the drill-down, the OI alerts
  and the quick views - reads their OI added at each strike and minute (`sumExpiryOi`, swapped in at `ceByStrike` /
  `peByStrike` - the one place every OI read takes its points from); GEX adds each expiry's OWN (`gexDay`'s `chains`, asked
  for - "build it there as well": each expiry its own forward, time to expiry - the band's expiry date - IVs from its own
  premiums and build-up book; the net, calls / puts, each strike's GEX / OI / gamma x OI - so the walls and max gamma - the
  flip and the profile (`netGexAt`: an option's own `years` / `carry`) added; the minute's forward / ATM / IV the current
  expiry's; one chain alone exactly as before - `tests/gex.test.mjs`), tagged "Σ N expiries" on the GEX card, the entry
  checklist's gamma check with it. The PREMIUMS cannot be added, so a point keeps the current expiry's premium, IV and
  volume: the straddle, the premium charts, the paper trades (and the order ticket) and the option CDV / OBV
  (`flowCePoints`) stay on the current expiry. An expiry's last reading AT OR BEFORE a point's time is added (carried on,
  never a later one); one first read at a strike AFTER the current expiry's first reading there counts by its CHANGE from
  that reading (0 before) - in full, its whole OI read as OI added; strikes the current expiry does not have are left out
  (`tests/expiry-sum.test.mjs`, a cut at any clock equals the whole day's up to it). The bands: `GET
  /api/oi-replay/{u}/expiry-band?date&expiryFlag&expiryCode` (`OiReplayService.ExpiryBandAsync`; the next = the series'
  code 2, the monthly = MONTH code 1 - counted from the day; anything else refused), asked once the day's run is in and
  again with each new run: a PAST day = Dhan's rolling options once, then the disk cache - ATM±3 for the next expiry (the
  stored database never - it keeps the current cycle), ATM±10 for the monthly (the series a Monthly run asks, stored
  database first like it); TODAY (`forceLive`) = the live feed's own 1-minute bars (ATM±10 -
  `LiveOptionLegStore` keeps bars for WEEK, MONTH and N2 - `OiReplayLiveFeedService.KeepsBars`) from the first minute it
  holds (`FirstOptionMinute`), NO Dhan call when that is the open, and Dhan's backfill (once a day, TodayFetchShare - the
  monthly's shared with a Monthly run's) only for the minutes before it: ATM±10 for the monthly (the nearest of its series),
  ATM±3 for the next expiry (`OtherExpiryBandSteps` - Dhan's docs: ATM±10 for the nearest expiry only, ±3 for every other
  contract; a wider request would only fail, again and again); each strike carried on within the run's ATM±10 band
  (`CarryForward`). The page joins "c:{U}:N2" / "c:{U}:MONTH" and folds their ticks into the bands
  (`handleOiReplayTicks`), live. A line under the controls says what the OI is the sum of (dates; what is loading; the
  monthly counted once; the next expiry's ATM±3 - a past day's only, today's before the feed's first minute). The OI alerts read the sum and say "· 3 expiries" -
  in the app only, NEVER to Telegram from the page while summing (the server's watch and the Telegram keys are the current
  expiry's; a replay never sends Telegram anyway); the watch starts again as each expiry joins. The Signal backtest has the
  same option (its own checkbox - see there).
  `OiReplayExpiryBandTests.cs` (a past day asks Dhan once - ATM±3 code 2 / ATM±10 MONTH code 1 - then disk; today the feed's
  bars with no option call, or Dhan's before the feed's first minute, once a day; the day's current / next / monthly).
- Chain-wide OI (`chainOiTotals.js` - the Day OI card's since-open figures and chart, the Total OI lookback, the External
  page's chain chart): the band follows spot, so a strike that joins it after the open counts from its first reading -
  counted in full, its whole OI showed up as "added since the open" (`tests/chain-oi-totals.test.mjs`). Market Read
  (`marketRead.js`): resistance = the most call OI AT OR ABOVE spot, support = the most put OI AT OR BELOW it - its
  Sell suggestion is one of them; the OI build-up is over the same 5 bars as the price move. The futures chart's OI
  line and regime markers read each candle's OI at its close (`oiAtCandleCloses`). The straddle card's charts
  (`LinesChart`): a line's label follows the line; the fixed straddle has its own pane under the Auto ATM's. The previous
  day's volume profile is drawn as HORIZONTAL BARS behind the candles on the spot and both entry charts as well as the
  futures chart, and the futures chart's own HVN / LVN are read by `profiles.histogramNodes` - the SAME rule the server
  uses for the spot profile (a strict local peak / trough of the raw rows, a run of equal rows counted once), NOT the
  stricter `profileNodes` the strategies read (`lvnRun`): that one smooths, wants 1.3x / 0.6x the mean and a trough
  BETWEEN the peaks, which on a profile built by spreading each minute's volume over its range finds no LVN at all on
  a real day. (`VolumeProfilePrimitive`, fed by `profiles.binsProfile` - the server's own bins, so the bars and the
  POC / VAH / VAL lines can never disagree; bins carry no buy / sell side, so they are one neutral colour). The page's
  "VP bars" tick, on with "Volume Profile"; off leaves the levels alone.
- The PROFILES page (`/profiles`, "Volume & Market Profile" - `ProfilesPage.jsx`, `profileZones.js`, `profilePrimitives.js`): a
  row of two cards (`ProfilePair`) for the index's SPOT and one below for its near FUTURES, each over its own candles (timeframe
  1 - 30 min, profile row per index - `PROFILE_ROWS`), with the day's VWAP on every chart ("VWAP" tick, on by default - typical
  price x volume over the 1-minute bars as `VwapCalculator`, `sessionVwapFromBars` + `alignToBars`). FUTURES: the Order Flow
  server's futures day (`/api/order-flow/{u}/day/{date}`, fetched in the footprint's row - `FETCH_ROWS` - and re-bucketed, so a
  row change asks nothing) with `backfillBars=true`: the Order Flow engine records a day in MEMORY from when the server
  starts, so after a restart / deploy - part way, or after the close (then none of the session) - the day's minutes before
  it come as the estimate from Dhan's 1-minute candles as WHOLE bars (`OrderFlowSnapshot.BackfillBars`, only when asked -
  the Order Flow page and the scanner read the recorded `Bars` only, untouched; `OrderFlowHistory.BackfillCutoff` /
  `AttachBackfill`, `OrderFlowBackfillTests.cs`) and `withBackfillBars` fills exactly the minutes not recorded, tagged "futures
  before HH:MM estimated" (without it the card had no futures of the day and fell back to the day before's). SPOT: the index's 1-minute bars WITH its own volume (`GET /api/oi-replay/{u}/spot-day` -
  `OiReplayService.GetSpotDayAsync`, the run's own order, `PickSpotDayAsync`: the spot feed's whole day with no Dhan call, else
  the stored database / Dhan - kept on disk, today shared with the run's fetch - else the feed's partial day); index volume has
  no side, so its bars are one colour; before January 2026 Dhan sent none (the card says so; the market profile still shows).
  LIVE it is kept up to date the way OI Replay is - NO TIMER (`useLiveIndexFeed`): the "/hubs/spot" connection, group
  "u:{U}", its conflated "liveBatch" - "futuresTicks" folded into minutes with the rise of Dhan's day volume
  (`mergeLiveFuturesTicks` in `futuresLive.js`, OI Replay's own, shared) and joined to the loaded day (`mergeFuturesLive`;
  those minutes are candles, their volume spread over their range - `dayVolumeProfile` takes footprint and candle minutes
  together), "spotUpdate" for the spot's forming minute (OHLC - Dhan's index ticks carry NO volume: the spot feed re-reads
  each finished minute's from Dhan, so when the push turns to a new minute the page reads the feed's memory once,
  `/api/spot/{u}/volume-candles` - never Dhan - and `mergeSpotLive` keeps each minute's largest volume). The day is loaded
  once (and again after a reconnect, for what it missed). LIVE with no minute of today yet (before the open, a holiday)
  while the profile holds earlier sessions ("Previous", or Days above 1): the latest of them stands in for the candles,
  said on the card with the day's load error if any - a chart with no candles has no price scale, and the profile, its
  boxes and lines were all blank. Never for a past day: that starts fresh. A PAST DAY is REPLAYED AS OI REPLAY'S: it
  opens FRESH at its first minute (the clock defaults to the day's start, not its end - nothing after the clock on any
  chart), with OI Replay's controls - Start / Pause, Reset, Speed (`SPEED_OPTIONS`, ms a market minute, 0.5x - 10x,
  `optionanalytics.profiles.speedMs`), Go to (a minute, shown), the slider - each labelled by the minute it shows. The slider has NO handle tooltip
  (`tooltip={{ open: false }}`): on an iPhone a tap left it open, it re-aligned at every replay step and the page died with
  React error #185 (an update chain past 50); the crash screen (`AppErrorBoundary`, `main.jsx`) shows the component stack. VOLUME PROFILE: POC / VAH / VAL lines, ONE dotted
  HVN line (orange - `topHvn`, the busiest row of the busy areas, the POC's aside) and ONE LVN line (light blue -
  `thinLvn`, the thinnest row of the thin areas) - as OI Replay's entry charts draw theirs (`PREV_PROFILE` colours), each labelled on the price axis and named in the header, the bars at the right
  (`VolumeProfilePrimitive`), and BOXES (`volumeZones`): busy areas (smoothed row >= 1.3x the mean - each with its
  HVN, the POC's marked) and thin areas INSIDE the range (<= 0.6x - each with its LVN; a thin run at the top / bottom row is
  the day's edge, not a gap). The BARS are drawn WIDE AND SOLID here (asked for - at OI Replay's 28% of the plot and 18 - 42% opacity the spot's were
  too small to read): `PROFILE_PAGE_BARS` (0.82 / 0.55 opacity, the spot's neutral bars blue, a brighter tip at each bar's
  end) and the "Bars" choice (`VP_BAR_SIZES` in `profileZones.js` - Narrow 30% / Normal 45%, the default / Wide 60% of the
  plot for the POC row's bar, the time axis's empty room on the right following it; `optionanalytics.profiles.vpBars`).
  `VolumeProfilePrimitive`'s own defaults (`DEFAULT_BAR_STYLE`) stay OI Replay's faint previous-day bars
  (`tests/volume-profile-bars.test.mjs`). MARKET PROFILE: the TPO letters at the right (`TpoProfilePrimitive`, A = 09:15, blocks when rows
  are too thin), POC / VAH / VAL / IB lines, and BOXES (`marketProfileZones`): the value area and the rows with >= 0.7x the POC
  row's TPOs (where the market spent its time - accepted), single prints inside the range (`singlePrintGaps`) and tails (>= 2
  single-print rows at the high / low, ending at a row of 2+ periods); one made only by the period still running is
  "forming". Nothing for a one-period profile. "Profile of": the day so far, or the previous session(s), over the day's
  candles. "DAYS" (1 - 20, default 1 = as before) makes both a COMPOSITE (`profileSessions` / `pastSessionsNeeded`): the day so
  far and the N - 1 sessions before it, or the N sessions before the day; the volume profile adds each price's volume, the
  market profile adds each SESSION'S own TPOs (`compositeMarketProfile` - every session lettered from A, so they are not merged
  by letter; IB = the latest session's; "forming" only for the day alone). The sessions before the day are walked back one
  weekday and one request at a time (a holiday's empty day stepped over, N + 10 weekdays at most) and kept for the tab's life
  (`PAST_DAY_CACHE` - a past day never changes; failures are not kept). The time axis leaves the right of the plot empty for the profile. It FOLLOWS OI REPLAY by default,
  one way (`useReplayClockBroadcast` in `OiReplayPage` - always on, whatever the Sync switch - and `useFollowReplayClock`,
  `optionanalytics.replayClock` channel): OI Replay's index and day, live or at its replay clock (its own controls locked
  while it follows; nothing it does moves OI Replay); the moment OI Replay STARTS loading a past day (`loadingDate` on its
  message) this page switches to that day fresh - it used to keep the old day until OI Replay's load was done; a day
  whose load FAILED there (`failedDate`) is shown from this page's own data, the tag saying so (it read "loading" for
  ever); a day whose load failed HERE (`useInstrumentDay` - a past futures day can fail while the server is still
  fetching it from Dhan / NSE) is asked again once by itself 10 s later, then by the card's Retry or the moment OI Replay
  has loaded that same day - never a loop; the Spot / Futures headings name the day their data is of; the
  earlier sessions of Days / Previous are counted back from the day replayed, not from today; with no OI Replay tab open it is its own - Live, or a past day with its
  own slider / play. ON A PHONE no OI Replay tab answers (the pages share ONE tab - OI Replay is closed while this page is
  open - and a background tab is frozen), so OI Replay also KEEPS its last clock in this browser on every change
  (`replayClockStore.js`, `optionanalytics.replayClock.last` - LOCAL_ONLY; not kept: OI Replay just opened with no day yet)
  and the follower takes it up - when following starts and when the page comes back into view, only if OI Replay moved
  since, never while an OI Replay tab answers, none older than 2 h - opening there with its own controls ("Opened where
  OI Replay was left", `tests/replay-clock-store.test.mjs`). Its charts let a finger moving up / down SCROLL THE PAGE
  (`handleScroll.vertTouchDrag: false` - a phone's page is four charts, and a swipe on one moved its prices instead;
  sideways still pans, pinch zooms) and stand 62% of the window, 360 - 560 px (`chartGrow`'s cap, the height read again
  on a new width only). The VIEWER'S VIEW IS KEPT through live updates: no update fits the chart while a pointer is down
  on it (`pointersRef` - live, a push every second put the chart back under the finger, so it could not be dragged or
  zoomed at all), and a drag / pinch / zoom button / price-axis drag (the time range moved, or the price scale's
  auto-scale off) takes the view - kept until a double-click / double tap or ⟲ hands it back. NO LOOK-AHEAD: a minute counts once it has COMPLETED at the clock (`barsKnownAt`, session minutes only).
  It does not touch `profiles.js`' scanner rules (`profileNodes`, `lvnRun`) - `tests/profile-zones.test.mjs`.
- The SIGNAL BACKTEST page (`/signal-backtest`, `SignalBacktestPage.jsx`, `signalBacktest.js`): pick an index, a range of PAST
  weekdays (at most `MAX_BACKTEST_DAYS` 60 - `backtestDays`; THE DAYS PICKER - `DaysPicker`, `backtestDates.js`, asked for: "when
  I select dates it gets picked to an old date; I should be able to enter manually as well as previous years": on a phone
  (<= 768 px) a From and a To picker of ONE month each - the two-month range picker was wider than the screen, its older
  month ran off the left edge with its ◀ / «, so the dates showing there were that month's and earlier years could not be
  reached; a From after the To moves the To and the other way round (`withRangeEnd`); wider, the range picker; every one
  takes a date TYPED as 2025-01-06, 06/01/2025, 6-1-2025, 06.01.2025, 6 Jan 2025… (`DATE_INPUT_FORMATS`), past days only,
  and QUICK RANGES (`rangePresets` - last 2 weeks / month / 3 / 6 / 12 months, this year, last year - the range picker's
  presets, a phone's dropdown - with the last 2 / 5 / 6 years for a background run); a range longer than a background run takes says it runs the latest 1 500) and BUILD ONE RULE - the only strategy (the 8 fixed strategies
  and the weighted vote were replaced by it on request) - with DROPDOWNS, no typing (asked for): a TREE of GROUPS
  (`rule.tree` - `cleanTree`, `RuleGroup` / `ConditionRow` on the page): each group "Match ALL of these (AND)" or "ANY of
  these (OR)", a NOT tick, its CONDITIONS and its own GROUPS (+ Condition / + Group ( ) - a group inside a group is a pair
  of brackets, at most `MAX_GROUP_DEPTH` 5 deep): (1 AND 2) OR (3 AND (4 AND 5)) = ANY of [ALL of 1, 2 - ALL of 3, ALL of
  4, 5]. The group's ALL / ANY dropdown sets EVERY AND / OR in its box (asked about: "all of existing conditions are also
  getting changed"), so each AND / OR BETWEEN two items is its own tap switch (`Connector`, `setConnectorAt`): only that
  one changes - AND binds tighter, so a run of AND-ed items gets its own ALL box (ANY [1, 2, 3, 4], 1 - 2 tapped = (1 AND
  2) OR 3 OR 4), a group left with its parent's op (no NOT) is taken into it (tapping back undoes it), the conditions and
  their numbers never move; not made where it would need a box past MAX_GROUP_DEPTH. A hint under the rule says so; no
  tooltips on a touch screen (a tap opened one over the conditions). And the LOGIC AS TEXT, both ways (asked for - "an input
  section ... UI will also be updated"): `LogicInput` under the builder shows the builder's logic and logic TYPED there
  (condition numbers, AND / OR / NOT in any case, & | !, brackets) and applied - Apply, Enter or leaving the box - redraws
  the builder (`treeFromLogic`: every condition EXACTLY ONCE - one left out or written twice is an error, never dropped or
  copied; AND and OR SIDE BY SIDE with no brackets are NOT read either way (asked about: "1 OR 2 OR (3 AND 4) is not
  the same as 1 OR 2 OR 3 AND (4)" - maths reads AND first, a trader often means the other; THEN beside AND / OR likewise
  needs brackets): `mixedLogicReadings` asks
  which, and for a plain line of numbers offers its two readings as one-tap buttons - OR first ((1 OR 2 OR 3) AND 4) and
  AND first (1 OR 2 OR (3 AND 4)); brackets at most MAX_GROUP_DEPTH inside each other, measured BEFORE cleanTree, which
  would cut a deeper group off; the conditions keep their settings and are numbered again in the order written). The
  logic SHOWN always has its brackets, so it can be applied back as it stands. IN ORDER (THEN - asked for: "PE crossover
  CE, then bullish divergence appears and EMA crossed down then came back up"): a group's third choice, `op: 'then'` with its
  `within` minutes (`THEN_WINDOWS`, 30 by default, 1 - 375 typed - `fitWithin`), written "1 THEN 2 THEN 3 WITHIN 60 MIN"
  (THEN binds loosest; typed "->" / ">>" too; no WITHIN = 30) and parsed to { op: 'then', items, within }; its connectors are
  "THEN ↓", not switches (`setConnectorAt` leaves the group alone). The engine reads the logic OVER THE DAY'S CANDLES
  (`logicAt` - each part's reading at each candle worked out once; AND / OR / NOT at the candle): a chain holds at candle i
  when its last part holds at i and, back from where that part's current run started, each part before it BECAME true (holds
  at k, not at k - 1) at or before the part after it, the first of them within the last `within` minutes (in candles of the
  timeframe) - so a part already true before the window (a state since the morning) did not happen in it, and the order is
  of the moments each part became true, not of their look-backs; nothing after candle i is read. The mirror keeps the order
  and the window. `evalLogic` (one moment) reads a chain as all its parts - the engine does not use it for the rule.
  `tests/signal-backtest-then.test.mjs`. What cannot be read
  says why in red and changes nothing (Undo puts the rule's own back); the box is mounted again (`key` = the logic) when
  the builder changes, so a half-typed line never sits over a rule changed with the dropdowns. Each condition is an indicator (`RULE_CONDITIONS`), what it says (its options), its NUMBER where one makes sense
  (`param` - "by ≥ %" over VWAP / the POC / the straddle's VWAP, the OI lead, "within %" of a wall, spot's move, the
  cumulative line's tolerance) and its own LOOK-BACK for what happened "in the last N min" (`windowed` - crossed, turned,
  broke, near, a 🎯, spot's move; `WINDOW_CHOICES`, 5 by default); the same indicator may be used twice. The engine still
  reads LINES + LOGIC: `ruleFromTree` numbers the conditions in the tree's order (the number shown on each) and writes the
  logic over them ("Logic: (1 AND 2) OR (3 AND (4 AND 5))" under the builder; an empty group left out); `parseLogic` /
  `evalLogic` evaluate it (NOT, then AND, then OR). A rule saved before the builder - lines with their AND / OR (AND binds
  tighter - `orGroups`), or a typed logic (the short-lived Logic box) - opens as its tree (`treeFromRule`; same-op chains
  one group) and the page always numbers from the tree; `ruleText` says the rule in words. The values: OI since open (PE / CE ahead, PE / CE crossed above the
  other), TOTAL OI (asked for - OI Replay's "Total OI" and its lookback table, the same chain-wide totals, `chainOiTotalsAt`,
  kept as `tot`; OI since open is them less the open's): total CE / PE OI increased / decreased / flat by a % over the
  window (`totalCondition`), and the Total OI chart's two lines CE vs PE (`totalOi`): PE above CE / CE above PE, PE crossed
  above CE / CE crossed above PE in the window (still above now), each "by ≥ %" (asked for, like OI since open's lead -
  `TOTAL_LEAD` / `totalLeadPct`: the line ahead NOW by at least that % of the other, PE 4.4 cr over CE 4 cr = 10%; a cross
  only with that lead now too; 0 = any lead, the default, so a line saved before reads as it did). No PCR - removed on request; a line saved with the
  short-lived `totalPcr` is dropped (`cleanLine`), the rest of the rule kept. HELD SINCE THE MORNING, THEN FLIPPED (asked for -
  "since morning the OI indicator was CE > PE and then it flipped"): OI since open ("CE ahead since the morning, then PE
  crossed above" and the mirror), Total OI CE vs PE ("CE above since the morning, then PE crossed above") and the CE / PE /
  Net cumulative Δ ("Positive since the morning, then turned −ve" and the mirror) - `flippedAfterHeld`: the flip in the
  look-back and the line still on its new side, after holding the other side for `param2` "held ≥ N min" (`HELD`): 0, the
  default, = since the open - the day's FIRST flip (every reading from the first that was not level on the other side;
  OI since open starts level), N = at least N minutes straight right before the flip (an earlier flip allowed); with the
  crosses' own "by ≥ %"; the box says "min = since open" at 0 (`param2.after`), the words "held since the open" /
  "held ≥ N min before" (`param2.text`). THE S-R WALLS NEAR ATM (asked for - "S-R walls total CE PE ATM ± 1, 2, 3, CE cross
  PE - and since open too"): two conditions, "S-R walls ATM ±: total OI (CE vs PE)" (`atmOi`) and "... since open (CE vs PE
  added)" (`atmOiOpen`), on the strikes ATM ± N of each minute (`param3` "ATM ±", 0 - `ATM_OI_MAX` 5, default 1): their CE
  (R) and PE (S) OI added up - the spot chart's walls' own OI - or what each added since the open (a strike from its own
  first reading); worked out in `prepareDay`'s walls loop (`atmOi[i][N]` = { ce, pe, dce, dpe }, readings up to the minute,
  the summed expiries' OI with Σ 3 expiries) and carried by `timeframeView`. Each: PE / CE above, PE / CE crossed above
  (in the look-back, still above), and held since the morning then flipped (`HELD`), with "by ≥ %" - total: of the lower
  one (as Total OI's), since open: of CE + PE added (as OI since open's); and Bullish / Bearish DIVERGENCE (asked for - "add
  bullish div as well in option"): the band's PE − CE (total / added) read as OI since open's and Total OI's - the same
  `divergenceHolds`, its price move / followed < % and the ATM ± N; the band follows spot, so part of a total's move can be
  its strikes changing as ATM moves. ONE STRIKE (asked for - "ATM is 25000: +1 = 25050, -1 = 24950"; the box took no -1 -
  it is the band's width): the "Strike" dropdown (`param4`, ATM - 5 ... ATM + 5, ATM the default - as before; a list, no
  typing - a phone's number pad has no minus) is the strike the band is around - ATM + k steps of each minute's ATM;
  picking one off ATM sets ± to 0 (`also`), so ATM - 1 reads 24950 ALONE (± N widens it around that strike); worked out
  from `prepareDay`'s `atmStrikes` (each strike ATM ± 10 of the minute: CE, PE and their changes since the open,
  `atmBandPair`; ATM itself still reads `atmOi`); the mirror reads the other side's strike (ATM - 1 <-> ATM + 1 -
  `param4.mirror`; `mirrorLine` now applies any number's `mirror`). The CE / PE / Net cumulative Δ (positive / negative, turned, rising / falling / stable against its range so far,
  its own S/R breaks, and DIVERGENCE - asked for: "cumulative delta was x at 9:30, the same at 10:00 or only some %
  decreased, and price dipped more - that is divergence": Bullish / Bearish divergence = over the look-back spot moved
  >= `param` % down / up but the line FOLLOWED it by less than `param2` % of its own range so far - held, barely moved or
  went the other way; "followed" is the line's direction when OI confirms the move (`CUM_LINES.follows`: PE moves WITH
  price - unwound into a fall; CE and Net against it - calls written into a fall); the mirror swaps bullish / bearish with
  the same numbers. OI SINCE OPEN and TOTAL OI CE vs PE take the same divergence (asked for - "add this bullish div signal
  in total oi and oi since open as well so we can apply filter"): their line is PE − CE (added since the open / total),
  which follows price (puts written into a rise, calls into a fall) - `divergenceHolds`, one function for all seven
  lines (the S-R walls near ATM's two too). A condition's SECOND NUMBER (`param2`) is held to its range by `cleanLine`, passed to the test, shown
  as a second box on the row and in `lineText`), 🎯, the OI S-R walls (near the support / resistance, broke through - and SINCE THE MORNING, asked for: "highest S-R wall from
  morning or lowest OI wall": near / broke above the HIGHEST resistance and near / broke below the LOWEST support the walls
  have been at since the open, and near / broke the STRONGEST of each - the minute's wall with the most call / put OI so
  far, a later one taking over only with more; `wallsSinceOpen`, each minute's wall from minutes 0 - i, read at the candle
  before - a wall moves with spot, so past the day's highest resistance the resistance is a higher strike), GEX regime (long / short gamma,
  turned) and walls (near the put / call wall, broke through), price vs VWAP (above / below / crossed), spot's move, the
  ATM straddle (vs its VWAP and the decay-only line, crossed), the Initial Balance (after 10:15), and VOLUME PROFILE
  LEVELS - YESTERDAY'S, not today's developing ones (asked for; `levelCondition`): the PREVIOUS DAY's POC / HVN / LVN /
  VAH / VAL and its value area (`/api/oi-replay/{u}/previous-day-volume-profile` - OI Replay's entry chart lines, spot's,
  its first HVN / LVN; fixed all day, known before the open, read on spot; loaded with each day, a day without one runs
  and says so): price above / below (by ≥ %), crossed above / below, touched it and closed back above / below (support /
  resistance held, within %) and near it; inside / above / below the value area. A line saved while they were today's
  developing ones (`poc` / `vpHvn` / `vpLvn`) reads as the previous day's same level (`RENAMED`). INDICATORS OF THE SPOT
  CANDLES (asked for - "rsi vwap pivot points ... ema crossover"; VWAP was already "Price vs VWAP"): RSI (`rsi` - above /
  below / crossed a LEVEL, its `param`, period `param2`; the mirror reads the level from the other end, `param.mirror`:
  above 60 <-> below 40), EMA crossover (`emaCross` - fast over / under the slow, crossed in the look-back, "by ≥ %" of the
  slow; fast / slow = `param2` / `param3` - a THIRD number, `cleanLine` / `lineText` / the row take it) and price vs EMA
  (`emaPrice`, period `param2`) - `rsiSeries` / `emaSeries` (TradingView's ta.rsi / ta.ema: Wilder's RSI and the EMA started
  at the simple average of the first values; no change at all = RSI 50) on the spot closes of the TIMEFRAME's candles, RUN ON
  FROM THE PREVIOUS SESSION'S candles of the same timeframe (`prevDay` - else from 09:15), worked out once a day / view, a
  candle's value from its close and those before (no look-ahead). PIVOT POINTS (`pivotLevels`, the classic floor pivots of
  the previous session's spot high / low / close - P, R1 - R3, S1 - S3 - levelCondition like yesterday's profile levels; a
  pivot's mirror is the other side's, R1 <-> S1, the condition's `mirror`) and the CPR (`cpr` - BC = (H + L) / 2, TC = 2P - BC,
  the higher one TC: above / inside / below, crossed through TC / BC, narrow / wide by its width in % of P). The previous
  session is the previous-day profile response's own `bars` (`previousDayBars` - its session minutes, of its own day, before
  the day run) - a day whose previous session had no index volume has no profile, so no pivots (the report lists those days,
  `noPivots`, when the rule reads them) and its RSI / EMAs start at 09:15. OPTION PREMIUM TA (asked for - "TA indicators on
  ... option prices, like ema crossover or above vwap"): the ATM CE / PE premium on its OWN chart (`premiumConditions` -
  `cePremVwap` / `cePremEma` / `cePremEmaCross` / `cePremRsi` and the PE's): vs its own VWAP (typical price x the strike's
  traded volume from 09:15 - `ceVol` / `peVol`, kept by `prepareDay`; a minute the server carried over a gap has 0 volume; no
  volume = no VWAP, never true), vs an EMA, an EMA crossover, RSI - `premiumCandles` / `premiumEma` / `premiumRsi` over the
  timeframe's candles (a candle with no bar carries the last close; from the strike's first bar, no warm-up - the day before's
  option bars are not loaded); the strike is the ATM at the candle (spot's nearest), read on its own series up to it. The
  mirror is the OTHER SIDE's same condition, value and numbers kept (CE over its VWAP <-> PE over its VWAP - the condition's
  `mirror`). EMA AT THE CANDLE'S CLOSE (asked for - "for ema candle close and crossover condition"; spot's and the premiums'
  EMA conditions share it - `emaPriceOptions` / `emaPriceHolds`, `emaCrossOptions` / `emaCrossHolds`): against one EMA the
  candle CLOSED above / below it, the CLOSE crossed it (a close on one side, a later close on the other), a CANDLE crossed it
  (`candleCrossUp` / `Down` - opened on one side, closed on the other, the EMA at that candle's close; in the look-back and
  the close still past it now), a WHOLE candle clear of it (`wholeAbove` - its low over it / `wholeBelow` - its high under);
  the crossover's fast over / under / crossed the slow, the crossover WITH the candle closing beyond BOTH EMAs
  (`crossedUpClose` / `crossedDownClose`) and a close beyond both (`closeAboveBoth` / `closeBelowBoth`); and a cross one way
  THEN BACK in the look-back (`reclaimed` - crossed down through the EMA, then back up, the close still over it; `lost` - the
  mirror; 60 min is a look-back choice too - `WINDOW_CHOICES`). EMA SLOPE (asked for - "ema slope ... to hide choppy
  market ... 0 will be ignored"): every EMA option's FOURTH number (`param4`, `EMA_SLOPE` - `cleanLine` / `lineText` / the
  row take it): the EMA - the SLOW one for a crossover - moved at least that % over the last `SLOPE_CANDLES` (5) candles of
  the timeframe (`emaSlopeHolds`), UP for an option on the up side (`RISING`: above, crossed up, a candle crossing up, a
  whole candle over, reclaimed; the fast over / crossing up the slow, a close above both) and DOWN for the others; 0, the
  default, is not read (a line saved before reads as it did; its words say nothing of it). The mirror keeps the number.
  Spot's mirror is the other side's option; a premium's the other option's same one. `tests/signal-backtest-indicators.test.mjs`. EVERY comparison takes a "by ≥ %"
  (asked for - "add % for all even for crossing"), crossings and turns too, 0 = any (the default - a rule saved before
  reads as it did, `atLeast` / `frac`: a missing number is 0) and the mirror keeps it; only a 🎯 (an event) and the three
  "inside" (the IB, the value area, the CPR) have none - RSI's number is its level (`tests/signal-backtest.test.mjs` holds the list). What the % is of: price v a level (VWAP, the OI /
  GEX walls broken - `brokeLevel(..., p)`, the IB, yesterday's levels and value area) the level; OI since open CE + PE
  added (`LEAD`, its crosses too); Total OI CE vs PE the lower line; a CUMULATIVE Δ line (positive / negative, turned,
  broke - the break keeps the `level` broken, `brokenLevel`) and the NET GEX (regime, turned) - no price - their own range
  so far (`pastPct`: how far past 0, or past the level broken, NOW - the scale the lines' tolerance uses; `PAST`); a straddle
  its VWAP, or the decay-only line (`OVER_WIDE`, up to 50%). A signal ONCE when the rule becomes true (`ruleSignals`); a cross, turn or break must still hold now;
  a rule ALREADY TRUE when entries open (the first candle closing at / after 09:30 - `openAt`) signals there - else a
  condition true from the open (total PE OI above CE) never traded at all.
  "Then": Buy CE / Buy PE / Sell PE / Sell CE (`RULE_ACTIONS`). EXPIRY DAY (asked for - "that setting will override"):
  on the options' expiry day (`prepareDay`'s `isExpiry` = the day is the run's `optionExpiry` - the weekly, BANKNIFTY's
  monthly; known before the open) the "Expiry day" choice (`expiryDay`, `EXPIRY_DAY_CHOICES`: As the rule (default) / Buy
  options / Sell options / Don't trade, `optionanalytics.signalBacktest.expiryDay`) OVERRIDES the rule's buy / sell - the signal's
  direction kept (bullish buys the call or sells the put; the mirror's bearish one the put / the call), the same SL /
  target / trail - or, "Don't trade" (`skip`, asked for - "give option to trade on expiry or do not trade"), takes NO trade
  that day: its signals are listed, each skipped "expiry day - not traded" (`EXPIRY_SKIP_REASON`, the chart's grey dots),
  `simulateDay`'s `expirySkipped`, the day table's tag "expiry · not traded", the heading's "expiry day: not traded", the
  live scan sends nothing that day and its report says so; other days as the rule. TRADE IN ANOTHER INDEX (asked for - "order
  punched seeing NIFTY's data but actually to SENSEX ... chart will be shown of SENSEX"): the "Trade in" choice beside the
  index (`tradeIn`, `optionanalytics.signalBacktest.tradeIn`, '' = the same; `cleanBacktestSettings` drops the index's own):
  the rule reads the index picked, every trade is taken in the other's options - `simulateDay(d, s, { tradeDay })`: that
  index's day of the same date, its minute at the signal's clock (the last at or before it, within `STALE_MINUTES`; none =
  the signal skipped "no X minute"), ITS ATM, step, premiums and expiry (the Expiry day choice reads the TRADED options'),
  its lot size (`engineSettings`); the entry time stays the signal's; each trade carries `tradeIndex` (`optionName` -
  "SENSEX 82000 CE" in the trades, the CSV, the live alerts). No day of it = every signal skipped "no X data" (`dayOutcome`:
  the day not run, "X: <why>"). Each day loads BOTH indices - the page (`results[].tradeDay`, Compare all 20 too), the
  background job (a trade day that failed on the way tried once more) and the live scan (today's day of every index wanted,
  read once a round; a strategy whose traded index was not read waits for the next round, the others go on). The day chart
  shows the TRADED index by default ("SENSEX" / "NIFTY (signal)" / the signal's futures / Option - the traded index's
  strikes), saying the rule read the other; a page run's report is of ITS indices (a change waits for the next run - the
  page says so). `tests/signal-backtest.test.mjs` / `-job` / `signal-live.test.mjs`. STRIKE: ATM or 1 - 4 in / out of the
  money (`moneyness` -4 - 4, `MONEYNESS_CHOICES`; asked for - "add OTM 2 3 4 and ITM 2 3 4"; a call's ITM below spot, a
  put's above - `optionFor`). COST SL ONCE IN PROFIT (asked for - "once in profit have cost SL ... from the point where I
  entered spot, if price returns to the same level"; the page's checkbox, `costSl` '' / 'spot' / 'premium',
  `COST_SL_CHOICES`, `optionanalytics.signalBacktest.costSl`): in `simulateTrade` it is ARMED after a completed 1-minute bar
  CLOSED in profit BY AT LEAST "after +" (`costAfter`, asked for - "cost SL should happen after certain points, otherwise
  it will enter and just exit ... configurable": spot points on Spot, the premium in the levels' unit on Premium; 0 = any
  profit; kept PER INDEX with the levels) - spot (the TRADED index's) past its close at the entry the trade's way (a bought
  call / sold put up, a bought put / sold call down), or the premium past the entry - and from the NEXT bar: 'spot' = out when spot is back at
  the entry's spot (the option's close of that minute, its open when spot opened through; after the premium's own stops,
  before the target), 'premium' = the entry premium is a stop (the tighter of it, the SL and the trail stops, "Cost SL").
  PER-INDEX LEVELS (asked for - "different sl target for each index"): the page keeps the SL, target, trail and their unit
  (and the Cost SL's "after +") for EACH index (`optionanalytics.signalBacktest.levelsByIndex`, `indexLevels` / `withIndexLevels` in
  `signalBacktestJob.js`) - the TRADED index's (Trade in, else the index) are on the page, tagged "<INDEX> levels"; an
  index with none of its own reads the old single keys until it is changed (then it keeps its whole set); a run, saved
  strategy or background run still carries the one set it ran with (Use settings / Load put them on ITS traded index). The trade is marked (`expiryDay`, `overridden` - an "expiry" tag in the trades
  and day tables, the CSV's "expiry day" column, its `why` starting "Expiry day - selling instead"); the report heading
  names it; a background run takes it with the rest of the settings. MIRROR (on by default): every line's `opposite` value
  (above <-> below, support <-> resistance, rising <-> falling; GEX regime, the straddle, "inside" and "stable" have no
  side and stay; numbers, windows and AND / OR kept - `mirrorLines`) and the opposite trade - left out when no line has a
  side (`mirrorIsSame`). One trade at a time for the rule and its mirror together. The rule is saved whole
  (`optionanalytics.signalBacktest.rule`, `normalizeRule` / `cleanLine` - a number held to its range, an unknown line
  dropped, the earlier `{ conditions }` form read as AND-ed lines). Each day is loaded as OI Replay loads it
  (`/api/oi-replay/{u}/run`, one day at a time, a click - not polling; a day the server has not kept comes from Dhan once)
  and PREPARED once (`prepareDay` - every feature at each minute from data up to the END of that minute: OI since the open
  (`chainOiTotalsAt`), the OI totals' CE / PE / Net cumulative Δ and their breaks and the 🎯 signal (`completedLevelReads` /
  `watchBreaks` / `watchHighProbability` stepped minute by minute), the OI walls (`oiWalls`), GEX (`gexDay`, standard
  sign), the straddle (`straddleRead`), VWAP (the futures', else the index's own), the Initial Balance and the previous
  day's volume profile - `prevVp`), kept for the tab's life, so a change of the rule / levels / timeframe re-runs at once (`simulateDay`).
  TIMEFRAME (1 / 3 / 5 / 15 min,
  `TIMEFRAMES`, `timeframeView`): the rule reads the day on candles from 09:15 - a candle's OHLC from its minutes,
  every other feature as at the end of its LAST minute, the OI totals' breaks / 🎯 on that timeframe's own buckets
  (`oiTf`, worked out in `prepareDay`), each in the candle it became known in - so a signal is known at the candle's
  close and the trade enters at its last minute's option close, managed on the 1-minute bars as below; a line's look-back stays
  minutes (`span`); a change of timeframe loads nothing. A trade: the option's close at the signal minute, then its own
  1-minute bars from the next minute - a bar opening through the stop fills at its open, the stop before the target, the
  time stop and the 15:10 square-off at the bar's close, no entries before 09:30 or after 14:45 (`simulateTrade`). P&L is
  NET OF CHARGES (asked for - "0.15% STT and then 20 - 20 Rs on each buy sell"): the backtest's own rates, set on the page
  beside the Charges switch - `sttPct` 0.15 (% of the SELL side's premium: a bought option's exit, a sold one's entry),
  `brokeragePerOrder` 20 (the buy and the sell order), `otherPerTrade` 0 (`BACKTEST_DEFAULTS`, `tradeCharges`; the Order
  Flow scanner keeps its own rates, ₹7 other included); off = the gross. Every trade shows gross, charges and net (the
  page, History, the CSV), the report heading says what was taken (`chargesText`), the live scan's exit alert says "net
  ₹X after ₹Y charges" and its daily report the net, the charges and the gross; a saved strategy or background run keeps
  its rates with the rest. SL,
  target and TRAILING STOP in % of the entry premium or in premium POINTS (`levelUnit`, `LEVEL_UNITS`; 0 = none): the
  trail is the paper panel's (`optionTrailLevel` / `tighterStop` from `optionTrail.js`) - `trailGap` behind the best
  premium reached (a bought option's highest high, a sold one's lowest low) once `trailStart` in profit, moved after each
  completed bar (a bar is judged with the trail it had before it), only tightening, the tighter of it and the SL the stop.
  DAY LIMITS (asked for - "max loss of day / max return of day, 0 is by default off"): `maxDayLoss` / `maxDayProfit` in
  rupees (0 = off, the default - nothing changes), on the page beside Max / cooldown: the day's NET P&L - the trades closed
  that day and the one open, after charges - is held to them: each trade gets one more stop ("Day max loss") and one more
  target ("Day max profit") at the premium where the day's net reaches the limit (`dayLevel` - solved exactly with the STT
  on its sell side and the flat charges, so out at the level the day is at the limit to the rupee; a bar opening through
  it fills at its open, as any stop); the tighter stop / nearer target wins. Once reached, every later signal is skipped
  ("the day's max loss / profit reached"), and a trade with no room left for its own charges is not taken (the day ends
  there - "no room for this trade's charges"). `simulateDay` returns `dayLimit`; the day table tags the day "max loss /
  profit", the report heading names the limits; background runs, saved strategies and the live scan take them with the
  rest (the live day report says the limit was reached; the strategy's day history keeps it - `limit` column). The
  report (`summarize`): the rule, its mirror and both - trades, win %, net / gross P&L, points, average win / loss, profit
  factor, max drawdown, per trade, green days, average hold, charges - the running P&L by day, a MONTH-BY-MONTH table (asked
  for - "add month by month pnl as well, day by day is perfectly fine"; `monthRows` in `signalBacktestJob.js`, worked out
  from the report's own `dayRows` and `trades`, so a background run's report written before it has them too: each calendar
  month's net first - a phone shows it before the table scrolls - trades, win %, days run, the rule's / mirror's net, green
  days of the days traded, best / worst day, gross, charges and the total so far; "N of M months green"), a day-by-day
  table, every trade with the readings at its signal, and a CSV (`tradesCsv`). The DAY CHART (asked for - "spot chart ... with buy sell
  tag ... for already run as well as next run"; `SignalBacktestChart.jsx`, `signalBacktestChart.js`): any day of the report
  shown (the picker, ◀ ▶, or a click on a Day by day / Trades row) on the run's own timeframe's spot candles - or the futures
  the VWAP is read on ("Spot / Futures") - with every trade TAGGED: "BUY / SELL strike CE / PE" at the candle its signal
  closed (under it, up, green for a bullish signal; over it, down, red for a bearish one), a dot at its exit candle with its
  net (green / red), a grey dot for a signal not taken (the day run again with the run's own settings - `simulateDay`); VWAP
  (on spot the index's own - `spotVwap`, kept in `prepareDay` - none without index volume; on futures the rule's), the EMAs
  and RSI pane (the rule's periods, else 9 / 21 and 14; RSI's lines at the rule's levels) and the pivots / CPR - the engine's
  own series, so it shows what the rule read; the ticks default to what the rule reads (`ruleIndicators`) and are kept once
  changed (`optionanalytics.signalBacktest.chartShow` / `chartSource`). Asked for next ("time frame option ... and close",
  "two ema configurable", option prices): its own TIMEFRAME (`chartTimeframe` - "Run's" by default; another one says the
  rule read the run's), the TWO EMAs set on the chart (`chartEma` - else the rule's periods, else 9 / 21), CLOSE (`chartOpen`
  - a click on a Day by day / Trades row opens it again; a closed chart loads nothing; on a phone Close is in the controls
  row - the card's corner can sit under the floating ☰) and "Spot / Futures / OPTION": any strike of the day (`dayOptions`;
  by default the day's first trade's - `defaultChartOption` - a click on a trade's tag under the chart shows its option) with
  its own VWAP / EMAs / RSI and only its own trades tagged. The page's run has its days already; a BACKGROUND
  run's day (one finished before the chart existed too - its report has the trades) is loaded when it is picked, the page's
  loader (`loadDay` - the server's disk cache, kept for the tab's life), with Retry on a failure; a click, never polling.
  `tests/signal-backtest-chart.test.mjs`. TEMPLATES (asked for - "be a non linear thinker ... create top 20 strategy and
  add it in dropdown ... i can modify"; `signalTemplates.js`): `RULE_TEMPLATES`, 20 rules from the page's own conditions in
  six families (`TEMPLATE_FAMILIES` - in order (THEN), trend, reversal, breakout, options & volatility, premium selling),
  each read through a different lens (positioning, flow, dealer gamma, volatility, auction structure, momentum, the
  premiums' own tape), written for the bullish side with the Mirror on, with its `idea` (why) and its own `settings`
  (timeframe, SL / target, trail / time stop - what it does not name is OFF). The rule card's "Templates" dropdown (grouped,
  searchable, each with its idea) LOADS one onto the page - its rule and levels (`withTemplate`: the page's index, lots,
  charges, max trades, cooldown, day limits and expiry-day choice kept) - to run and edit like any rule; "Undo" puts back
  what was there. "Compare all 20" (`compareTemplates` / `templateRow`) runs every template over the days the PAGE'S run
  loaded (no load - the prepared days; one template a tick, a progress bar) through the same engine and report, ranked by
  net (a table; on a phone a block each - a table hid the names under its pinned column), each with Load & edit. They are
  starting points, not measured edges - the ranking says so. `tests/signal-templates.test.mjs` (every template whole - no
  condition dropped, its logic read, a side for the mirror, its levels in range; a row = that template's own report).
  Σ 3 EXPIRIES (asked for - "in signal backtest also give this option ... data will be calculated based on three expiry";
  OI Replay's own - the "Σ 3 expiries" checkbox beside Strike, `optionanalytics.signalBacktest.sumExpiries`, the settings'
  `sumExpiries`, off by default): each day loads its current / next / monthly expiry (`GET summed-expiries`) and the bands of
  the next and the monthly (`GET expiry-band`, the monthly once when it is the current or next - `summedExpiries`;
  `loadExpiryChains` in `signalBacktestJob.js`, `loadBacktestDay`'s `sumExpiries`) and `prepareDay`'s `expiryChains` sums
  them into EVERY OI READ of the rule - OI since open, Total OI, the CE / PE / Net cumulative Δ and their breaks and 🎯, the
  OI walls (`sumExpiryOi`) - and GEX adds each expiry's own (`gexDay`'s `chains`); the premiums - the straddle, the option
  premium indicators, the trades - stay the current expiry's. None given = exactly as before. A day whose other expiries
  cannot be loaded does not run (a server error tried once more, a refusal kept - it would be another strategy's numbers); a
  past day's next expiry is ATM±3 (all Dhan gives), from disk after the first time. The page keeps such days apart
  (`loadDay`'s key), its run remembers what it loaded (a change waits for the next run - the page says so), the day chart
  loads the run's kind of day, the report heading says "OI Σ 3 expiries" (`reportHead`); the engine never reads the flag
  (`engineSettings` drops it). A background run takes it (`scanner-runner/signal-backtest.mjs`), a saved strategy too - its
  LIVE SCAN reads today's next and monthly expiries from the server's memory (`forceLive`) for the strategies with it, cut
  to the completed minutes (`prepareLiveDay`'s `expiryChains`), backed off on their own so the index's other strategies go
  on. `tests/signal-backtest-sum.test.mjs` (the sums, the premiums kept, GEX, a cut part way = the whole day's, the loader's
  requests and failures), `-job` (the background run = the page's report) and `signal-live.test.mjs`.
  STRATEGY NAME (asked for - "add strategy name ... to runs"): the rule card's "Strategy name" box
  (`optionanalytics.signalBacktest.strategyName`) - filled by a template loaded (its name; Undo puts the old one back), a
  saved strategy loaded (its own name) or a background run's Use settings (its settings' name), or typed - is the settings'
  `strategyName` (`cleanBacktestSettings` / `strategyName`: one line, at most 80 characters, '' = none; the engine does not
  read it): the report heading starts with it (`reportHead`), a background run's default name is "name · index · days"
  (`defaultRunName` - so the server's Telegram at its end names it), the Background runs list says "Strategy: X" under a run
  named otherwise, and Save strategy offers it as the name.
  A backtest of the rule as set, not a tuning; it places
  nothing and feeds no strategy or alert (`tests/signal-backtest.test.mjs` - every value and number on its case and
  not without it, all of them together, the mirror, and the features of a day cut part way equal the whole day's up to the cut).
  A RUN is its days' OUTCOMES put together (`signalBacktestJob.js` - `loadBacktestDay`, `cleanBacktestSettings` (the
  page's ranges), `dayOutcome` = simulateDay of one day, `backtestReport`; the days are independent) - the page and the
  BACKGROUND run share it. RUN IN BACKGROUND (asked for - "schedule in background"): the page's "Run in background" queues
  the run as set (index, days, rule, levels, timeframe) on the server - NOW, AFTER THE CLOSE (15:45 IST today) or AT A TIME
  (at most 14 days ahead) - and the browser can be closed (`SignalBacktestJobService` / `SignalBacktestController`,
  `/api/signal-backtest/jobs`, Admin and User only - each account its own runs, an admin every account's; never the
  Runner key or External). Runs go ONE AT A TIME, each in its own Node process (`scanner-runner/signal-backtest.mjs`,
  bundled by `npm run build:runner` - `vite.backtest.config.js`, published as `scanner-runner/signal-backtest.mjs`) with
  the runner's key: each day through `/api/oi-replay/{u}/run` as the page loads it (the disk cache - a day not kept comes
  from Dhan once), replayed and dropped (only its outcome kept), a day that failed on the way (timeout, network, 5xx)
  tried ONCE more at the end - never a loop - and the report written as JSON (`reportReplacer` keeps an Infinity profit
  factor). Each run is a file under `{Storage:ScannerRunnerPath}/signal-backtests/` (`{id}.json` - settings, state,
  progress; `{id}.result.json` - the report): the queue and the reports survive a restart / deploy, a run the restart cut
  off is queued again (failed after `MaxAttempts` 3 starts); `MaxJobs` 60 kept (the oldest finished go first), 20 waiting
  an account. Telegram when a run ends (on by default in the dialog - `optionanalytics.signalBacktest.bgTelegram`). The
  page's "Background runs" card lists them (the days with their years - `runRange`, the run's name and the report's
  heading carry them too; state, day k of n, the result so far / its numbers; a page TIMER with
  `POLL_HEADERS` - 5 s while one runs or waits to run now, 30 s while one only waits for its time - `signalBacktestQueue.js`;
  a block a run on a phone, no sideways scroll): Open shows a finished run's report on the page (its own rule and settings
  - the page's do not change it), Use settings puts its settings on the page, Cancel / Stop, Remove. The background run's
  report is the page's for the same days (`tests/signal-backtest-job.test.mjs` - the job script against a fake server;
  `SignalBacktestJobServiceTests.cs` - the queue, the time, one at a time, restart, owners, limits, Telegram). A background
  run goes up to `MAX_BACKGROUND_DAYS` 1 500 weekdays, about six years (asked for - "I can schedule it for 300 days", then
  "1500 days please"; `SignalBacktestJobService.MaxDays`) - it keeps only each day's outcome; the page's own run stays at
  `MAX_BACKTEST_DAYS` 60 (it holds every day it loaded) and says when the range is longer than that; the report's Day by
  day table goes in pages of 60 (`DAY_PAGE`). A run whose days keep failing ON THE WAY (a timeout, the network, a server
  error - the server or Dhan not answering) STOPS after `STOP_AFTER` (5) in a row - a day that answered (run, or a
  holiday) starts the count again: the days after are listed as not run ("not asked - ..."), no retry pass, the result's
  `stopped` says why, and the list, the summary and the Telegram show it ("Stopped early") - never hundreds of days of
  failing calls (Dhan support flagged loops of failing requests). A day's first load from Dhan is ~45 calls (Dhan's data
  limit is per day too): 1 500 days nothing has loaded before is a few hours at 5 a second, from disk after.
  SAVED STRATEGIES (asked for - "save strategy ... scanned in live as daily and send daily report to telegram ... store
  history ... all csv no db"): the page's "Save strategy" keeps the rule and EVERY setting on the page by name on the
  server - CSV, no database (`SignalStrategyStore`, `{Storage:ScannerRunnerPath}/signal-strategies/strategies.csv`: id,
  name, owner, index, the Live / Alerts / Daily report switches, times, the settings as one JSON cell; `CsvTable` - one
  line a row, formula-safe cells, written whole and moved into place); "Saved strategies" card (`SignalStrategiesCard.jsx`,
  `signalStrategiesApi.js`): Load (onto the page), Update (with the page's settings), the switches, History, Remove (with
  its history); each account its own, an admin every account's (`SignalStrategyController`, `/api/signal-strategies`,
  Admin / User; `/live...` the Runner key only - `SignalStrategyStoreTests.cs` checks every endpoint's roles). The DAILY
  LIVE SCAN (`SignalLiveHostedService` keeps `scanner-runner/signal-live.mjs` running - bundled by `vite.live.config.js`,
  published beside the others; "SignalLive:Enabled"): each minute of the session (IST weekdays 09:16 - 15:59) for every
  index with a strategy on Live, today's run as OI Replay's live mode reads it (`forceLive` - the server's memory),
  CUT TO THE MINUTES COMPLETED at the clock (`completedRun` - the forming minute never counts) and prepared as the
  backtest prepares a past day (`prepareLiveDay`, from 5 minutes - `minMinutes`), each strategy's day so far with ITS
  OWN settings (`liveDayEvents` = `simulateDay` - the backtest's trades, paper): each trade's ENTRY at once and its EXIT
  once it has one (a trade the data ran out on - "Day end" - before 15:31 is still OPEN), each event keyed
  (date|rule-or-mirror|entry time|entry-or-exit) so the server keeps and sends it ONCE (`{id}-events.csv`; an entry
  first seen over 3 minutes late - a restart - says "seen late"); the TRADES HISTORY is written AS EACH SIGNAL COMES (asked
  for - "whenever you give signal it updates history"): every event carries its trade's row (`tradeRow` - the backtest
  CSV's columns plus `sl` / `target` PRICES from the entry premium, a bought option's stop under it and a sold one's over,
  '' = none, `status` open / closed and the trade's `key`) and the server (`KeepTradeRows`, in `KeepEventsAsync`) adds an
  entry's row OPEN and puts its exit's CLOSED row over it, by key - the History's Trades tab ("open" until the exit; a
  block a trade on a phone) reloads each minute while it is open and the strategy is on Live (a page timer, CSV only);
  from 15:31 the DAY'S REPORT once (`{id}-days.csv` a row a day, `{id}-trades.csv` the day's final rows put over them -
  posted again, the day's rows are replaced, the Telegram not resent). Telegram: each entry / exit when Alerts is on, the report when Daily report is on (HTML-escaped).
  An index whose day cannot be read is asked again later, the wait doubling 1 - 30 min (a holiday reads as one);
  yesterday's profile is asked once an index a day. The live day equals the backtest of that day up to the clock
  (`tests/signal-live.test.mjs` - read before, during and after each trade; the loop against a fake server: events
  once, the report after the close, nothing outside the session, a failing day backed off).
  LIVE DHAN ORDERS (asked for - "wire these strategies to actual trading on Dhan"; `SignalLiveOrders`): a strategy's
  "Live orders (Dhan)" switch (`liveOrders` in strategies.csv, the last column - a file without it reads as off) is an
  ADMIN's only (a User gets 403; `Update` refuses it for a scoped owner; a strategy is never SAVED armed; new settings
  saved by a non-admin turn it off), OFF by default, turned on through a "Place REAL Dhan orders" confirm on the card
  (off needs none), and needs Live on. The runner still places nothing and its Runner key still reaches no live-trading
  endpoint: each event carries its trade (`liveTrade` - key date|rule-or-mirror|entry ms, the TRADED index, the options'
  expiry from that index's day, strike, CE / PE, BUY / SELL, entry, entry time, the strategy's SL / target as premium
  POINTS from its entry, an exit's reason) and the SERVER acts on the events NEW to the store only
  (`KeepEventsAsync` -> `HandleAsync`, so a repeat / retry / restart never places or closes twice), for an armed
  strategy: ENTRY (the rule's and the mirror's) = `LiveTradingService.PlaceAsync`, a SUPER ORDER (LIMIT at the live ask /
  bid +- the Trade settings' slippage) of that option, LOTS = the traded index's TRADE SETTINGS lots, legs = the
  strategy's SL / target points (the Trade settings' where it has none - a super order needs both), no server trail, the
  server's 15:10 time exit behind it; NOT placed (kept and sent, with why) when seen LATE (over 4 min after its signal
  minute's start - the scan's "seen late"), its exit came in the same batch, another of its live trades has no exit yet
  (one at a time), its Max trades a day are placed, it is past 15:10, its option cannot be read, or Dhan / the kill
  switch refuse. EXIT (the strategy's own - trail, cost SL on spot / premium, time stop, day limits, SL / target, 15:10) =
  `ExitTradeAsync(entry's order ids, slippage, onlyWithWorkingLegs: true)`: the super order's working legs or a pending
  entry CANCELLED, then the filled quantity out at a LIMIT (nothing when Dhan's own leg closed it), its time exit
  cleared; done for an order already placed even after the switch is turned off; a failed exit goes to the time-exit loop
  at once (every 10 s, 30 tries). Every row in `history/{id}-orders.csv` (Dhan's order ids - an exit closes exactly its
  entry's orders, after a restart too; `price` / `sl` / `target` = the entry's LIMIT and its super order's stop-loss /
  target prices - `ManualOrderResult.Prices`; an exit's `price` = its LIMIT, or the leg's price when Dhan's own leg had
  closed it - `ManualOrderResult.ExitPrice` / `ClosedBy`, status "closed by Dhan's target"; `reason` = the strategy's exit
  reason, or why an entry was not placed - asked for: "history about order punched at what time, exit, SL, target price";
  Dhan's FILL prices come on its own order feed and are not in it) and the History's "Live orders" tab - ONE ROW A TRADE
  (`orderTrades` in `signalStrategyHistory.js`: punched at, entry, SL, target, exit time / price / why, "open" until it
  exits; a block a trade on a phone - `tests/signal-strategy-history.test.mjs`); every outcome to Telegram, whatever Alerts
  says. `SignalLiveOrdersTests.cs` (a fake Dhan behind `ISignalOrderGateway`), `tests/signal-live.test.mjs` (the payload).
- The Signal backtest's FEATURE FINDER (asked for - "we have plenty of information ... can we use machine learning to find
  the best correlation and create models?" - the first step: `featureFinder.js`, `FeatureFinderCard.jsx`, the page's
  "Feature finder" button beside "Compare all", on the days the run loaded - nothing loaded again): every reading the rule
  builder has (`FEATURES` - OI since open, Total OI and its 15-min change, the S-R walls ATM ± 1 / 2, 🎯, the CE / PE / Net
  cumulative Δ on their range, the OI / GEX walls and net GEX, the straddle vs its VWAP / decay line, price vs VWAP, spot's
  move, the day's range and the IB, yesterday's POC / VAH / VAL, pivot and CPR, RSI / EMAs, time of day, expiry) at the
  close of every candle of the timeframe in the entry window (`dayRows` - each read off the prepared day / `timeframeView`,
  so known at the candle's close: a day cut part way gives the same features, with and without the previous session -
  `tests/feature-finder.test.mjs`) - and, asked for ("add MACD, RSI, VWAP - all indicators ... capture all the data so we
  can feed it to machine learning"), the COMMON INDICATORS on the spot candles of the timeframe (`taIndicators.js` -
  TradingView's built-in definitions: MACD 12 / 26 / 9 line, histogram and its change in % of price, stochastic 14 / 3 /
  3, CCI 20, Bollinger %B and width (20, 2, population deviation), ATR 14 %, ADX 14 and +DI − −DI, SuperTrend (10, 3)
  direction and distance, RSI 7, EMA 50 / 200, the candle's body and range), warmed up on the previous session's candles
  of the same timeframe (`previousDayBars` keeps its highs / lows too) as the rule builder's RSI / EMAs are; price vs VWAP
  in deviations (`vwapSd` - the futures' volume-weighted), the candle's volume vs the day's average (`price.v`), the
  basis, the gap, where spot is in yesterday's range, the ATM CE / PE premium's own VWAP and RSI (`premiumCandles` /
  `premiumRsi`), the straddle's 15-min change, days to expiry and the weekday - 66 in all. Each indicator is held to
  values worked out by hand (a straight line, a steady trend, a zig-zag) AND to an independent Pine-style reference
  (`tests/ta-reference.mjs`) on random markets with gaps and flat stretches (`tests/ta-indicators.test.mjs`); the
  features to the reference on the warmed-up candles. Not in the rule builder (yet) - a reading that holds there is a
  rule's candidate for when it is. `LABELS` - what happened AFTER it: spot 15 / 30 / 60 min later, its highest / lowest
  over the next 30 min (none past the day's end), and an ATM (the page's moneyness) CE / PE BOUGHT or SOLD there with the
  page's SL / target / trail / time stop (`simulateTrade` - the backtest's own trade, return % of the entry, a sale's
  positive when the premium fell; `optionFor(dir, mode)`). `featureReport`: per feature, Spearman's rank correlation with the label picked on the
  EARLIER days (the first 2/3 of the dates) and on the LATER ones; HOLDS = the same sign and |later| >= `HOLD_IC` (0.05);
  how many later days agree on their own; the later days' top / bottom fifth (win % of the trades, or the average move);
  what holds first. Under 6 days there is no split (a warning); under 10 later days it says "a hint, not proof". "Dataset
  CSV" = the whole table (`rowsCsv` - a row a candle, a column a feature and a label) for a spreadsheet or your own model.
  Not in it: the order flow's footprint delta and the book heatmap (kept 30 days only) and the market profile's TPOs. It
  places nothing, feeds no strategy; a reading that holds is built as a rule and run through the backtest like any other.
  IN THE BACKGROUND (asked for - "this feature finder should also work on background jobs"): a background run has a KIND
  (`kind` - "backtest", the default, or "features"; `SignalBacktestJobService.Kinds`; a run saved before reads as a
  backtest). The queue dialog's "Backtest the rule / Feature finder" switch picks it; the page's Feature finder button with
  no days loaded, the card's "In the background · N days" and Run in background with no rule open it on Feature finder
  (it needs no rule). Up to 1 500 days: the job script (`BACKTEST_KIND=features`) loads each day as a backtest does (Σ 3
  expiries too; Trade in not used - the CE / PE are the index's own, as on the page), tries a day that failed on the way
  once more AT ONCE (after `BACKTEST_RETRY_PAUSE_MS`, 5 s - so the file stays in date order), writes each day's lines to
  `BACKTEST_CSV` as it comes (`csvHeader` / `csvLines`) and keeps only its rows as COLUMNS (`dayTable` - Float64Arrays;
  1 500 days of 1-minute rows are ~474 000 rows, ~250 MB of CSV, which as row objects did not fit), then every label's
  report from them (`featureReportsOfDays` - a feature's columns joined when read, the labels' once: ~2.5 min and ~550 MB
  at that size; `featureReport(rows)` is the same code on `dayTables(rows)`, held identical to the row-based one it
  replaced on a real 54-day CSV) - `{id}.features.csv`, kept and removed with the run, `GET
  /api/signal-backtest/jobs/{id}/features.csv` (its owner or an admin; the page's CSV button is a plain link, so the
  browser saves it straight to disk, never a blob in memory) - and the reports to the result; no table = the run failed. The list tags it "Feature finder" with its candles, days and
  how many readings held for CE buy / PE buy / spot 30m (`SummaryOf`); Open shows its report on the page
  (`StoredFeatureFinderCard` - the label switch works out nothing again), CSV downloads the table; Telegram "🔬 Feature
  finder done" with the held counts and the best reading for CE / PE buys. `tests/signal-backtest-job.test.mjs` (the job's
  CSV and reports = the page's for the same days), `SignalBacktestJobServiceTests.cs`.
- RESPONSES ARE COMPRESSED (asked about - "all the data is cached, why is it taking time?"; `HttpCompression`, Brotli /
  gzip at the fastest level, before the static files): a Signal backtest day (`/api/oi-replay/{u}/run`) is ~2.6 MB of JSON
  read from the disk cache in ~0.1 s, and was sent whole - a phone downloaded 150 MB+ for a 60-day run. Not compressed:
  `/hubs` (SignalR) and `/api/auth` (BREACH); zip / gzip / images are not in its types. A new STREAMING answer (server-sent
  events, a long poll that flushes) must stay out of it - `HttpCompressionTests.cs`. The run endpoint says where the day
  came from: `X-Dhan-Calls` (0 = the server's disk / memory) and `X-From-Disk` (every load is counted - a `LoadProgress`
  of its own when the page sent no progress id); the Signal backtest's run and a background run count their days from the
  server's disk / asked of Dhan / already in the tab (`daySource`, `loadSourceText`) - "60 days loaded in 45 s: 57 from the
  server's disk, 3 asked of Dhan (the first time - kept on the server now)" - and the runs list says how many days a
  running job asked of Dhan. The OI break reads are worked out once a completed bucket (`completedBuckets` - the same
  results, `prepareDay` a little faster on 3 / 5 / 15-minute buckets).
- The visitor log (admin-only Visitors page, `GET /api/system/visitors`): every page a browser opens - every account and
  visitors with no account (the login screen, `POST /api/auth/visit` from `visits.js`) - plus sign-ins, failed sign-ins and
  sign-outs, with the city / region / country of the connection (`VisitorLog`, `VisitRecorder`, one CSV file per IST day -
  `{yyyy-MM-dd}.csv`, a header row, formula-safe cells - under `Storage:VisitorLogPath`, 90 days; the page's Download CSV is
  `GET /api/system/visitors.csv`, admin only; Clear history is `DELETE /api/system/visitors`, admin only - it leaves one "cleared"
  entry naming who cleared it). NEVER store or show an IP address: `ClientAddress` gives the address only for the
  lookup (`GeoLocator` - DB-IP's free city database kept on this server under `Storage:GeoDbPath`, refreshed monthly by
  `GeoDbUpdater`, so addresses are never sent to any service) and the beacon's rate limit; `VisitorLogTests.cs` checks no address
  reaches the file.
- The admin CACHE page (`/cache`, `CachePage.jsx`, `cacheBrowser.js`; asked for - "a page to see all the cache files and
  manage them, I can delete ... delete folder"): the server's DATA CACHES only - data it can always fetch again
  (`CacheBrowser`, `CacheController` `/api/cache`, Admin only - `ADMIN_ONLY_PATHS`, ExternalAccess denies it by default):
  the Dhan data cache (`DhanDataCache.Directory` - v1/, nse/, scrip-master/; counted again after a delete - `TrimNow`), the
  Order Flow days (`OrderFlowDayStore.Root` - a delete drops its read-back copies, `ForgetLoaded`; today's file comes back
  at the next checkpoint), the Expired Backtest's CSVs (`HistoricalSpotDataStore.Folder`, `ExpiredOptionDataStore.Folder`).
  Settings, strategies, preferences, logs and the login keys are NOT caches and are not listed. Each cache's size / files /
  newest / oldest; open it and walk its folders (breadcrumb, Up; each folder with everything under it, counted on request
  and kept 30 s; what a known folder / file is - an Order Flow contract folder names its contract; Name / Largest / Newest;
  at most `MaxEntries` 2000 a folder listed); DELETE a file, a folder and everything in it, or everything in a cache (the
  folder kept) - each confirmed with what it removes; everything in a cache only with `all=true` (a request that lost its
  path never empties one). Every path is relative to its cache and checked: no "..", nothing absolute or outside the folder,
  NO SYMLINK FOLLOWED - one on the way is refused, one inside a folder being deleted is removed itself, never what it points
  at. Each delete is logged with who did it. DOWNLOAD (asked for - "option to download whole data as zip"): a FILE as it
  is (`GET /api/cache/{root}/download?path=`), a FOLDER or a whole cache (path '') as ONE ZIP, and EVERY cache in one zip
  (`GET /api/cache/everything.zip`, each cache its own folder in it - `AllFolders`) - buttons on each row, each cache's
  card, the open folder and "Download everything", every zip confirmed with its files and size (`downloadText`). The zip
  is STREAMED into the response as it is written (`CacheBrowser.WriteZip`, `ZipStreamResult`) - no temp file, so a 10 GB
  cache needs no disk; gzip / zip files are STORED (already compressed), the rest deflated fast; `.tmp` files (a write in
  progress) and symlinks are left out, a file busy or gone on the way skipped; the same path checks as a delete; the browser's
  stop ends it (`RequestAborted`). On a phone the cards' buttons sit in their body, not beside the title (they squeezed
  the folder's trail to nothing). No timer - loaded on opening, after a delete, by Refresh; a block an entry on
  a phone (`CacheBrowserTests.cs`, `tests/cache-browser.test.mjs`).
- ORDER FLOW in real time (`OrderFlowEngine`, `OrderFlowService`; the strategies read its pushes). Dhan sends a tick per
  UPDATE, not per trade - there is no time & sales feed: a trade is the rise in the day's running volume between ticks, at the
  tick's last price, its aggressor side by Lee-Ready: the quote rule against the PREVIOUS MARKET FEED PACKET's best bid / ask
  (asked for - "match Dhan's delta": the same socket as the trade, so always the book before it. Against the depth sockets the
  side turned on which socket won: a seller who took the bid and left the rest as the new offer read as a BUY when the new
  book came first - the trades that move the market, cancelling real delta), midpoint, tick rule; a crossed or locked book
  (bid and ask are separate depth packets) never decides (it read as a buy). No market feed quote in the last `QuoteMaxAge` 3 s:
  the depth sockets' quotes (`QuotesAsOf`). Dhan's packets carry no side and Dhan does not publish how its chart gets one, so
  no rule is known to equal it: every bar also tallies the other candidate rules (`DeltaRules`, `RuleCount` - depth sockets,
  the trade's own packet, tick rule - kept in the day's file, `/api/order-flow/{u}/delta-rules`), shown on the Order Flow page's
  "Delta rules" card (folded, `OrderFlowDeltaRules.jsx`, Dhan's "K" format) to set against Dhan's candles before changing the
  rule. DHAN'S MARKET FEED IS A SNAPSHOT ABOUT ONCE A SECOND, not a packet a trade (Dhan's support page; its API docs say
  "tick-by-tick event based") - the Full packet carries LTP, LTQ (the LAST trade's quantity only), LTT (whole seconds), ATP
  (float32 - too coarse to recover a second's average price), the day's volume, the book's total buy / sell QUANTITY (resting
  orders, never trades - not read as delta), OI and 5 levels; the 20 / 200-level depth feeds (NSE only; 200 = one instrument a
  socket) carry the book alone, no trades. So one packet's volume is often many trades, at several prices, both ways, and
  the rule in use gives ALL of it its last trade's side and price. The comparison rule "LTQ + book" (`RuleLtqBook`,
  `LtqBookDelta` / `BookTaken`, the card's own column; a day saved before it keeps the other three and shows "—"; a minute
  restored from such a checkpoint and traded on shows none) gives only the last trade (the LTQ, held to the packet's volume)
  that side and splits the rest of the second by what was TAKEN off each side of the PREVIOUS market feed packet's 5-level
  book (`_feedBids` / `_feedAsks`, fresh as the quote): ask levels the new best ask moved past plus the drop at it = bought,
  the bids the mirror = sold (pulled orders count too - an estimate), else by the price's move, else half and half. It is
  a comparison only - the footprint stays on the rule in use until it is chosen against Dhan's candles. A trade with NO side
  known yet (before any trade of the engine had one - no quote, an unchanged price) is NEUTRAL: half buy, half sell in the
  bars, no tape print, no iceberg read (it started as a buy - `_lastSide` was 1). `OrderFlowLtqBookTests.cs`. A trade's BAR is the exchange's last trade time, as Dhan's candles, or arrival when that is over `MaxFeedLag` 5 s away (a
  stale time); the tape and sweeps stay on arrival (they need the milliseconds). A packet behind the last moves neither the
  price the tick rule reads nor the quote. EVERY
  tick (`SpotTick.ReceivedAt`, stamped on the market feed's receive loop) and depth packet (stamped on its socket's loop) goes
  into ONE inbox (`LiveEventQueue`, the tick consumers' own queue, made generic) and ONE worker applies them in arrival order
  - a depth socket's receive loop never takes an engine's lock. The inbox's
  delay is in the header's feed health ("Order flow"). A NEW FEED CONNECTION (`SpotTick.FeedSession`, bumped on every connect
  and every re-subscribe of a silent feed): the volume since the last tick traded while the feed was away - counted
  (`Meta.UnbookedVolume`, an info line on the Order Flow page), NEVER booked as one giant print (it read as a huge "big
  order" / sweep). Dhan's volume baseline only moves FORWARD (a packet a little behind - out of order - booked its step
  twice), except a new connection or a real reset (under half - `ADroppedVolumeResets...`). Volume outside 09:15 - 15:30 IST
  (`MarketHours.InSessionHours` - any day a tick comes, a special Saturday session too) only moves the baseline. READERS
  never hold the tick path: `Snapshot` / `ExportDay` copy the day under the lock (each minute bar's FROZEN levels - made once,
  dropped by the next trade into that bar - the prints, the heatmap samples) and build outside it (a full day's page load
  held every tick ~75 ms; now ticks wait < 0.1 ms at p99 during loads); book lookups for icebergs are indexed (a 200-level
  scan each was most of an event's cost); the tape is trimmed in chunks (`TradesTrimChunk`). `OrderFlowRealtimeTests.cs`.
  DELTA = a bar's aggressor buy - sell volume; CUMULATIVE DELTA = its running sum from the session's first bar (the Order
  Flow page's chart and header, OI Replay's futures delta panes, the footprint's ΣΔ). A live day the server started
  recording part way: the minutes before come ESTIMATED (`OrderFlowEstimator` - bulk volume classification, Phi(change /
  typical change), the typical change the root mean square of the changes UP TO that minute, `TypicalChanges` - it was the
  whole day's: a replayed minute depended on the afternoon after it, a live morning shifted at every load) and lead the
  charts (`withBackfill`, drawn faded): on a 3 / 5 / 15-minute timeframe those in the first recorded candle before its
  first recorded minute count too (`firstMinuteMs` - they were dropped from the delta from the open). The strategies read
  exact bars only (relative CVD moves). OI Replay's futures delta panes are LIVE: the "orderFlowDelta" push (group
  `ofd:{U}` - `OrderFlowService.DeltaGroup`, `OrderFlowEngine.LiveDelta`: the last two minutes' buy / sell, a few bytes;
  External may not join it) merged as the minutes trade (`mergeDeltaPush`; a missed minute / another contract or day
  loads the day again, once) - they reloaded the whole day every 60 s. `tests/cvd-backfill.test.mjs`. The Order Flow
  page's footprint "Delta per row" tick (`rowDelta`, `optionanalytics.orderFlow.rowDelta`, off by default - the cells as
  they were) adds a third column to every row: its buy - sell, green / red, shaded against the bar's largest (`rowDeltas`).
  AUCTIONS (the "Auctions" tick, on by default, `optionanalytics.orderFlow.auctions`; every footprint - the OI Replay
  review's too): each bar's high and low read on its sell (bid) x buy (ask) rows (`auctionOf`, in `analyzeBars`) - FINISHED
  (FA) = no selling at the top row (0 x N) / no buying at the bottom row (N x 0): that side ran out; UNFINISHED (UA) = both
  sides traded at the extreme - a dotted line runs on until a later bar trades back into that row (`unfinishedRevisits`),
  to the right edge while open; the other side alone there = neither. Not on an estimated day (its rows are a spread, not
  trades). `tests/order-flow-auction.test.mjs`.
  RECORDED DAYS ON DISK (`OrderFlowDayStore`, `Storage:OrderFlowPath` - /app/data/order-flow, in docker-compose AND the
  Dockerfile; none = memory only): the days the server recorded live replay EXACTLY - footprint, imbalances, stacked
  imbalances, auctions, tape, book - through a restart / deploy (they lived in memory only, so after every deploy a past day
  came back as the candle estimate, which has no imbalances at all). One gzip JSON per contract and day
  (`{UNDERLYING}/{securityId}/{yyyy-MM-dd}.json.gz`, heatmap rows as [row, qty]; ~4 MB a full day), the newest
  `OrderFlow:DaysOnDisk` dates (30) kept; written on ONE background queue (never on an engine's lock or the tick path), a
  day read back kept for the next asks. TODAY is checkpointed every `CheckpointInterval` (5 min) and at shutdown, and a new
  engine starts from it (`NewEngine` -> `ImportDay`): a deploy mid-session keeps the morning exact - only the minutes the
  server was down are missing, and the first tick after sets a new baseline (no giant print). `OrderFlowDayStoreTests.cs`.
  The live push carries only the engine's last two minute bars, so a page (or the server scanner) that missed a minute -
  a phone asleep, pushes skipped, the connection down and back - LOADS THE DAY AGAIN (`orderFlowPushGap`; the Order Flow
  page also on every hub reconnect, once a load is not already on its way): it used to fold in what came next and keep a
  hole in the footprint, the cumulative delta and the tape until a manual reload (`tests/scanner-runner.test.mjs`).
  Alerts / the scanner may lag the pushes; the ticks are applied as they arrive. The live push still carries the last 40
  prints: a client that skips pushes for several seconds (a slow phone - the conflated batcher) can miss prints in its tape
  (bars are whole; the server scanner is local and does not).
  ON A PHONE (asked for - "order flow is not mobile supportive"): the page is never wider than the screen
  (`.oa-of-page { overflow-x: clip }` in `index.css`) - the footprint legend's longest line did not wrap, the page came out
  wider than a phone, and iOS drew the WHOLE page shrunk with the ☰ off its edge; legend items now wrap inside the card.
  Under 640 px (`useNarrow`) the less-used settings (imbalance, stack, big order, iceberg Telegram, the switches) fold
  behind "Settings ▾" and the footprint legend to one line ("▸ Legend"), both remembered (`optionanalytics.orderFlow.
  settingsOpen` / `legendOpen`; a wide screen shows both always); the page's side padding is 8 px; inputs are 16 px
  (iOS zooms in on a smaller one when tapped and stays zoomed). The footprint's narrow mode (its own width < 640) draws
  big-order bubbles smaller (3 - 10 px radius - a 30 px one hid a phone's 28 px cells) and the profile levels' labels on
  a dark backing (they ran over the narrow profile's bars).
- The BACKTRACK page (`/backtest`) was removed on request, page and server endpoints (an old bookmark goes to the
  dashboard). `BacktestService` and its `IBacktestStrategy` strategies STAY: they are what the armed Triggers run
  (`StrategyTriggerHostedService` - `RunStrategy` / `ReplayForStrategy`, in memory) and their list is
  `GET /api/triggers/strategies` (admin, the Triggers page). The Expired Backtest and Signal backtest pages are separate.
- Live order placement only ever happens behind the explicit, confirmed "Auto-place on alert" switch in
  Live (Dhan) mode, or a saved Signal strategy's admin-only, confirmed "Live orders (Dhan)" switch (`SignalLiveOrders`);
  alerts and the default auto trade are paper.
