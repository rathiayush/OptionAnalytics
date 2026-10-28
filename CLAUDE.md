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
  reading's OI as standard, then each minute's OI change adds -|change in OI| x sign(change in premium); both are worked
  out always and a line says whether their regimes agree (`gexAgreement` - agree = act on it, disagree = unclear; the other
  sign is worked out with `flips: false`, its flip left out). Levels, as the GEX tools publish them (SpotGamma, MenthorQ,
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
  check was removed on request.)
- OI Replay's DASHBOARD (`dashboardLayout.js`, `DashboardGrid.jsx`, `DashboardCard.jsx`, the `.oi-dash-*` rules in
  `oiMobile.css`): on a wide screen the cards are a FREE 12-COLUMN GRID (`react-grid-layout`, its legacy API) - any card
  dragged by its ⠿ grip to any place, resized from its bottom-right corner. Each is `{ i, x, y, w, h }`, h in grid ROWS
  (`GRID_ROW_HEIGHT` + `GRID_MARGIN` each - `rowsToPx`), saved whole in `STORED_LAYOUT`. The model is all pure functions
  (`defaultLayout` / `reconcileGridLayout` / `presetLayout` / `isDefaultLayout` / `contentHeight`,
  `tests/dashboard-layout.test.mjs`); the dragging, collisions and packing are the library's. Dragging starts ONLY from
  `.oa-dash-grip` (`draggableHandle`) - otherwise scrubbing a chart would move its card. "Cards a row" 1 - 4, "Reset",
  and "Free placement" (`compactType` null + `preventCollision`: a card stays exactly where it is dropped, gaps and all;
  off, the cards pack upwards). "Arrange" only outlines the grid - dragging works either way.
  UNDER `WIDE_LAYOUT_PX` (1100) THERE IS NO GRID AT ALL: `DashboardGrid` stacks the cards full width at their own height,
  as the page always did, so a layout dragged out on a monitor can never leave a phone with a sliver of a chart.
  In the grid EVERY card has a height and scrolls inside it (`.react-grid-item.oa-dash-card { overflow: auto }`); the
  charts already follow their container's WIDTH (each has a ResizeObserver), and the spot / entry charts follow the
  card's HEIGHT too - `useCardContentHeight`. `useCardOrder` is still read on this page, but only to SEED the default
  layout's order - nothing drags through it any more. "Compact" hides the cards' long explanatory paragraphs (the
  `oa-note` class). The WHOLE structure is saved, not just the grid: which cards are shown too (`STORED_SECTIONS`,
  `reconcileSections` - anything saved that no longer exists is dropped, and an empty set falls back rather than
  leaving a blank page), and the page starts on `DEFAULT_SECTION_VALUES` - every card but Snapshot and Market Read,
  whose numbers all appear on the cards below them; both are one tick away in "Sections shown".
- OI Replay's QUICK VIEWS (`quickViews.js` - `QUICK_VIEWS` / `quickViewForKey`): a popup for a quick scan of one card -
  Ctrl + Shift + 1 Day OI since the open, 2 the OI totals charts (CE / PE / Net), 3 the OI change heatmap and totals,
  4 the option premium charts (ATM by default), 5 the ATM straddle, 6 GEX, 7 the futures chart (top row or numpad; the same again or Esc closes,
  another digit switches; Ctrl + Shift because the browser keeps Ctrl + 1 - 8 for its tabs), or the "Quick view" buttons
  under "Sections shown" - shown even when the card is hidden. The popup renders the card's OWN content (the page's
  `dayOiContent` / `premiumPickers` / `premiumCharts` elements, `OiChangeHeatmapSection` with no `alertUnderlying` - so no
  second set of alerts - `StraddleCard`, `GexCard` on the shared `useGexDays`, `OiTotalsChartsPopup`, the futures card's `futuresControls` / `futuresContent` -
  its DOM button stays on the card), live with the page
  (`tests/quick-views.test.mjs`). On a phone / touch screen (no keyboard, a long page) a small floating button
  (`QuickViewFab.jsx`, 40 px) opens them: dragged anywhere (kept on the screen; where it was left is remembered), a tap
  opens the seven views as small labelled icons (up or down, wherever they fit), a tap on one opens its popup. It shows on
  EVERY screen now (it saves the same scrolling on a monitor) - the page's "Quick button" tick turns it off.
- OI Replay's Option CDV / OBV card IS the dashboard's: today, live, its own series (`dashboardFlow.js`); a past day, worked
  out from the day's 1-minute option bars with the server's formulas (`optionFlow.js` = `CdvUnderlyingState`: CDV weighted
  by each minute's spot, bar-proxy delta; OBV weighted by the LATEST spot - the replay clock's - rebased to the day's first
  minute, EMA 9). CDV is drawn raw like the dashboard's chart ("Smooth CDV (EMA 9)" checkbox for the Pine look). One fixed
  day is held to the same numbers on both sides (`CdvParityTests.cs`, `tests/option-flow.test.mjs`) - change one, change both.
- OI Replay's paper trade panel (`paperStops.js`, `paperExit.js`): each position keeps the levels it was punched with (the
  panel's, or the keyboard ticket's) in its `levelLog`; a panel change (once it has settled a second - typing 25 passes
  through 2) reaches the OPEN positions of THAT index only, from the minute it is made (`withPaperLevelChange`): a minute is
  judged with the last change made in it or before, so the minutes already passed are never judged again. In the minute of
  the entry or of a change only the point's own price counts - its high / low partly came before it (live, the forming
  minute's range holds the ticks before the entry). The trailing stop only tightens: what a bar earned is kept through a
  change of the trail (wider, or off). A long log folds into `checkpoint` (the server keeps a position to 4 KB). A No SL
  position is squared off at 15:15 (`tests/paper-stops.test.mjs`). Each position keeps its entry and exit time (`entryTime` /
  `exitTime`, shown HH:MM:SS under its prices): the clock at a punch or a manual exit (live, to the second); an auto exit's
  the second it was seen live, else the minute it hit in (`paperExitTime`, `tests/paper-exit.test.mjs`).
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
