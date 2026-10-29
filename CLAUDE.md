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
  index with no page open (`IndexScanner.checkOiBreaks`, Telegram tagged [Server]). They are the APP'S alerts: Telegram
  (the server's, and the page's own when the server is not covering) only when the OI totals card's "Telegram" switch is
  on (`config.oiBreakAlerts.telegram`, OFF by default - a config saved before the switch has none and reads as off; the
  card then says "In the app only"); the server still lists what it raised for the page, and the switch does not restart
  its watch. On the page they are run by the PAGE
  (`useOiBreakAlerts` + `useOiBreakAlertSettings` in `OiReplayPage`), not by a card - a card scrolled off-screen stops
  re-rendering (`LiveSection`) and a hidden one is not there, and both used to silence them; the "OI totals" card
  (`oiTotals`: the CE / PE / Net Δ and cumulative Δ table, Charts, the bucket the alerts read and these settings -
  `OiChangeHeatmapSection show="totals"` with the page's `alerts`; the heatmap card is `show="strikes"`, no alerts) only
  shows the settings. A PAST DAY REPLAYED raises them too, on the replay's clock (`stepReplayOiBreakAlerts`: the end of
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
  At 768 px and under there is no sidebar: the ☰ drawer and the header row's status, as before. OI Replay's controls
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
  and every table box (`CardFitBox`: the ladder, the liquidity map, GEX by strike - the box scrolls inside, the card does
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
  whose numbers all appear on the cards below them; both are one tick away in "Sections shown".
- OI Replay's QUICK VIEWS (`quickViews.js` - `QUICK_VIEWS` / `quickViewForKey`): a popup for a quick scan of one card -
  Ctrl + Shift + 1 Day OI since the open, 2 the OI totals charts (CE / PE / Net), 3 the OI change heatmap and totals,
  4 the option premium charts (ATM by default), 5 the ATM straddle, 6 GEX, 7 the futures chart (top row or numpad; the same again or Esc closes,
  another digit switches; Ctrl + Shift because the browser keeps Ctrl + 1 - 8 for its tabs), or the "Quick view" buttons
  under "Sections shown" - shown even when the card is hidden. The popup renders the card's OWN content (the page's
  `dayOiContent` / `premiumPickers` / `premiumCharts` elements, `OiChangeHeatmapSection` with no `alerts` - so no
  second set of alerts - `StraddleCard`, `GexCard` on the shared `useGexDays`, `OiTotalsChartsPopup`, the futures card's `futuresControls` / `futuresContent` -
  its DOM button stays on the card), live with the page
  (`tests/quick-views.test.mjs`). On a phone / touch screen (no keyboard, a long page) a small floating button
  (`QuickViewFab.jsx`, 40 px) opens them: dragged anywhere (kept on the screen; where it was left is remembered), a tap
  opens the seven views as small labelled icons (up or down, wherever they fit), a tap on one opens its popup. It shows on
  EVERY screen now (it saves the same scrolling on a monitor) - the page's "Quick button" tick turns it off.
- OI Replay's keyboard order ticket (B / F1 buy, S / F2 sell) is not taken from a box being TYPED in (`isTypingField` in
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
- The PROFILES page (`/profiles`, "Volume & Market Profile" - `ProfilesPage.jsx`, `profileZones.js`, `profilePrimitives.js`): a
  row of two cards (`ProfilePair`) for the index's SPOT and one below for its near FUTURES, each over its own candles (timeframe
  1 - 30 min, profile row per index - `PROFILE_ROWS`), with the day's VWAP on every chart ("VWAP" tick, on by default - typical
  price x volume over the 1-minute bars as `VwapCalculator`, `sessionVwapFromBars` + `alignToBars`). FUTURES: the Order Flow
  server's futures day (`/api/order-flow/{u}/day/{date}`, fetched in the footprint's row - `FETCH_ROWS` - and re-bucketed, so a
  row change asks nothing). SPOT: the index's 1-minute bars WITH its own volume (`GET /api/oi-replay/{u}/spot-day` -
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
  `optionanalytics.profiles.speedMs`), Go to (a minute, shown), the slider - each labelled by the minute it shows. VOLUME PROFILE: POC / VAH / VAL lines, the bars
  at the right (`VolumeProfilePrimitive`), and BOXES (`volumeZones`): busy areas (smoothed row >= 1.3x the mean - each with its
  HVN, the POC's marked) and thin areas INSIDE the range (<= 0.6x - each with its LVN; a thin run at the top / bottom row is
  the day's edge, not a gap). MARKET PROFILE: the TPO letters at the right (`TpoProfilePrimitive`, A = 09:15, blocks when rows
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
  own slider / play. NO LOOK-AHEAD: a minute counts once it has COMPLETED at the clock (`barsKnownAt`, session minutes only).
  It does not touch `profiles.js`' scanner rules (`profileNodes`, `lvnRun`) - `tests/profile-zones.test.mjs`.
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
