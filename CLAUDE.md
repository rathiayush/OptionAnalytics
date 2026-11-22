# OptionAnalytics - notes for every session

## The strategy scanner was removed (on request)

The Order Flow page's strategy scanner - its strategies, paper / live auto trades, alerts, the server-side
strategy scan, the scanner log (`/api/scanner-log`) and the Strategy tuning page - was removed, code and tests
(asked for - "Order flow page strategy and its code, alert and server scan, remove all"). What it shared and the
rest of the app still reads was kept:

- `oiContext.js` - `buildOiContext` (no look-ahead: a replayed day's context is built with `{ live: false }`, points
  read at their minute's END; only today's live context, `live: true`, reads the running minute), `oiBiasParts`,
  `oiSummary`, `suddenOiWalls`, `optionOiRead`, `vwapOf` - for `useDayOi.js`, the Order Flow page's bias / OI summary /
  sudden walls and the server alert runner (`tests/options-oi.test.mjs`);
- `PAPER_TRADE_LOT_SIZE` in `tradeDefaults.js`;
- THE SERVER ALERT RUNNER (`optionanalytics.client/scanner-runner/runner.mjs` + `indexScanner.mjs`, bundled by
  `npm run build:runner`, started by the server's `ScannerRunnerHostedService`, config / status at
  `/api/scanner-runner/...`): ALERTS ONLY now - the OI totals S/R break / 🎯 alerts and the profile-level alerts for
  every index switched on (Trade settings' "Server alerts"), no page open (`tests/scanner-runner.test.mjs`,
  `tests/oi-break-alerts-server.test.mjs`). Its "Runner" role cannot reach the live-trading API;
- the page alerts' switches - pop-ups, sound, speak, Telegram - are the Order Flow page's "Alerts" card
  (`AlertSwitches.jsx`, `alertSwitches.js`, the old scanner card's localStorage key so what a browser had set still
  holds; an admin's Telegram switch also goes to the alert runner) - read by the sudden OI walls, profile / price
  alerts and OI Replay's OI break / zone alerts (`tests/alert-switches.test.mjs`).

The Trade settings CSV keeps its old `auto_trade` column (read and written, used by nothing) so a saved file stays
valid. After any client change:

```
cd optionanalytics.client
npm test
npm run lint
npx vite build
npm run build:runner
```

All must pass before committing.

- **Option trades** (the OI Replay paper panel, the Signal backtest): their own SL / target are checked from the first
  full minute after the entry, at the level - but a minute that OPENS through the stop fills at its open (a gap), one
  with no open whose whole range is past it at the nearest price it traded, a target always at the target (`gapFill`
  in `optionTrail.js`); a SL / target / trail change applies to open trades only, FROM the minute it is made
  (`levelLog`) - what already passed is never rewritten and a trailing stop is never loosened by a change.

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
  hosted service's loop runs in `MarketHours.BackgroundScope()`, as do the server alert runner's requests and a page's TIMER
  refreshes (the `X-Poll` header - `POLL_HEADERS` in `shared.jsx`), and `DhanApiClient` does not send a background polling
  call (positions, orders, the option chain / OI, quotes - everything but `/charts/...`) outside the window; the positions /
  orders refresh and the kill switch check also skip their rounds (`MarketHours.IsOpen`). Candle backfills (`/charts/...`)
  are not polling and go at any hour, as do a page's first load or a click - EXCEPT `/charts/intraday` from 20:00 to 08:00 IST
  (asked for - "charts intraday call should not go after 8 pm and should start at 8 am"; `Dhan:IntradayQuietHours`
  "20:00-08:00" in appsettings.json, `MarketHours.IntradayQuietReason` in `DhanApiClient`): not sent at all, whoever asks
  (a page, a hosted service, the server alert runner) and for any day - it comes back "Not sent" (logged at Debug), is never
  kept on disk (a failure), so a past day not on disk loads from 08:00; the other candle downloads still go; no setting =
  none held (the tests' `DhanOptions`); token renewal has its own HttpClient. A new hosted service or page timer must do the same (`MarketHoursTests.cs`). What reached Dhan in the last 15 min: `GET /api/system/dhan-calls` (admin). `GET /api/oi-replay/{u}/run?forceFetch=true` (the OI Replay page's "Force fetch from Dhan" tick) skips the saved days -
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
  (`stepOiBreakAlerts`): the OI Replay page while it is open (pop-up, chime, voice) and the server alert runner for every enabled
  index with no page open (`IndexScanner.checkOiBreaks`, Telegram tagged [Server]). They are the APP'S alerts: Telegram
  (the server's, and the page's own when the server is not covering) only when the OI totals card's "Telegram" switch is
  on (`config.oiBreakAlerts.telegram`, OFF by default - a config saved before the switch has none and reads as off; the
  card then says "In the app only"); the server still lists what it raised for the page, and the switch does not restart
  its watch. On the page they are run by the PAGE
  (`useOiBreakAlerts` + `useOiBreakAlertSettings` in `OiReplayPage`), not by a card - a card scrolled off-screen stops
  re-rendering (`LiveSection`) and a hidden one is not there, and both used to silence them; the "OI totals" card
  (`oiTotals`: the CE / PE / Net Δ and cumulative Δ table, Charts, the bucket the alerts read and these settings -
  `OiChangeHeatmapSection show="totals"` with the page's `alerts`; the heatmap card is `show="strikes"`, no alerts) only
  shows the settings. After the OI net rows - LIVE and on a REPLAYED day (asked for - "in replay also show the futures
  cumulative delta if present, check cache first") - the card (Numbers and Heatmap, and the N quick view) adds the near
  futures' ORDER FLOW in the same buckets (asked for - "order flow's delta and cumulative delta after the OI net cumulative,
  per 3 min"): "Futures Δ (buy − sell)" = each bucket's aggressor buy - sell volume, "Futures cumulative Δ" = from the
  session's first minute (the Order Flow page's / futures panes' CVD) - `withOrderFlowRows` in `oiTotalsHeatmap.js` on the
  page's `futuresFlow` minutes (loaded live whatever the futures chart's Δ / ΣΔ switch, kept up to date by the
  "orderFlowDelta" push), a minute counted once the clock reaches it, the newest column the bucket still trading; green
  buyers ahead / red sellers, the shade what the bucket did; estimated minutes (a day recorded part way) italic / faded.
  A replayed day reads the same `/api/order-flow/{u}/day/{date}` the futures chart's Δ panes do - the server's own order:
  its RECORDED day first (memory, then `OrderFlowDayStore` on disk - exact), else the estimate from the day's 1-minute
  futures candles, which the run already put on disk (`PastFuturesCandles` - the same files, so no Dhan call), marked
  estimated throughout; none (a 404 - the server could not read the day's candles either - or a day with no minutes) on a
  REPLAYED day = the run's OWN 1-minute futures candles estimated the server's way (asked for again - "if the futures
  cumulative delta is present in replay show that as well"; `estimateFlowMinutes` in `cvdBackfill.js` = `OrderFlowEstimator`:
  bulk volume classification, Phi(change / RMS of the changes BEFORE the minute, seeded), buy in whole lots - `runFlow`, the answer
  kept as `{ failed: true }`), marked estimated ("from the day's 1-minute futures candles"); never live. Loaded on a replayed day while the totals are on screen (the card or the N
  quick view) or the panes' Δ switch is on (`futuresFlowWanted`), once a day - no timer; the minutes up to the replay clock
  (the minute shown counted whole, as the OI points and the panes are). Not on the External page (it passes no flow) -
  `tests/oi-totals-heatmap.test.mjs` (a cut at any clock = the whole day's for every bucket finished). A PAST DAY REPLAYED raises them too, on the replay's clock (`stepReplayOiBreakAlerts`: the end of
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
- OI Replay's VWAP ± 2σ BANDS (asked for - "vwap +2 deviation as well ... visible only when it is ticked"): the "VWAP ±2σ"
  tick beside VWAP (`optionanalytics.oiReplay.vwapBands`, OFF by default) draws VWAP +/- 2 x the session's VOLUME-WEIGHTED
  standard deviation of the typical price - sqrt(sum(v x tp^2) / sum(v) - VWAP^2), restarting each IST day, as TradingView's
  VWAP bands - dashed, on the spot, both entry charts and the futures chart (`chartVwapBands` / `sessionVwapSdFromBars` /
  `vwapBandLines` in `chartVwap.js`, `VWAP_BAND_K` 2). The spot's bars carry no volume on the page, so the SERVER sends the
  deviation at the VWAP's points (`VwapCalculator.ComputeSdSeries` / `Last`): a run's `spotVwapSd`, live `GET
  /api/spot/{u}/vwap-sd-series` (the feed's memory) grown by `spotUpdate`'s `vwapSd`; the futures chart works its own out
  from its 1-minute bars. Nothing after the replay clock (`shownVwapSd`). `tests/vwap-bands.test.mjs`,
  `VwapCalculatorTests.cs`. Drawing only.
- OI Replay's ABSORPTION / EXHAUSTION BY OI on the spot chart (asked for - "absorption and exhaustion by OI on spot ...
  when this checkbox is ticked show, otherwise hide ... select the timeframe on which it will identify"; `oiAbsorption.js` -
  `oiAbsorptionEvents` / `absorptionMarkers`): the spot card's "Absorption / exhaustion (OI)" tick
  (`optionanalytics.oiReplay.oiAbsorption`, OFF by default - off nothing is worked out or drawn) and its own timeframe, 1 /
  3 / 5 / 15 min (`optionanalytics.oiReplay.oiAbsorptionTf`, 5 - the chart's candles may be another): each COMPLETED candle
  of it (live, the forming minute left out; replayed, nothing after the clock) against the option OI written near the money
  in it (ATM ± 2 strikes of the candle's close, the same strikes at both ends; with Σ 3 expiries the summed OI) - Wyckoff's
  effort vs result. ABSORPTION: heavy OI on one side (>= 2x a typical candle's - the larger side's |change| averaged over
  the candles before it) and ahead of the other, while the body stays under half a typical range - puts written = bullish
  (▲ ABS under the candle), calls = bearish (▼ over it). EXHAUSTION: a new 10-candle high on the band's OI falling (>= 0.5x
  typical) with no puts written = bearish (▼ EXH - the rally is covering), a new low with no calls written = bullish (▲).
  From the 6th candle; each read from readings up to its candle's end, so a candle's read never changes. Markers on the spot
  chart's own candle holding the read's last minute (`ReplayChart`'s `markers` - the External page passes none), and a
  folded line under the chart (the last read; opened, the day's). It feeds no strategy or alert
  (`tests/oi-absorption.test.mjs` - each read on its case, both sides, not without each part, the timeframes, a cut part
  way = the whole day's up to it).
- OI Replay's ATM straddle card (`StraddleCard.jsx`, `straddle.js`) draws the two straddle charts the option tools draw
  (Sensibull's "Auto ATM" and a fixed strike), each against the VWAP of its combined premium from a set time (09:15 by
  default, "From"): AUTO ATM - the strike nearest the expiry's futures price (a weekly has none: the synthetic one,
  strike + call - put over the 3 strikes nearest spot), switching from the minute it changes; its strike switches are NOT marked (they were - arrows and "ATM 25050" tags - and were removed on request: "this looks messy ... just remove this"). THE STRADDLE'S TREND (asked for - "check how professional systems use straddle to identify trend change"; `straddleTrend` in `straddle.js`, `STRADDLE_TREND_DEFAULTS`): the straddle-chart tools (AlgoTest, Tradejini, Fyers, the TradingView straddle-premium scripts) read the COMBINED PREMIUM against its VWAP and confirm with a fast / slow EMA cross on it - TRENDING = the Auto ATM straddle over its VWAP AND its EMA 9 over its EMA 21 (premium expanding - the market pays for a move), SIDEWAYS = under its VWAP AND EMA 9 under EMA 21 (premium melting - sellers in control), anything else MIXED changes nothing; a CHANGE counts once the new state holds 3 minutes (none before the slow EMA's 21 minutes), dated the minute it is confirmed; a trend's DIRECTION = the synthetic futures over the last "Read over" minutes (>= 0.02% of it), a direction that turns and holds 3 minutes in a trend is a change too. On the card: a "Trend (straddle)" line over the chart (the state, since when, what it was; the rule in its tooltip), marks on the Auto ATM line at confirmed changes ONLY and NO text (▲ green trend up, ▼ red trend down, ● grey back to sideways) and "Trend changes: 09:37 Sideways → 11:34 Trending ↓ …" under it (the latest 6). Each minute from the minutes up to it - a cut at the clock = the whole day's up to it (`tests/straddle.test.mjs`). The read above it (sideways / building / trend / breakout / fake vs the priced range) is unchanged; FIXED - the start's ATM or
  a strike picked on the card, kept all day and NEVER shifted (an adjustment is the trader's, not the chart's), with what
  a seller of it has made. The range the options priced at the start: by default ("Range: Today") the ATM strike ±
  today's share of the straddle - straddle x sqrt(trading minutes left today / trading minutes left to the expiry, the
  run's `optionExpiry` - the sessions in between are weekdays less NSE's F&O TRADING HOLIDAYS (`marketHolidays.js`,
  `isFoSession` - NSE's 2025 and 2026 lists; ADD THE NEXT YEAR'S each December, a year not listed counts every weekday;
  `tests/market-holidays.test.mjs`); on expiry day the straddle itself - the straddle prices the move to EXPIRY); "To expiry" = strike
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
- OI Replay's VOLATILITY SKEW card (`VolSkewCard.jsx`, `volSkew.js` - the smile, RR25 / BF25, the read against price) was
  REMOVED on request ("remove IV skew ... we do not need it"), code and tests: a saved "Sections shown" or layout naming
  `volSkew` just drops it (`reconcileSections`); `SECTION_ADDITIONS` has no version 6 any more (`SECTIONS_VERSION` stays '7').
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
  NSE POSITIONS AS THE SIGN (asked for - "check how institution based GEX works ... work on item 1": who the dealers are,
  from data; `participantOi.js`, `NseParticipantOi`): the Standard sign ASSUMES dealers long every call, short every put (the
  US convention). NSE publishes each evening who holds the index options - calls and puts LONG and SHORT by Client / DII /
  FII / Pro (fao_participant_oi_{ddMMyyyy}.csv on nsearchives, in contracts): `GET /api/oi-replay/participant-oi?date=`
  gives the latest day's file BEFORE `date` (no look-ahead - a day's file is out that evening; up to 10 days back over
  weekends / holidays; kept on disk by `NseDayStore` "participant-oi", a holiday kept empty, yesterday's missing file asked
  again; `NseBackoff`; 204 when none / NSE not answering - a page load, nothing polls). The page asks it once a day shown
  (while a GEX card / the checklist / the GEX quick view is on) and `participantShares(day, group)` gives the HEDGERS' share
  of each side: (their longs - their shorts) / all the OI of that side, the hedgers picked on the GEX card ("Hedgers":
  Pro desks - the default - / Pro + FII / All but clients, `optionanalytics.oiReplay.gexHedgers`). `gexDay`'s `shares`
  { call, put } takes the place of +1 / -1 as the dealers' share of every call's / put's OI (none = exactly as before -
  +1 / -1 held deepEqual to it in `tests/gex.test.mjs`), under 'buildup' for the first reading and the changes that cannot
  be read. `useGexDays` adds two days when it has them - `participant` (as held, no flip worked out - the verdict's vote) and
  `participantBuildup` - beside `standard` / `buildup`,
  which are UNCHANGED (the entry checklist's gamma check and the Signal backtest still read those). NSE'S POSITIONS ARE NOT
  A SIGN TO PICK (they were - "NSE positions" / "NSE + build-up" in the Sign picker - and four choices left the user unable
  to tell which to trust: "I am confused ... I do not know which to trust"; "NSE positions" as held was removed from the
  picker). "NSE + BUILD-UP" IS A SIGN AGAIN (asked for back - "can we have option NSE desk + day OI build-up again";
  `participantBuildup`: the first reading's OI signed by NSE's shares, then the day's OI changes read by their IV): the Sign
  picker is Standard / OI build-up / NSE + build-up, the last only on a day with NSE's file (`GEX_SIGNS`, `gexSignOptions(days)`;
  a saved one on a day without it, or the old "NSE positions", reads as Standard - `gexSignOf`; a dropdown on a phone) and the GEX card
  shows ONE VERDICT line, always open, in place of the folded "two signs' verdict" (`gexVerdict(standard, buildup, nse)`):
  Standard and OI build-up must agree, else "UNCLEAR - ... trade the walls only" (the rule before); NSE's positions only
  move the confidence - with them "all 3 reads agree - high confidence", against them "2 of 3 ... smaller size", no file =
  the two alone; each read's net and range / trend under it, and "the walls and max gamma hold under every read". The
  Hedgers picker is inside the "NSE positions" fold. It is ONE number a side for ALL NSE index options (every index, strike, expiry): it leans
  the net, its sign, the flip and each strike's GEX - not the walls / max gamma (gamma x OI, whoever holds it) - and the
  net is a small share of Standard's (real books are near balanced: Pro +1.5% of calls, -0.8% of puts on 13 Nov 2026), so
  `cr` shows a decimal under ₹10 Cr. SENSEX (BSE) uses NSE's file as a stand-in, said on the card ("NSE positions" fold:
  the file's date, the shares, the contracts, the net against Standard's). `NseParticipantOiTests.cs`,
  `tests/participant-oi.test.mjs`. It feeds no strategy or alert.
  ALL EXPIRIES BY DEFAULT (asked for - "how standard systems use GEX, I need to use it the same way; if there are gaps, fix":
  the GEX platforms add up the expiries - SpotGamma the nearest four - on OPEN INTEREST x gamma, calls +, puts -, as here;
  the gap was coverage: this read the current expiry alone unless the page's Σ 3 expiries was ticked): the GEX card's
  "All expiries" tick (`optionanalytics.oiReplay.gexAllExpiries`, ON by default) loads the next and the monthly expiry's
  bands FOR GEX ALONE (`gexAllOn` / `bandsOn` in `OiReplayPage` - the Σ tick's own loader, the same `summed-expiries` /
  `expiry-band` requests, live ticks and groups; asked only while a GEX card / the checklist / the GEX quick view is on,
  live on N1 only) and gives them to `useGexDays` as `chains` - both GEX cards and the entry checklist's gamma check read
  the three; the page's OI reads (totals, heatmap, walls, alerts) still follow the Σ tick only (`oiSumExtras`). Unticked
  (and Σ off) = the current expiry alone, as before. A past day's next expiry is ATM +/- 3 (all Dhan gives), two more band
  requests a day the first time, then disk. The Signal backtest's GEX is unchanged (its own Σ option).
  (A first DEX - delta exposure - card was built beside it and removed on request: its CE vs PE lean repeated the OI reads
  already on the page, and "delta" next to the order flow's cumulative delta / CDV confused the two. It came back as the
  DEALER HEDGING card below - flows only, no lean.)
- OI Replay's DEALER HEDGING (DEX) card (asked for - "can you also add delta exposure", the hedging-flow version picked:
  named so it is not read as order-flow delta, no CE vs PE lean; `dex` - `DexCard.jsx`, the maths `dex.js`): from the page's
  GEX day (`useGexDays`, its Sign picked on the card - `optionanalytics.oiReplay.dexSign`, Standard / OI build-up / NSE +
  build-up; gexDay's `options` now carry `call`) each minute's dealers' delta (Black-76 on the forward: call carry x N(d1),
  put carry x (N(d1) - 1), x the dealers' OI) read as FLOWS - rupees of index the dealers BUY (+) / SELL (-) to stay hedged
  for spot +1% / -1% (the whole move, sticky strike - the two sides' mean is the net GEX), IV -1 vol point (VANNA) and time
  alone (CHARM - to 15:30 that day and per hour); the dealers' NET delta (of the strikes loaded only - a level for them;
  the flows are local) and the DEX FLIP (the spot where it crosses zero, within +/- 3% and the strikes loaded, `flipEdge`
  rough) - none under Standard (long calls and short puts are both long delta), said on the card; `dexRead` a line each
  (moves damped / chased / mixed, charm into the close, vanna), the profile (`dexProfile`, an SVG) and the flows through the
  day (`LinesChart`, charm per hour in its own pane). DEX BY STRIKE and the DEX WALLS (asked for - "DEX walls ... add in same
  card"; `dexStrikes` / `dexWalls`, each minute's `strikes` / `walls`): every strike's dealer delta in ₹ (its calls' + puts'
  dealers' OI x delta at spot x spot, expiries summed) as a bar chart on the card (`DexStrikesChart` - + green / − red, the
  row spot is in blue, a hover reads calls / puts), and three headline levels by |dealer delta|: DEX RESISTANCE (the strike
  above spot with the most), DEX SUPPORT (below), DEX MAX (any) - the GEX walls' rules: a level moves only with 10% more, a
  quarter-step dead zone around spot, carried minute to minute by `dexDay` (`held`). Under Standard a call's and a put's
  deltas add to 1, so each bar is its call + put OI x spot and the walls are the biggest-OI strikes - said on the card.
  Each minute from its own GEX minute - a cut at the clock = the whole
  day's up to it (`tests/dex.test.mjs` - the delta = the price's slope, the moves = the GEX, charm / vanna signs, the flip,
  no look-ahead under both signs). Added ONCE to a saved "Sections shown" right after the GEX levels on spot
  (`SECTION_ADDITIONS` version 7, `SECTIONS_VERSION` '7'); shown, it turns the page's GEX on (`gexWanted`). A read - it
  feeds no strategy, alert or order.
- OI Replay's GEX LEVELS ON SPOT card (asked for - "on OI Replay show the GEX levels with the spot chart"; `gexSpot` -
  `GexSpotCard.jsx`, the maths `gexSpot.js`): the spot candles of its own timeframe (1 / 3 / 5 / 15, default 5,
  `optionanalytics.oiReplay.gexSpotTf`) with the CALL WALL, PUT WALL, MAX GAMMA and GAMMA FLIP drawn THROUGH the day as
  step lines - each candle reads the GEX minute at its LAST minute, or the replay clock when that is earlier
  (`gexLevelSeries`; a candle with no level breaks the line) - their values now on the price axis, and the net GEX's
  regime as a strip under the candles (green dealers long gamma / red short). The GEX is the page's own `useGexDays`
  (the GEX card's, Σ 3 expiries included; worked out while this card is shown too), its Sign picked on the card
  (`optionanalytics.oiReplay.gexSpotSign`), lines / strip ticked (`...gexSpotLines`, `...gexSpotRegime`); a line over the
  chart: the net GEX and regime, spot inside / above / below the walls (`wallRange`), each level's distance
  (`levelsAround`) and the GEX card's at-the-levels read (`gexLevelsNear`). Added ONCE to a saved "Sections shown" right
  after the GEX card (`SECTION_ADDITIONS` version 5, `SECTIONS_VERSION` '5'). THE GEX LADDER (asked for - "why are you
  not showing GEX levels like these", the order-book ladder picture; the "GEX ladder" tick, on by default,
  `...gexSpotLadder`): every strike's GEX at the clock beside the candles (`gexLadder` - the clock's minute's `strikes`;
  `GexLadderPrimitive`, `GEX_LADDER_SHARE` of the plot, more on a phone): a row a strike (centred on it, a step tall), PUTS'
  GEX left of the strike and CALLS' right, green = positive (dealers long gamma there) / red = negative, the ₹ Cr at the
  bar's end where there is room, the call wall / put wall / max gamma rows outlined (tagged CW / PW / MG when the panel is
  wide enough), the strike spot is at marked blue, the flip a dashed line across; the prices hold +/- 3 strikes around spot;
  hovering a strike reads its call / put / net GEX and OI; with it on, the price axis keeps the levels' coloured values
  but drops their captions (they sat over the call bars). Over the chart the HEADLINE numbers (the order-book card's look):
  spot, call wall, put wall, flip, max gamma - each with its distance - and the net GEX. Nothing after the clock
  (`tests/gex-spot.test.mjs` - a cut part way = the whole day for the candles finished; the ladder = the clock's minute).
  It feeds no strategy or alert.
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
  layout or "Sections shown" naming it just drops it. The Order Flow page's liquidity map, which the Signal backtest reads, is a
  different thing and stays.)
- OI Replay's SCREENS (asked for - "if there are multiple tabs open on OI Replay all tabs will be synced when the checkbox is
  ticked ... so many components, I need to see them on different screens"): the existing SYNC switch (`replaySync.jsx`,
  `optionanalytics.replaySync.enabled` - one switch for every page, off by default; BroadcastChannel, nothing through the
  server) now also keeps OI REPLAY TABS together, not only OI Replay with the Order Flow page: the day, Go Live and play /
  pause / seek / speed as before, and between OI Replay tabs only a "view" message (`announceView` - delivered to the same
  page's tabs, the Order Flow page never sees it) for what is replayed: the INDEX (a replayed day: that index's day at the
  same minute, as the page's own picker - `pickUnderlying`), WEEKLY / MONTHLY (`pickExpiryFlag`), the LIVE EXPIRY
  (`pickLiveExpiryFlag`) and Σ 3 EXPIRIES (`pickSumExpiries` / `applySumExpiries`) - sent only by the user's own pick, so a
  follower never echoes. An OI Replay tab's day / state messages carry its expiry choices too: a joining or following tab
  takes them first and applies the message again once they have landed (`flagFirst`, the pending re-apply also on
  `expiryFlag` / `liveExpiryFlag`), so the day loads with the same expiry; a replayed day of another expiry is another day
  to load (`otherExpiry`, `followDay`'s key with the expiry). A LIVE tab has no clock to reply with, so a joining tab of the
  same page that replays nothing yet is told its index / expiry / Σ (`view` on `useReplaySync`). Each tab has a SCREEN -
  `?screen=N` in the address, 2 - `MAX_SCREENS` 9, none = the main screen (`screenFromSearch`) - and keeps its OWN cards:
  "Sections shown", the grid layout, the sized cards and Free placement under `screenKey` (the main screen's keys
  unchanged, another's `.screenN` - account preferences like every other, `migrateSavedDashboard(screen)` on its own
  keys). "＋ Screen" beside Sync opens the next free screen in a new window (`nextScreen`) and turns Sync on; a "Screen N"
  tag names a screen other than the main one, and the Sync tag lists every peer by page and screen (`peerName` - "⇄ OI
  Replay Screen 2 2026-10-05"). The chart timeframe and everything else on a card stay each screen's own.
  `tests/dashboard-layout.test.mjs` (the screen helpers); checked with two real tabs (the day, the clock, Σ, Monthly, the
  index, live and joining).
  OTHER DEVICES (asked for - "a way to connect different devices for OI Replay ... see all components at once, maybe
  through wifi and bluetooth"): a browser cannot reach another device over Wi-Fi / Bluetooth by itself, so the server
  relays. The "Devices" switch beside Sync (`optionanalytics.replaySync.devices`, off by default, an account preference)
  sends the SAME sync messages through the live hub too (`syncBus.js` - BroadcastChannel + relay, every message a `mid`, a
  tab hearing it both ways takes it ONCE; `syncRelay.js` - one hub connection a tab while wanted, re-joined after a
  reconnect, a fresh hello each time; `SpotHub.JoinReplaySync` / `ReplaySync` / `LeaveReplaySync`): the group is the
  ACCOUNT's (`rs:{name}`, worked out on the server from who is signed in, Admin / User only - never External, the Runner
  key or a name the browser sends; `JoinGroup` refuses any "rs:" name), a message goes to the account's OTHER connections
  (`GroupExcept`), objects only, at most `MaxReplaySyncChars` 8 000, relayed as is - never read or kept
  (`ReplaySyncHubTests.cs`). So everything Sync does between tabs works between a laptop, a tablet and a phone signed in to
  the same account, on any network (Order Flow too). Each message names its device (`thisDevice` - an id kept in this
  browser only, LOCAL_ONLY, and a kind from the user agent - `deviceKind`): the tag reads "⇄ OI Replay Screen 3 on iPad".
  With Devices on, OI Replay shows a SCREEN picker (Main screen, Screen 2 - 9 - the window's ?screen=N, so a tablet with no
  "＋ Screen" window picks its own cards). A tag says when the server is not reachable (this browser only) or the account
  may not sync. `tests/sync-bus.test.mjs`; checked with two browser contexts (a Mac and an iPad) through a mock hub.
  THE PROFILES PAGE ON ANOTHER DEVICE (asked for - "OI page on one device, order flow on another, market profile on
  another"): OI Replay's one-way clock (`useReplayClockBroadcast` / `useFollowReplayClock`) also goes through the relay
  while Sync AND Devices are on (`useClockAcrossDevices`; both account preferences, so the phone has them too), on its own
  TOPIC (`createSyncBus`'s `topic` - 'clock'; the two-way sync is 'sync', a message with none reads as 'sync') so neither
  is read as the other; still one way - nothing on the Profiles page moves OI Replay. Its tag names the device ("⇄ OI
  Replay on Mac · NIFTY live" - `remote`). Checked with three contexts: OI Replay on a Mac, Order Flow on an iPad, the
  Profiles page on an iPhone.
- OI Replay's QUICK VIEWS (`quickViews.js` - `QUICK_VIEWS` / `quickViewForKey`): a popup for a quick scan of one card -
  a SINGLE KEY (no Ctrl / Alt / Shift - the user's ask; Alt was tried first): Z Day OI since the open, X the OI totals
  charts (CE / PE / Net), C GEX, V the ATM straddle, B the futures chart, N the OI change heatmap and totals, M the option
  premium charts (ATM by default), and (asked for - "add delta profile on the floating popover icon so that I can access it
  easily") , the option delta profile on spot and . the futures delta profile (`code` Comma / Period - Shift + . is not
  one) - the bottom row of the keyboard (the same again or Esc closes, another key switches;
  not from a box being typed in, not a key held down, not while the order ticket or its review is open - the ticket's own
  C / P pick the option). With Ctrl / Cmd a letter stays the browser's (Ctrl + C copies, Ctrl + N a new window). B is
  Futures, so the order ticket's BUY is F1 only (S / F2 still sell). The old Ctrl + Shift + 1 - 9 (`digit`) still open
  the same views. Or the "Quick view" buttons
  under "Sections shown" - shown even when the card is hidden. The popup renders the card's OWN content (the page's
  `dayOiContent` / `premiumPickers` / `premiumCharts` elements, `OiChangeHeatmapSection` with no `alerts` - so no
  second set of alerts - `StraddleCard`, `GexCard` on the shared `useGexDays`, `OiTotalsChartsPopup`, the futures card's `futuresControls` / `futuresContent` -
  its DOM button stays on the card - and `OptionDeltaProfileCard` / `FuturesDeltaProfileCard` with the cards' own inputs
  and kept settings), live with the page
  (`tests/quick-views.test.mjs`). On a phone / touch screen (no keyboard, a long page) a small floating button
  (`QuickViewFab.jsx`, 40 px) opens them: it starts at the BOTTOM LEFT of the page, right of the sidebar (`fabDefault`,
  `useSideNavInset` in `useScreen.js` - never over the menu), dragged anywhere (kept on the screen), a tap opens the nine
  views as small labelled icons (up or down, wherever they fit), a tap on one opens its popup. NEAREST THE BUTTON, before the
  views, is ORDER (asked for - "order punching should also be in the floating popover so I can punch trades easily"; the
  button's `actions`, `fabEntries` in `quickViews.js`): it opens / closes the Paper / Live order panel - the "Paper Trade"
  button's own `DraggableFloatingPanel` (`paperPanelOpen`), so a trade is punched from anywhere on the page without
  scrolling to that button; "Order (live)" while Live mode is on, blue while the panel is open. It only opens the panel -
  a live order still goes through the panel's own confirm. The panel also has an ORDER BUTTON OF ITS OWN, always on
  screen (asked for - "there as well as popover somewhere on screen"; `OrderFab.jsx`): a round cart button whose one tap
  opens / closes the same panel - blue while it is open, a red ring and a LIVE tag while Live mode is on; it starts at the
  BOTTOM RIGHT, one row above the replay bar (`orderFabDefault` - in the bar's row it would cover the speed), is dragged
  anywhere and kept by its nearest corner as the quick button is (`optionanalytics.oiReplay.orderFabAnchor`); dropped in the
  bar's row at the right the bar ends left of it (`fabInBarRowRight`); the page's "Order button" tick turns it off
  (`...orderFabOn`), and the page keeps 120 px of room at its bottom while it is on. Both buttons drag through one hook
  (`useFabDrag.js`). Where the quick button was dropped is
  kept as its distance from the NEAREST CORNER (`fabAnchor` / `fabFromAnchor`, `optionanalytics.oiReplay.quickFabAnchor`)
  - an account preference, so a phone and a monitor share it: kept in pixels from the top left (the old
  `...quickFab`, no longer read), a spot picked on a phone put the button in the middle of a monitor's spot chart. It
  shows on EVERY screen (it saves the same scrolling on a monitor) - the page's "Quick button" tick turns it off. APP-WIDE (asked for - "the order float and this popover should not be specific to a page but to the overall application ... available to OI Replay, the Profiles page and the Order Flow page ... the same OI Replay component available for quick view to other pages"): both buttons are on OI Replay (its own), the PROFILES page and the ORDER FLOW page (`floatingModeFor` in `floatingHost.js`; no other page, never the External account) - on the other two `GlobalFloating` (mounted once in App, outside the routes) draws them as LAUNCHERS (the same buttons in the same places - the anchors and the "Quick button" / "Order button" ticks are OI Replay's own account preferences). Nothing is loaded until one is tapped: the tap mounts a POPUP-ONLY OI Replay page (`<OiReplayPage popupOnly />` - its whole logic and live data, none of its cards: no body, no NavBar, no keyboard keys, no replay bar, no replay sync and no clock broadcast, so the Profiles page's "Follow OI Replay" never sees it), which loads today's live run as OI Replay does, draws the real buttons (the launchers step aside - `fabsShown`) and carries the tap out (`pending`: the order panel, or the quick view picked - GEX, straddle, the delta profiles... the same popups with the same content). It stays mounted across Profiles <-> Order Flow, and goes when OI Replay opens (that page has its own). `tests/floating-host.test.mjs`. A LIVE order from there is the same Live order panel with the same confirm - the server alert runner and the Runner key are untouched.
  The REPLAY BAR (`FloatingReplayBar.jsx`, asked for - "replay bar also should be floating"): on a REPLAYED day, once the
  Spot card's own replay controls are out of sight (`useOnScreen` on them; or that card is hidden), a slim bar floats at
  the bottom of the window - Start / Pause, Reset, the minute shown, the slider (no handle tooltip), the speed - the SAME
  handlers and state as the inline controls (`toggleReplay` / `resetReplay` / `scrubReplay` / `changeReplaySpeed`), which,
  with their "Float" panel, are unchanged; not while that panel floats, never live. It starts right of the quick button
  while that sits in its row (`fabInBarRow`), at most 980 px wide, centred; the page keeps 72 px of room at its bottom
  for both. The "Replay bar" tick beside "Quick button" turns it off (`optionanalytics.oiReplay.replayBarOn`).
- OI Replay's VOICE COMMANDS (asked for - "integrate voice command to start replay stop replay and open any card in popup
  or anything on oi page"): the "Voice" tick beside "Quick button" / "Replay bar" (`STORED_VOICE`
  `optionanalytics.oiReplay.voice`, OFF by default and LOCAL_ONLY - a microphone must never switch itself on because
  another device was left listening) turns the browser's own SpeechRecognition on (`useVoiceCommands.js`, en-IN; the
  recogniser is never rebuilt mid-sentence - `onCommand` is read from a ref).
  THE PERMISSION IS ASKED WHEN THE TICK IS TURNED ON (asked - "browser not asking for permission"): SpeechRecognition only
  asks on its first start(), which on push to talk is the first Ctrl press - so ticking Voice seemed to do nothing. Ticking
  now asks at once (`askForMicrophone`: getUserMedia, tracks stopped straight away - only for the browser's own prompt;
  the pill says "Allow the microphone in the browser prompt...") and every failure is said on the pill: blocked (where to
  click), no microphone, in use by another app, a page that is not https (the browser refuses the microphone there
  silently - `isSecureContext`), a browser with no speech recognition (Firefox, Brave). A Ctrl pressed again before the
  recogniser has finished stopping opens it the moment it has (`want` / `active` - it used to be dropped).
  HOLD CTRL - PUSH TO TALK (asked for - "add ctrl then i should be able to speak it should not always hear us"): the
  "Hold to talk / Always" picker beside the tick (`STORED_VOICE_MODE` `optionanalytics.oiReplay.voiceMode`, LOCAL_ONLY too,
  'hold' BY DEFAULT) - on 'hold' the microphone is started on Ctrl (or ⌘) DOWN and stopped on its UP, so it is SHUT the
  rest of the time (nothing is heard, and the recogniser is not even built until the first press); another key while Ctrl
  is held (Ctrl + C, Ctrl + V) cancels at once, a Ctrl pressed in a text box is the box's, and a lost window or a hidden
  tab shuts it too - the mic is never left open. 'always' is the old behaviour: it listens while the tick is on, started
  again after each silence (Chrome stops after a few seconds even with `continuous`), backing off and finally giving up
  with a message rather than spinning. The rule is pure and tested (`pushToTalkKey`). ON A PHONE (asked - "how it works in
  mobile?": there is no Ctrl key, so hold mode opened nothing): the pill carries a round MIC BUTTON (48 px on a touch
  screen - `isTouchScreen`: no hover or <= 768 px) that is HELD to talk - the hook's `press()` / `release()` take the very
  path Ctrl does (pointer capture, a long press is not a text selection or context menu), enabled once the microphone is
  allowed (`ready`), and the pill reads "Hold the mic button and speak" (`voiceHint`). The pill sits ABOVE the quick-view
  popups (`VOICE_Z` 1060 over antd's modal 1000): the button is how "close" is said on a phone, and a popup used to cover
  it; the Voice tick's help tooltip is off on a touch screen (a tapped tooltip stays open, over the pill). AS QUICK AS IT CAN BE (asked for -
  "it should ultra quick"): a command is taken from the INTERIM text the moment the words are recognisable, not from the
  final result that lands about a second after you stop speaking; each utterance fires at most once (`fired` by result
  index, so the final that follows is ignored) and several commands can be said in one hold.
  Each sentence is read by `voiceCommands.js` into ONE command (`parseVoiceCommand`): a phrase matches ANYWHERE in it
  ("okay now start the replay please"), the LONGEST phrase wins ("stop listening" over "stop", "option delta profile" over "delta profile",
  "gex levels on spot" - the card - over "gex" - the popup), number words become digits ("go to ten thirty" = 10:30,
  "to" / "for" / "oh" deliberately NOT numbers), the engine's own alternatives are tried in order (its first guess at
  "gex" is often "jacks"), and the same final transcript twice within 1.2 s is one command. What can be said: the replay
  (start / stop / pause / reset - never a toggle, so twice is harmless), the speed ("faster" / "slower" step through
  `SPEED_OPTIONS`, "2x" / "half speed" are absolute), the minute ("go to 10 30" - a spoken 1 / 2 / 3 is 13 / 14 / 15, the
  market is never open at 1 am - "forward 5 minutes", "back 10 minutes", "next candle"), the nine QUICK VIEWS as popups,
  the cards with no popup (`VOICE_CARDS` - scrolled to by their `data-card` and outlined for a moment; one hidden in
  "Sections shown" is reported, not opened), "close", the index / "go live", "open order panel", "what can I say" (the
  list as a notification) and "stop listening" (it unticks Voice). The page carries each one out with ITS OWN handlers -
  `toggleReplay` / `resetReplay` / `scrubReplay` / `changeReplaySpeed` / `setQuickView` / `setPaperPanelOpen` /
  `pickUnderlying` / `goLiveAndAnnounce` - so voice can do NOTHING A CLICK CANNOT, and a command that needs a replayed day
  says so when the page is live. IT NEVER TRADES: 'order' only OPENS the Paper / Live panel, which keeps its own confirm,
  and any sentence mentioning buy / sell / punch / place / square off is REFUSED outright (`VOICE_NEVER`) - it does not
  even switch the index it happened to name. The pill (`VoiceControl.jsx`, top right, below the header on a phone) shows
  the mic state ("Hold Ctrl and speak" while it is shut), what is being heard and the last command, with the list and the
  privacy line in its ⓘ: THE LISTENING IS
  THE BROWSER'S SERVICE (Chrome sends the audio to Google's, Safari to Apple's) - said on the tick and the pill, which is
  why it is off by default and runs only while ticked. Not in the popup-only host (`popupOnly` - the Profiles / Order Flow
  launchers must not open a microphone). `tests/voice-commands.test.mjs` (every phrase, the aliases, the numbers, the
  mishearings, the refusals, and that no command does anything but read the page / move the replay / open the panel);
  checked in a browser against a FAKE SpeechRecognition (start / stop / reset / goto / forward / back / faster / 2x, the
  popups, a card scrolled to, the refusal, the order panel, "stop listening"), and push to talk end to end: ticked but
  nothing held = the recogniser never started and nothing heard, Ctrl down = open, an INTERIM "open gex" opens the popup
  at once and its final does not fire again, a second command in the same hold, Ctrl up = shut, Ctrl + C = shut,
  "Always" = open with no key held.
- WHATEVER IS SELECTED IS BLUE (asked for - "whatever is selected show them blue, it looks confusing on the UI; check all
  pages"): the app's ONE antd theme is `APP_THEME` in `appTheme.js` (main.jsx's ConfigProvider; a page's nested one - OI
  Replay's `COMPACT_TEXT_THEME` - merges into it): every Segmented picker's selected item (index, Paper / Live, Buy / Sell,
  CE / PE, ITM / ATM / OTM, timeframes...) is the dark primary `#1668dc` with white text - antd's dark theme marked it with a
  grey a shade lighter than the rest - and so are the sidebar menu's page (Menu) and a dropdown's picked option (Select,
  `#1554ad`, a deeper blue so a coloured CE / PE label still reads). Checkboxes, switches and primary-button toggles were
  already that blue. A new picker needs nothing; never style a selection grey (`tests/app-theme.test.mjs`).
- The POP-UP ALERTS (antd's static `notification` - every page's: OI Replay's S/R breaks and 🎯 signals,
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
  The DELTA WEIGHT is the Pine "delta auto" indicator's own sigmoid (`deltaWeight` / `ComputeDeltaWeight`, slope 8.5 - a
  1-year, 20%-volatility option's delta: across a weekly's ATM +/- 10 it runs only ~0.46 - 0.54, so the CDV, the option delta
  profile and its Signal backtest conditions read close to unweighted volume). Kept ON PURPOSE (an audit flagged it, the
  fix was not made): the CDV is a port of that indicator, and the delta profiles and saved strategies' live scans read the
  same weight - a real delta (1.702 / (sigma x sqrt(T)) as the slope, sigma x sqrt(T) from the ATM straddle) is the user's call.
- OI Replay's DELTA PROFILES (asked for - "like volume profile and market profile we need to build delta profile: the delta
  profile of option data on the spot chart, and also on the futures chart - add two more components on OI Replay"; two
  cards, `optionDeltaProfile` / `futuresDeltaProfile` - `DeltaProfileCard.jsx`, the maths `deltaProfile.js`, the drawing
  `deltaProfilePrimitive.js`): the candles with, at the right of the plot (`PANEL_SHARE`, the time axis's right offset
  leaving it empty, at least `MIN_SPAN` candle widths), a VOLUME column (how much traded at each price row - grey, the value
  area brighter, the POC amber, also a faint band across the candles: the big volume node) and a DELTA column (buyers minus
  sellers there - green right of its centre line, red left); the row under the crosshair outlined and read out under the
  chart AND in a small tooltip beside the pointer (price row, any level it holds, volume, delta in lots - asked for: "I should be able to hover over and see data"; flips to the left of the pointer on the right half); timeframe 1 / 3 / 5 / 15 and the row size per index (`PROFILE_ROWS` / `PROFILE_ROW_CHOICES`, shared by both cards -
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
  saved at, so one hidden since stays hidden; `tests/dashboard-layout.test.mjs`). PREVIOUS DAY / DAYS (asked for - "a
  checkbox to see the previous day's delta, and N days too"): each card's "Previous day" tick and Days (1 - 20, default 1,
  unticked = as before): unticked = the day so far and the N - 1 sessions before it, ticked = the N sessions BEFORE the
  day WITH THE DAY UP TO THE CLOCK ON TOP (`deltaCardSessions` in `profileZones.js` - asked for: "the futures delta profile
  should also go with the replay, it should not come all at once"; ticked it was the sessions before ONLY - whole from the
  replay's first minute, nothing of the day replayed ever came into it), a COMPOSITE added up price by price
  (`optionDeltaProfileOf` / `futuresDeltaProfileOf` take a list of sessions), drawn over the day's candles with the price
  scale holding the whole profile; the sessions line says "the day replayed up to HH:MM". No minute of the day yet: LIVE
  (before the open) the latest session's candles stand in, said on the card; a REPLAYED day never borrows another day's
  candles (its whole day at 09:15 read as the replay loaded all at once) - one invisible candle at its 09:15 holds the scale
  (`cardCandleSource` / `scaleHolderCandle` in `deltaProfile.js`) and the day's candles come in as it plays
  (`tests/delta-profile.test.mjs`). "+ CURRENT DAY" (asked for - "give current day option to consider, when ticked then
  only add, else the previous day will be shown on the option delta profile and futures profile"; shown with "Previous day"
  only, kept per card - `optionanalytics.oiReplay.{id}WithToday` - ticked by default = as above): unticked, the N sessions
  BEFORE the day ALONE (`deltaCardSessions`' `withToday: false`; the day's candles still drawn, the sessions line leaves
  the day and its clock out). The days before (`deltaProfileDays.js`, `usePastDeltaSessions`): weekdays walked back ONE REQUEST
  AT A TIME, N + 10 at most - the options' from that day's run (`/api/oi-replay/{u}/run`, the charts' series), kept as its
  minutes (`optionDeltaMinutes`), the futures' from its Order Flow day (`FETCH_ROWS`, regrouped; the footprint IN LOTS of
  its own day's lot size - `footprintBars`); a day with no session (a run without success, a 404 - a holiday) stepped
  over, the walk STOPS at the first failure and says which day (Retry walks again - never a loop); a day that came back
  is kept for the tab (`cachedDay`, one on its way shared), a failure or a holiday not. A tick, never a timer; the day
  shown alone (unticked) needs nothing loaded. LEVELS (asked for - "draw the volume profile's LVN, HVN, POC, VAL, VAH as
  well"; the "Levels" tick, on by default, `optionanalytics.oiReplay.deltaProfileLevels`): the profile's POC (solid), VAH /
  VAL (dashed) and ONE HVN / LVN (dotted - `volumeZones`' `topHvn` / `thinLvn`, the Profiles page's) as price lines labelled
  on the axis, in its colours (`PREV_PROFILE`), and a line naming them with the rows of the most buying / selling -
  `deltaProfileLevels`, the same the Signal backtest reads. OI (CE − PE) - THE OPTION WRITER'S VIEW (asked for - "OI delta ... CE − PE, if it is negative show bullish, else bearish - from the perspective of an option writer"): the option card's side picker adds "OI (CE − PE)" (`CARD_SIDES` - the card's own; `OPTION_DELTA_SIDES`, which the Signal backtest reads, is unchanged): the same profile whose DELTA column is, at each SPOT row, the call OI added minus the put OI added in the minutes spot spent there (`optionOiNetProfileOf` on `optionOiMinutes` in `oiProfile.js` - every strike from its own first reading; the day's and the sessions before's `oi`, kept by `optionDayRecord`), VOLUME = the option volume there; NEGATIVE = puts written = a floor = BULLISH, drawn GREEN (`bullishNegative` in `deltaProfilePrimitive.js`), positive = calls written = a ceiling = BEARISH, red; the header says BULLISH / BEARISH from the net, the levels "most puts written (floor)" / "most calls written (ceiling)". "+ NET (CE − PE)" (asked for - "if the check box is ticked it will show net CE - PE as well ... both profiles"; shown with the OI side only, `optionanalytics.oiReplay.optionDeltaAlsoNet`, off by default): the flow's net CE − PE profile (the very `flowProfile` the OI profile is built on) as a SECOND delta column beside the OI's (`profile.extra` in `DeltaProfilePrimitive` - three columns, the panel's share unchanged; its own sign, + green), and a second tick "+ Total (OI − Net)" (`...optionDeltaAlsoTotal`) draws a THIRD column - per price row the OI's CE − PE less the flow's net (negative = green; `profile.extras` is a list of columns, so all three can show) - and the header adds "Net CE − PE Δ" and "Total (OI − Net)" = the OI's net CE − PE less the flow's net (negative = bullish). `tests/delta-profile.test.mjs`, `tests/oi-profile.test.mjs`. The cards themselves feed no strategy or alert.
  THE OPTION CDV / OBV PROFILE card (asked for - "another component of cdv and obv profile ... same as delta and futures profile ... previous days + current day"; `optionCdvObvProfile`, `OptionCdvObvProfileCard` in `DeltaProfileCard.jsx`, section version 8 / `SECTIONS_VERSION` '8' - added once, right after the option delta profile): the option delta profile's price rows with TWO delta columns beside the volume, CDV (the bar-proxy delta - the delta profile's own, `metric` 'cdv') and OBV (`metric` 'obv': each strike's volume x delta weight signed by whether its close rose or fell from ITS previous bar's close - `ceObv` / `peObv` on each `optionDeltaMinutes` minute, the Option OBV's rule at each minute's own spot, so no look-ahead), for CE / PE / Net (CE − PE), + green; the same Previous day / Days / "+ current day" ticks (kept per card, `optionCdvObv...`), levels, hover and replay clock. A read - no strategy or alert (`tests/delta-profile.test.mjs`).
- OI Replay's paper trade panel (`paperStops.js`, `paperExit.js`): each position keeps the levels it was punched with (the
  panel's, or the keyboard ticket's) in its `levelLog`; a panel change (once it has settled a second - typing 25 passes
  through 2) reaches the OPEN positions of THAT index only, from the minute it is made (`withPaperLevelChange`): a minute is
  judged with the last change made in it or before, so the minutes already passed are never judged again. In the minute of
  the entry or of a change only the point's own price counts - its high / low partly came before it (live, the forming
  minute's range holds the ticks before the entry) - and a price already past the stop there is the fill (a stop set
  through the price closes at the price, the market's). A bar that OPENS through the stop fills at its open (`gapFill`); a target at the target. The trailing stop only tightens: what a bar earned is kept through a
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
- OI Replay's POSITION GREEKS on the order panel (asked for - "position Greeks on the order panel ... net delta, gamma,
  theta, vega, delta notional, a warning past a limit, what one more lot adds"; `positionGreeks.js` - `legGreeks` /
  `bookGreeks` / `deltaBreaches` / `orderDeltaChange`, the block `PositionGreeks.jsx`, the panel's `greeks`): each open
  PAPER position (Paper mode) or LIVE Dhan position (Live mode - `LivePositionRow.Contract`, the option master's index /
  expiry / strike / CE-PE for its security) priced Black-76 on its index's spot with the IV of its OWN premium, to 15:30
  IST on its expiry day; x its signed quantity (+ bought, - sold) and added up PER INDEX: net delta in units and lots, its
  NOTIONAL (delta x spot), gamma as ₹ of notional per +1%, theta ₹ a day (one calendar day, everything else kept), vega ₹ a
  vol point, the P&L of a +/- 1% move (delta + gamma). A premium under intrinsic = delta 1 / 0, the rest 0; a leg with no
  spot / expiry (another index live, a live expiry other than N1) is counted as not worked out. Spot / expiry: the index on
  screen - its spot at the clock and the run's `optionExpiry`; another index's held day on a replay - that day's. "This
  order" = what the order set on the panel adds (its preview premium), red when it takes the index past the limit;
  "Warn past ± N lots Δ" (`optionanalytics.oiReplay.deltaLimitLots`, 0 = off) - an alert while an index is past it.
  Shown once there is an open position or an order it can read. A read - it places nothing (`tests/position-greeks.test.mjs`).
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
  (`flowCePoints`) stay on the current expiry. An expiry's last reading WITH AN OI AT OR BEFORE a point's time is added
  (carried on, never a later one - a reading with no OI carries the last on: read as none, that expiry's whole OI fell out
  of the sum for the minute); one first read at a strike AFTER the current expiry's first reading there counts by its CHANGE from
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
  stricter `profileNodes` (`lvnRun`): that one smooths, wants 1.3x / 0.6x the mean and a trough
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
  the Order Flow page reads the recorded `Bars` only, untouched; `OrderFlowHistory.BackfillCutoff` /
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
  "PREVIOUS" ADDS THE DAY RUNNING EVERYWHERE (asked for - "add previous + current as well": the Profiles page showed 2 sessions where OI Replay's delta card showed 3): with "Previous session(s)" every profile on this page - volume, market (TPO) and Delta (spot's options, futures' footprint) - is the N sessions BEFORE with the day up to the clock / live ON TOP (`deltaCardSessions`, as OI Replay's delta cards - it was the sessions before ONLY), the cover line and the "estimated" tag counting the day. "+ CURRENT DAY" (asked for - "a checkbox to consider the current day: ticked consider it, else the previous days"; shown with "Previous session(s)" only, `optionanalytics.profiles.withToday`, ticked by default = as above): unticked, every profile on the page - volume, market (TPO) and both Delta columns - is the N sessions BEFORE the day ALONE (`deltaCardSessions`' `withToday: false`; the day's candles are still drawn, the cover line and the "estimated" tag leave the day out); "Today so far" always holds the day. OI Replay's delta cards are unchanged (`tests/delta-profile.test.mjs`).
  THE "DELTA" TICK (asked for - "a tick which will show delta: for spot the OI data, for futures the futures delta, on the
  market and volume profile"; `optionanalytics.profiles.delta`, OFF by default): a DELTA column just left of the profile on
  BOTH charts of each instrument (`DeltaColumnPrimitive` in `profilePrimitives.js`, `DELTA_COLUMN_SHARE` 14% of the plot - the
  candles stop short of it; buyers green right of its centre line, sellers purple left, scaled to the largest row) and a line
  over each chart (what it is of, the net, the rows of the most buying / selling - `deltaProfileLevels`). SPOT = the OPTIONS'
  flow on spot rows, OI Replay's option delta profile (`optionDeltaMinutes` / `optionDeltaProfileOf` - each strike's bars
  given a side by where the close sits, weighted by its delta, Net CE − PE) from the day's run (`useOptionRun` -
  `/api/oi-replay/{u}/run`, WEEK / BANKNIFTY MONTH; asked only while ticked; LIVE `forceLive` and again each minute, a page
  timer with `POLL_HEADERS` - the server's memory), the minutes up to the clock, the sessions before from their own runs
  (`usePastDeltaSessions`, moved to `usePastDeltaSessions.js`, shared with OI Replay's delta cards). FUTURES = the footprint's
  buy − sell at each price (`futuresDeltaProfileOf`) of the same sessions the profiles use. Display only.
  WHY IT DID NOT MATCH OI REPLAY (asked - "delta is not matching with our OI Replay, why?"): (1) LIVE, the futures minutes the
  pushes add are CANDLES with no buy / sell rows, and `spreadLevels` gives a candle's whole volume to one side by its colour -
  so every minute since the page loaded read as 100% buying or selling. Now the futures delta reads only the LOADED day's
  footprint rows (`futuresDelta.known` - `barsKnownAt(loadedFutures)`, not the live-merged day; the volume / market profiles
  still take the live candles) and, live with the tick on, the futures day is loaded again EVERY MINUTE (`futuresPoll`, a
  page timer with `POLL_HEADERS` - the server's memory), as OI Replay's futures delta card is. (2) The options were always the
  WEEKLY (BANKNIFTY monthly); while FOLLOWING OI Replay they are now ITS series - the clock message carries `expiryFlag`
  (`useReplayClockBroadcast`), `useOptionRun`'s `seriesFlag`. Still each page's own choice, so set them alike to compare: the
  row size, Days / Previous, and OI Replay's side (Net / CE / PE / OI) - the Delta line names the series and the row size. The
  volume bars and POC / VAH / VAL differ by design: OI Replay's card = OPTION volume, this page = the index's / futures' volume.
  THE FLOATING REPLAY BAR (asked for - "on the market / volume profile and order flow pages a floating popover to run replay
  like OI Replay"): OI Replay's `FloatingReplayBar` on the Profiles page (its own replay of a past day, not while following OI
  Replay) and the Order Flow page (a loaded day) once the inline replay controls are out of sight (`useOnScreen`): Start /
  Pause, Reset (Profiles) or −1m / +1m (Order Flow), the minute, the slider, the speed - the same state and handlers as the
  inline controls. There the page's buttons are the APP-WIDE ones (`GlobalFloating`), so the bar is `<FloatingReplayBar
  appFabs>`: it reads their ticks / anchors (OI Replay's preferences) at every render and starts right of the quick button /
  ends left of the order button as on OI Replay (it sat UNDER the quick button); both pages keep 120 px at their bottom; on
  a phone the Order Flow bar leaves out −1m / +1m (no room beside the button - the speed was cut off).
- The SPOT STRUCTURE page (`/structure`, "Spot structure" in the menu - `SpotStructurePage.jsx`; asked for - "a page which will
  only talk about spot structure, I choose higher and lower timeframe, Day / 4 hr / 1 hr ... automatically identify structure,
  trendline, support resistance, patterns, internal / external market structure, change of character, BOS"): an index's SPOT
  on a HIGHER and a LOWER timeframe (Day, 4H, 1H, 15m, 5m, 3m, 1m - the lower always under the higher, `lowerThan`; each its
  own "History" in days - `HISTORY_CHOICES` / `TIMEFRAMES` in `structureShapes.js`; all account preferences
  `optionanalytics.structure.*`). THE CANDLES: `GET /api/structure/{u}/candles?tf=&days=` (`StructureController`,
  `SpotStructureService`): EVERY timeframe is BUILT FROM THE SPOT'S 1-MINUTE CANDLES (asked for - "we have OHLC candles of spot,
  build hourly or whatever we want - first check cache, then Dhan only"): the PAST days are the very 1-minute days OI Replay's
  runs and the backtests keep on disk (`DhanHistoricalDataService.GetIndexRangeDiskFirstAsync` - GetIndexDayCandlesAsync's
  series): every weekday kept is read from disk, Dhan asked ONLY for the runs of weekdays not kept (`ChunkDays` 80 calendar days
  a call at most - its intraday limit is 90; a lone day through GetIndexDayCandlesAsync, so a holiday is proved once and kept;
  weekends never asked) - a window read whole asked Dhan again for days already kept whenever one of them was not
  (`DhanDataCacheTests.AnIndexRange_...`); the window ends on the last WEEKDAY before today; the days are HELD IN MEMORY per day
  for the IST day (a past day never changes; a failed read not held - asked again next load): 5-minute candles for every day
  (Day / 4H / 1H / 15m / 5m are made from them) and the 1-minute ones for the last `MinuteDays` 14 (3m / 1m) - every timeframe
  and the refresh read the same held days; the answer says where its days came from (`daysHeld` / `daysFromDisk` /
  `daysAskedOfDhan` - a line under each chart); TODAY from `OiReplayService.GetSpotDayAsync` (the spot feed's memory, no Dhan
  call, or the day's one shared fetch), from 09:15 on weekdays. Bucketed on the SESSION from 09:15 IST (`Aggregate`: a 4H candle is
  09:15 - 13:15 and 13:15 - 15:30, as TradingView draws NSE; an hour 09:15 - 10:15 ...; a day the session), minutes outside
  09:15 - 15:29 and repeated minutes left out (`SpotStructureServiceTests.cs`). The page loads a chart on a change and again
  EVERY MINUTE while today is in it (a page timer, `POLL_HEADERS` - the past from memory), a failed load waiting longer each
  time (1 min doubling to 30). THE READ (`marketStructure.js`, pure, `tests/market-structure.test.mjs`): PIVOTS higher /
  lower than `len` candles each side, known `len` candles later - nothing is read from candles after the one it is shown on
  (a cut chart = the whole one up to the cut, held by the test); STRUCTURE twice, EXTERNAL (Swing length, 5 - 50, default
  10) and INTERNAL (2 / 3 / 5, default 3): a CLOSE past the last unbroken pivot = BOS with the trend, CHoCH against it (an
  internal break on the same level and bar as an external one is the external one's), HH / HL / LH / LL; SWEEPS (a wick past
  the swing high / low closing back inside), EQUAL HIGHS / LOWS (internal pivots within 0.1 ATR, taken / swept), ORDER
  BLOCKS (the lowest / highest candle from the broken pivot to the break, mitigated by a close through it), FAIR VALUE GAPS
  (>= 0.15 ATR, filled when traded back across), STRONG / WEAK high and low, the DEALING RANGE's premium / discount
  (47.5 - 52.5% equilibrium), S/R ZONES (pivots within 0.5 ATR, two turns or more), TRENDLINES (rising lows / falling highs
  no close crossed between them, the most touches unbroken, else the last broken), CHART PATTERNS on the alternating swings
  (double top / bottom, head & shoulders and inverse, ascending / descending / symmetrical triangles, rising / falling
  wedges, channels, range - confirmed by a close through the neckline / boundary, failed the other way, with a target); the
  TOP-DOWN read (`topDownRead`: the higher TF's swing trend and premium / discount against the lower TF's structure -
  aligned / pullback - wait for the lower TF's CHoCH / against). DRAWN (`structureShapes` + `StructurePrimitive`, bar
  indices as x so it follows scroll and zoom): twelve layers ticked (`STRUCTURE_LAYERS`, all on by default; on a phone behind
  a "Layers" button), the higher TF's S/R, swing order blocks and dealing range across the lower chart in light blue. NOTHING
  IS DRAWN OVER ANYTHING ELSE (asked for - "this is looking a bit messy": a pattern's name came out as "BOS netrical
  triangle", an i-BOS label drawn across it): every label is gathered while the shapes are drawn and PLACED AFTERWARDS, most
  important first (each shape's `pri` - external structure, patterns, strong / weak, HTF, zones, trendlines, premium /
  discount, order blocks, liquidity, gaps, internal), each tried on its own side then the other, and one that would touch a
  label already placed is DROPPED (`clears`, pure and tested) - the reading it carries is in the lines under the chart
  anyway. THE LOWER CHART'S OWN MARKINGS can be hidden (asked for - "an option to hide the lower timeframe's
  details with a tickbox, so I can see the higher timeframe on the lower timeframe, and see the lower one again when I
  wish"): its card's "Its own structure" tick ("Own" on a phone, `optionanalytics.structure.ltfOwn`, ON by default) - off,
  `ltfLayers` leaves only the 'htf' layer, so the higher timeframe's S/R, swing order blocks and dealing range are drawn over
  bare candles (nothing at all when that layer is unticked too - the chart says so); the reading under it is unchanged.
  HOW MUCH is the "Detail" picker (`DENSITY` - Clean (the default) / Normal / Everything,
  `optionanalytics.structure.density`): how many patterns, blocks, gaps, zones, equal levels, sweeps and internal breaks are
  drawn and how many of those may carry a label (Clean labels no internal break at all and leaves the premium / discount
  SHADING off - its two blocks coloured the whole chart - keeping the equilibrium line); a summary under each chart (trend tags, last breaks, range, strong / weak, S/R, trendlines,
  patterns, order blocks, gaps, liquidity). A read of the chart - it places nothing and feeds no alert or strategy.
  FOLLOWS OI REPLAY (asked for - "replay should also work there ... with OI sync"; `optionanalytics.structure.follow`, ON by default, the
  "Follow OI Replay" tick): the Profiles page's one-way clock (`useFollowReplayClock`) - OI Replay's index (the picker locks) and,
  while it replays a PAST day, only the candles COMPLETED at its clock (`candlesAsOf`; a day just loading = none of it yet), the
  window asked `days` + the days back to that day so it holds it (the server clamps to the timeframe's limit - a day older than
  that shows no candles); live or OI Replay not open = as before.
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
  "held ≥ N min before" (`param2.text`). AHEAD ALL DAY (asked for - "in total OI, since open OI and cumulative OI: PE > CE
  since morning check, and PE > CE and vice versa"): OI since open, Total OI CE vs PE and the OI cumulative Δ's CE vs PE
  each have "PE ahead / above CE all day (since the morning, never behind)" and the CE mirror (`peAllDay` / `ceAllDay`,
  `heldAllDay`: on that side at EVERY reading from the first that was not level up to the candle - behind once, or back to
  level, and it no longer holds that day; readings with no value - before the first bucket, a gap - skipped), with the
  crosses' "by ≥ %" read now. The OI totals card's two cumulative lines AGAINST EACH OTHER are their own condition, "OI
  cumulative Δ: CE vs PE" (`cumCePe`, the gap PE cum − CE cum): PE above CE / CE above PE, crossed, held then flipped
  (`HELD`) and all day, "by ≥ %" of the gap's own range so far (`PAST`) - the same reading as the Net (CE − PE) line under /
  over 0, said as CE vs PE (`tests/signal-backtest.test.mjs`). THE S-R WALLS NEAR ATM (asked for - "S-R walls total CE PE ATM ± 1, 2, 3, CE cross
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
  lines (the S-R walls near ATM's two too). INCREASED / DECREASED BY % IN THE LAST N MIN (asked for - "OI total, OI since
  open, OI cumulative net CE − PE: add an indicator like added this much % in last n min"; `ADDED` / `pctChangeHolds`): OI since
  open and Total OI CE vs PE - "PE / CE OI increased" (`peAddedPct` / `ceAddedPct`) and, asked for next ("increased or
  decreased in min"), "PE / CE OI decreased" (`peShedPct` / `ceShedPct` - unwinding; `PCT_CHANGE_OPTIONS`, the mirror
  the other side's same move) - and the CE / PE / Net cumulative Δ - "Increased / Decreased" (`upPct` / `downPct`); the
  look-back 1 - 60 min (1 = the last minute): the line's % change over the look-back OF ITS OWN VALUE at the look-back's
  start (asked for - "not total OI - it is the value: 50, after 5 min 75, that is a 50% change"): (now − then) / |then| -
  the CE / PE added since the open, the CE / PE total OI, the cumulative Δ line itself (-50 -> -75 = down 50%, -50 -> -25
  up 50%); a start of 0 (since the open, at the open) has none; "by ≥" 10% by default, 0 = any move that way, up to
  1000. A condition's SECOND NUMBER (`param2`) is held to its range by `cleanLine`, passed to the test, shown
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
  `noPivots`, when the rule reads them) and its RSI / EMAs start at 09:15. RSI DIVERGENCE (asked for - "add check for rsi bullish divergence, bearish divergence ... and a condition where I should not have it"; `rsiDiv`, `rsiDivergenceEvents`): on the spot candles of the timeframe, a swing low is a candle under the `pivot` (1 - 10, default 3) candles each side - known that many candles LATER, never before; BULLISH = a lower swing low in price (within 60 candles of the one before) with the RSI at it higher by `RSI gap ≥` points (default 1), BEARISH the mirror on swing highs; an EVENT at the candle that confirms the newer swing, holding for the look-back; "no divergence" = the condition in a NOT group (`tests/signal-backtest-indicators.test.mjs`). OPTION PREMIUM TA (asked for - "TA indicators on
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
  Spot's mirror is the other side's option; a premium's the other option's same one. `tests/signal-backtest-indicators.test.mjs`. OI
  REPLAY'S OPTION DELTA PROFILE (asked for - "add this in our indicator as well"; group `DeltaProfile`, `DELTA_CONDITIONS`):
  the NET option flow on spot rows of the index's default size (`PROFILE_ROWS`) as the card works it out (`optionDeltaMinutes` -
  `prepareDay`'s `odm`): price vs its POC / VAH / VAL / HVN / LVN and the MOST BOUGHT / MOST SOLD rows (`odpPoc` ... `odpSell`,
  `levelCondition` - the levels `deltaProfileLevels`, the cards' own; the mirror of most bought is most sold) and the flow AT
  the price (`odpDelta` - spot in a row of net buying / selling by ≥ % of the largest row, the profile's net positive /
  negative by ≥ % of its volume); every one with "Profile of" (`param4`: the DAY SO FAR - developing, read at each candle from
  the minutes up to its close, `optionDeltaSteps` / `optionDeltaAt` - or the DAYS BEFORE, fixed all day) and "Days" (`param3`,
  1 - `DELTA_DAYS_MAX` 5) - the card's "Previous day" / Days. The sessions before come with the day (`odmPast`,
  `attachDeltaPast` in `signalBacktestJob.js`, only when the rule reads them - `deltaDaysNeeded`): walked back as the cards
  walk (deltaProfileDays.js), the run's own days kept as they load (`rememberDay` - a run asks only the first day's days
  before); a day before that fails = the day not run (retried); without them those lines never hold - the page says "Run
  again" when the rule now reads more than the run loaded, the report lists days with fewer (`noDeltaPast`). The background
  run and the day chart load them too; the LIVE SCAN walks them once an index a day (backed off on a failure - a strategy
  reading them waits, the others go on). `tests/signal-backtest-delta.test.mjs` (a clock = the minutes up to it, the levels,
  the days before, the mirror, a live cut = the whole day's, the loader), `signal-live.test.mjs`. THE OPTION OBV PROFILE and THE FUTURES
  DELTA PROFILE (asked for - "this option delta profile and cdv and obv profile ... add it into our backtest signals ... future
  delta profile as well"; the option delta profile IS the CDV profile, so its conditions above are the CDV's): group `ObvProfile`
  (`OBV_CONDITIONS`) - the OBV column of OI Replay's CDV / OBV profile card read the same way (`deltaAtCandle(..., 'obv')`,
  `optionDeltaSteps`'s `metric`): price vs its most bought / most sold OBV row (`obpBuy` / `obpSell`, each the other's mirror) and
  `obpDelta` (spot in a row of net OBV buying / selling, the profile's net positive / negative), the same Profile of / Days and
  sessions before (`odmPast` - their minutes carry `ceObv` / `peObv`); its volume levels are the delta profile's. Group `CdvProfile` (`CDV_CONDITIONS`, asked for - "you have not added cdv profile") - the CDV column of
  the same card, its own group: `cdpBuy` / `cdpSell` / `cdpDelta`. Both groups take a SIDE (`param2`, `PROFILE_SIDE` - Net (CE − PE), the default, CE or
  PE alone - `optionDeltaSteps`' `side`; a `param2` with `choices` is a dropdown on the page); the mirror (`sided`): Net flips the reading, CE / PE swap
  the side on the same row (a level read the other way, the flow at the price kept). Group
  `FuturesProfile` (`FUT_PROFILE_CONDITIONS`) - OI Replay's futures delta profile card: the near futures' footprint by price in
  `PROFILE_ROWS` (`futuresDeltaSteps` = `futuresDeltaProfileOf` of the bars up to each minute, held equal in the test), its POC /
  VAH / VAL / HVN / LVN / most bought / most sold rows (`fdp...`, `levelCondition`'s `barsOf`) and `fdpDelta`, READ AGAINST THE
  FUTURES' PRICE (`d.price` when `priceSource` is 'futures' - none without it); the day's bars come with the order flow
  (`FLOW_PROFILE` - `orderFlowNeeded`: NONE 0 / DELTA 1 / PROFILE 2 / BOOK 3; `orderFlowUrl` then asks the footprint's rows and
  `backfillBars=true`; `attachOrderFlow` keeps `fdm` = `footprintBars`, live only the completed minutes), the sessions before as
  the card walks them (`attachFuturesPast` - `fdmPast`, `futuresDaysNeeded`, threaded through the page, the day chart, the
  background run and the live scan as `futuresPast`); without them those lines never hold. `tests/signal-backtest-profiles.test.mjs`. THE OI (CE − PE) PROFILE (asked for - "cdv obv profile, option delta
  profile, net ce − pe, oi ce − pe, future delta profile - I need all"; the option delta profile is the CDV and its Net CE − PE):
  group `OiProfile` (`OI_PROFILE_CONDITIONS`) - OI Replay's option card's "OI (CE − PE)" side: at each spot row the call OI added
  less the put OI added (`oiNetSteps` on `prepareDay`'s `oim` = `optionOiMinutes`, the current expiry's; the sessions before as
  `oimPast`, put on by `attachDeltaPast` with `odmPast` from each day's record's `oi` - `rememberDay` keeps it, the live scan
  too), NEGATIVE = puts written = BULLISH: price vs the row with the most puts written (`oipFloor`) / calls written
  (`oipCeiling`, each the other's mirror), `oipDelta` (spot in a row of puts / calls written, the net CE − PE negative /
  positive by ≥ % of all the OI added); the same Profile of / Days. Its SIDE (`param2`, asked for - "add net ce-pe of oi as well" - `OI_SIDE`):
  OI Net (CE − PE), the default, CE OI alone or PE OI alone - `oiNetSteps`' `side`, read so NEGATIVE is always BULLISH (CE: calls unwound; PE: MINUS the put
  OI, puts written); the mirror (`sided` 'oi') is the usual one on the other side (floor <-> ceiling and CE <-> PE). CLUSTERS (asked for - "where bunch of bull cluster, bear clusters ... to all these signal indicators"): every
  profile group has a cluster condition (`odpZone` / `cdpZone` / `obpZone` / `oipZone` / `fdpZone` - `zoneCondition`): the strongest GREEN (bullish) and
  RED (bearish) run of ADJACENT rows of one sign in the profile's own data (`deltaZones` - each step's `zones`; a gap or a row of the other sign ends a
  run, its strength its delta added up; the OI profile's bullish = negative), read as a band: price above / below it (by ≥ %), inside it, touched and
  closed back above / below (within %), crossed above / below in the look-back; the mirror = the other colour the other way (a CDV / OBV CE / PE side:
  the same colour the other way on the other side - `sided` 'zone'). Each candle's clusters from the minutes up to its close. THE FUTURES ORDER FLOW
  (asked for - "add futures delta and cumulative delta and liquidity heatmap indicator in signal backtest as well"; group
  `OrderFlow`, `FLOW_CONDITIONS`; the data `orderFlowFeatures.js`): the Order Flow page's own day of the near futures
  (`/api/order-flow/{u}/day/{date}`, `orderFlowUrl` - no prints; the Δ alone in one row a bar, with the heatmap in the Order
  Flow page's default rows, NIFTY 1 / BANKNIFTY / SENSEX 5, and `FLOW_HEATMAP_COLUMNS` 750 snapshots - ~one per 30 s)
  laid on the day's minutes (`orderFlowMinutes`, each from data up to its minute's end): FUTURES Δ (`futDelta` - the
  candle's buy − sell, its minutes' added: buyers / sellers ahead by ≥ % of its volume, the same over the look-back, a big
  candle ≥ N x the average |Δ| before it, selling absorbed = Δ negative on a candle that closed UP and the mirror), the
  FUTURES CUMULATIVE Δ (`futCvd` - the running Δ from 09:15: sign, turned, flipped after the morning, rising / falling /
  stable, a new high / low of the day, divergence - it FOLLOWS price - and % change, read as the OI cumulative Δ lines are)
  and the LIQUIDITY HEATMAP read by the Order Flow page's `liquidityMap` at each minute's end (its 10-minute window of
  snapshots and the minutes completed - nothing after the minute): `liqRead` - its read (absorption / exhaustion at a bid /
  offer wall, a wall broken or pulled, a vacuum, a drift, any bullish / bearish read; events, so no number, in the
  look-back), `liqWalls` - the nearest bid wall under / offer wall over the price that STAYED in the book (near it, touched
  and held, broken, building / pulling by its last 2 min against its 10-min size, the bigger side), `liqLean` - the book's
  lean within 10 rows and a thin zone just above / below; all on the FUTURES' own candles (the heatmap is the futures'
  book). A timeframe's candle: Δ / volume its minutes' sums, CVD / walls its last minute's, a read in any minute of it
  (`flowView`). Asked only when the rule reads it (`orderFlowNeeded`: none / Δ / book), once a day (`attachOrderFlow` - the
  page's kept days get it after, a later rule needing the book asks again; the background run, the day chart and the LIVE
  SCAN - today's from the server's memory, cut to the completed minutes, backed off on its own, a strategy reading it waits
  - load it too). A day the server did not record live has its Δ ESTIMATED from 1-minute candles and NO book; a 404 = no
  order flow (the day runs, those lines never hold); a server error = the day not run (retried). The report lists the days
  with none (`noFlow`), an estimated Δ (`flowEstimated` - all of it, or the minutes before the recording began) and, the
  heatmap read, no book (`noBook`). Live, the book's 750 snapshots are sampled from what the server holds at the time, so
  a heatmap read can differ slightly from the same day backtested after the close. `tests/signal-backtest-flow.test.mjs`
  (each condition both ways and not without its part, the liquidity map's own read, a cut part way = the whole day's, the
  loader, the report), `-job` (the background run = the page's) and `signal-live.test.mjs`. EVERY comparison takes a "by ≥ %"
  (asked for - "add % for all even for crossing"), crossings and turns too, 0 = any (the default - a rule saved before
  reads as it did, `atLeast` / `frac`: a missing number is 0) and the mirror keeps it; only a 🎯 (an event), the liquidity
  map's reads (events) and the three "inside" (the IB, the value area, the CPR) have none - RSI's number is its level (`tests/signal-backtest.test.mjs` holds the list). What the % is of: price v a level (VWAP, the OI /
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
  the day not run, "X: <why>"). Each day loads BOTH indices - the page (`results[].tradeDay`, Compare all too), the
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
  add it in dropdown ... i can modify"; `signalTemplates.js`): `RULE_TEMPLATES`, 24 rules from the page's own conditions in
  seven families (`TEMPLATE_FAMILIES` - delta profile, in order (THEN), trend, reversal, breakout, options & volatility,
  premium selling), each read through a different lens (positioning, flow, dealer gamma, volatility, auction structure,
  momentum, the premiums' own tape, the option delta profile), written for the bullish side with the Mirror on, with its
  `idea` (why) and its own `settings` (timeframe, SL / target, trail / time stop - what it does not name is OFF). The DELTA PROFILE four (asked for - "add strategy for delta profile ... previous day's highest buy and
  sell, check what's best we can do"; `PREV_DAY` = "Profile of: Days before", 1 day): yesterday's option delta profile's
  MOST BOUGHT row (bullish option flow piled up - support) and MOST SOLD row (bearish - resistance) read four ways -
  `dpBuyersDefend` (a dip into the most-bought row closing back above it, today's flow at the price buying; mirror the
  most-sold row rejected, selling), `dpSellersBroken` (a cross above the most-sold row, today's net flow bullish, over
  VWAP, trailed), `dpFailedBreak` (under the most-bought row THEN back over it within 30 min - trapped sellers) and
  `dpSellPut` (over the most-bought row, today's net flow bullish, sideways 30 min, the straddle under its decay line -
  sell the put; the flow keeps the two sides apart between the rows); each fires on its case LONG and mirrored SHORT and not
  without each part (`tests/signal-templates.test.mjs`). They read the session before each day: the run, a background run
  and the live scan load it for the rule (`deltaDaysNeeded`); Compare all puts it on the days loaded first
  (`attachDeltaPast` - the run's own days not asked again; stopped at the first failure, the days left said under the
  table). Unmeasured here (no market data in the repo) - Compare all on real days ranks them. The rule card's "Templates" dropdown (grouped,
  searchable, each with its idea) LOADS one onto the page - its rule and levels (`withTemplate`: the page's index, lots,
  charges, max trades, cooldown, day limits and expiry-day choice kept) - to run and edit like any rule; "Undo" puts back
  what was there. "Compare all" (`compareTemplates` / `templateRow`) runs every template over the days the PAGE'S run
  loaded (no load but the delta templates' session before - the prepared days; one template a tick, a progress bar) through the same engine and report, ranked by
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
  its history), and a TODAY column (asked for - "last day should show current day trades, not last day"; it was the last
  day's report): the list's `todayTrades` (`SignalStrategyStore.Glance` / `TodayOf` - the trades file's rows of TODAY, written
  as each signal comes: how many, how many still open, closed, won / lost and the closed ones' net) - "Today (Fri 13 Nov):
  ₹X · N trades · K open", won / lost and today's alerts under it, "no trades yet" before the first; refreshed with the list
  (each minute while one is live - a page timer); the days before are in History; each account its own, an admin every account's (`SignalStrategyController`, `/api/signal-strategies`,
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
  `premiumRsi`), the straddle's 15-min change, days to expiry and the weekday - 66 of the 95; the other 29 (asked for - "market profile and volume profile, LVN HVN VAL VAH POC + OI details, cumulative delta, delta profile, futures profile ... use all of these"; `profileFeatures.js`, FEATURES in `featureFinder.js`) are the DEVELOPING profiles of the day so far, each built only from the candles up to its own (`tests/feature-finder.test.mjs` checks every one against the page's own `dayVolumeProfile` / `volumeZones` / `tpoProfile` built from scratch, and a day cut part way against the whole day's): the VOLUME profile of the day (the near futures' volume, else the index's) as spot's distance in % from its POC / VAH / VAL / HVN / LVN plus where spot sits in the value area and its width; the MARKET (TPO) profile's POC / VAH / VAL and the single prints above / below spot; OI Replay's OPTION DELTA PROFILE's POC / VAH / VAL / HVN / LVN / most bought / most sold row, the delta in spot's row and the profile's net (`deltaAtCandle`); yesterday's HVN / LVN; the 5-minute change of the ATM +/- 1 / 2 strikes' OI, ATM +/- 3, and the CE / PE cumulative Delta's 15-minute move. A dataset made before them lacks those columns - run the Feature finder again for them. Each indicator is held to
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
  Not in it: the order flow's footprint delta and the book heatmap (kept about a year - 252 trading days - and only from when the server began recording them; the rule builder has them - THE FUTURES ORDER FLOW above) and the market profile's TPOs. It
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
- ICEBERG / BIG ORDER TELEGRAM IS THE SERVER'S (asked for - "iceberg order, big order should always receive messages on
  telegram, they should run server side"; `OrderFlowTelegramAlerts` - a hosted service, every 2 s in the trading session,
  `MarketHours.BackgroundScope`, no Dhan call - it reads the Order Flow engines' memory): for every index's near futures
  (`OrderFlowService.EngineFor`), the engine's `AlertReads(afterSeq, minQty)` (the prints since the last look - trades carry
  an increasing `Seq` - at least the big order size, and the icebergs) stepped by `OrderFlowAlertWatch`: an ICEBERG once,
  when it has traded the set lots ("🧊 Iceberg NIFTY futures: hidden BUYER at the bid 24500 · 120 lots traded there (15 shown
  at most) · 3 refills · still active · 10:00:02"); BIG ORDERS gathered, at most a message every `BigOrderGap` 20 s an index
  (a channel takes ~20 a minute), each print a line ("BUY 150 lots @ 24512.5 · 10:00:01"), `MaxListed` 10 then "… and N
  more". The icebergs sent are kept for the day (`order-flow-alerts-sent.json` under `Storage:ScannerRunnerPath`), so a
  restart sends none twice; big orders start from the print the restart finds. The sizes per index (`OrderFlowAlertSettingsStore`,
  `order-flow-alerts.json`, 100 / 100 lots by default, 0 = off): `GET /api/order-flow-alerts` (Admin / User), `PUT
  /api/order-flow-alerts/{u}` (Admin only) - the Order Flow page's "Telegram (server)" boxes (`OrderFlowTelegramSettings.jsx`).
  The page no longer sends its own iceberg Telegram (its switch and lots are gone - the server covers it, page open or
  not). `OrderFlowTelegramAlertsTests.cs`.
- TELEGRAM GETS ONLY THESE OI DIVERGENCE AND PROFILE-LEVEL SIGNALS (asked for - "remove telegram signal of oi divergence, hvn
  lvn signals; only send signal for 15 min divergence, and lvn and poc signals, that is all"): OI DIVERGENCE (`OiDivergenceMonitor`)
  is two reads - the 1-MINUTE one ("OiDivergence": three 1-minute closes in a row, MinMovePct 0.05) is the OI Replay page's popup
  only (`Telegram` false - also the class default now), and the 15-MINUTE one ("OiDivergence15m", `DivergenceOptions.
  FifteenMinuteDefaults` bound over by the section - BarMinutes 15, one candle, MinMovePct 0.10, cooldown 30 min, from the
  09:30 candle): the last COMPLETED 15-minute candle of the session from 09:15 (`PriceOiDivergenceDetector.SessionCandles` -
  a candle counts once its last minute closed; checked when the minute that completes one closes - `CompletesCandle`) closed
  beyond the one before while the OI at the strike held, the OI read at each candle's END (its last minute - `BarMinutes`
  in `Evaluate`; a 1-minute bar unchanged), to TELEGRAM as "[OI divergence 15m] <b>NIFTY</b> DISCOUNT zone" (`TelegramText`)
  and to the page's popup ("· 15 min"). PROFILE LEVELS (`profileAlerts.js`): every level still pops up / chimes on the
  pages and is logged by the server alert runner, but only one naming a POC or an LVN - an LVN gap, a confluence with either -
  goes to Telegram (`sendsProfileTelegram`, in `IndexScanner.checkProfileLevels` and the pages' `useProfileAlerts`); an HVN
  or single prints alone do not. `PriceOiDivergenceTests.cs`, `tests/profile-alerts.test.mjs`, `tests/scanner-runner.test.mjs`.
- EVERY TELEGRAM MESSAGE IS KEPT (`TelegramMessageLog`, `Storage:TelegramLogPath` - /app/data/telegram-log, in
  docker-compose AND the Dockerfile): `TelegramAlertService.SendAsync` - the ONE place every message goes through, the
  server's alerts and the pages' `POST /api/alerts/telegram` alike - writes each one as it goes: a CSV a day (IST), time IST /
  UTC, status (`sent`, `failed`, `off` = Telegram not configured) and the text exactly as sent (newlines escaped on one
  line), 400 days, at most 20 000 a day; never throws into the send. `GET /api/telegram-log?from&to` (Admin / User, 92 days a
  request, the last 7 by default) gives them back as plain text (asked for: "keep telegram signal on server side as
  well"). `covered-from.txt` marks since when it records (written once; a log from before the mark counts from the day after
  its first file): `Covers(day)` = it was recording before that day's 09:00, so it holds the whole day.
- THE PAGE'S LOAD IS SERVER FIRST (asked for - "server side + caching, if it is not there then telegram fetch";
  `TelegramSignalMessages`, `GET /api/telegram-history/signals?from&to`, Admin / User, at most 92 days): each IST day from
  the server's log when it `Covers` it (Telegram not asked), else from the days FETCHED FROM TELEGRAM BEFORE
  (`TelegramDayCache` - one gzip JSON a day in `from-telegram/` under the log's folder, 400 days; an empty day - a weekend, a
  holiday - kept empty), else FETCHED FROM TELEGRAM now (the reader below - only the days missing, consecutive ones in one
  request of at most 31 days) and, a whole PAST day, kept - so a day is asked of Telegram once; today not kept (fetched
  again until the log covers it); a fetch cut short at MaxMessages is "partial" and not kept. Telegram not connected / not
  answering: those days "missing" with why (asked once a load), the rest still shown. Each day says where it came from
  (`days: [{ date, source: server / cache / telegram / partial / missing, count, note }]`), each message its `status` (the
  log's sent / failed / off; Telegram's "sent") - `TelegramSignalMessagesTests.cs`.
- THE CHANNEL IS ALSO READ FROM TELEGRAM ITSELF (asked for - "we can fetch data from telegram right"; `TelegramChannelReader`,
  `TelegramHistoryController` `/api/telegram-history`): the Bot API can SEND but has no call that reads a chat's history (and
  a bot is never told of its own posts), so the server reads the channel through a Telegram USER account (MTProto -
  WTelegramClient, behind `ITelegramUserClient` so tests use a fake) that an ADMIN signs in ONCE on the page: api_id /
  api_hash from my.telegram.org (or `Telegram:ApiId` / `Telegram:ApiHash` in the config - the hash a secret, environment only),
  the phone, the code Telegram sends to its app, the 2-step password if the account has one (`POST connect` / `code` /
  `logout`, Admin only; `GET status` / `GET messages?from&to`, Admin / User). ONLY `Telegram:ChatId` (the bot's own chat) is
  ever read - a User never reaches the admin's other chats. The reader keeps NO messages: each Fetch asks Telegram for the
  IST days picked (at most `MaxDays` 31, `MaxMessages` 20 000). What stays on the server is the SIGN-IN: WTelegram's session
  (encrypted with the api hash) and `reader.json` (api id / hash unless configured, the phone) under
  `Storage:TelegramSessionPath` (/app/data/telegram-session - docker-compose AND the Dockerfile; gitignored with
  telegram-log/) - resumed after a restart with no code, dropped (and "connect again" said) when Telegram ended it, removed
  by Log out (ended on Telegram's side too). The status never carries the hash, a code or the full phone (masked). One
  request at a time; a click, nothing polls; no Dhan call. `TelegramChannelReaderTests.cs`. The ORDER FLOW alerts are the only
  Telegram the server sends by itself (above) - nothing else moved server side.
- The COMPONENT CHECK page (`/component-check` - every OI Replay card's reads tested on past days against the price after
  them) was REMOVED on request ("remove ... this component page, code and page, we do not need it"), with its background run
  kind "components": `SignalBacktestJobService.Kinds` is "backtest" / "features" again, and a run of a kind no longer offered
  still queued from before is FAILED, never started (`TryStartNext` - `SignalBacktestJobServiceTests.cs`). `DaysPicker.jsx`
  (split out for it) stays - the Signal backtest's days picker.
- The TELEGRAM SIGNALS page (`/telegram-signals`, `TelegramSignalsPage.jsx`, the reading `telegramSignals.js`; asked for -
  "a page which will read the messages and show me how the price reacts after those signals ... show correlation between
  price and signals"): two sources (`optionanalytics.telegramSignals.source`) - SERVER + TELEGRAM (the default: Load =
  `/api/telegram-history/signals`, server first as above, a line saying how many days came from where and why any is
  missing; `TelegramConnect` on the page signs the Telegram account in - an admin's job, others see whether it is
  connected) or a Telegram Desktop export (result.json, read in the browser - `parseTelegramExport`, its `date_unixtime`) -
  read as SIGNALS (`parseMessage` - the code's own texts: iceberg, big order (a
  message of several prints = a signal each, at its own time), 🎯, OI S/R break, sudden OI wall, the scanner, paper / live
  orders, saved strategies' entries, confluence, OI DIVERGENCE (the server's "[OI divergence] … DISCOUNT zone" = bullish - spot
  fell, the puts' support held - "PREMIUM zone" = bearish, at the level spot ran to; it read as no side before and was left
  out of the summary), profile, price, trigger; exits and reports are kept apart (`exit`, not a signal - a trigger's
  follow-ups "[SQUARED OFF]" / "[SQUARE OFF …]" / "[HEDGE CLOSE …]" / "[ORDER …]" too); its index named, else guessed from the price (a profile alert names only futures / spot); its
  side - bullish / bearish / none) and the index's SPOT 1-minute bars of the day after each (`/api/oi-replay/{u}/spot-day` -
  the server's memory / disk; each index and day once, kept for the tab - a past day): `reaction` - the price at the signal
  (the close of the last minute completed by then, else its own minute's open), the move 5 / 15 / 30 / 60 min later IN THE
  SIGNAL'S DIRECTION (a bearish signal that fell made +), the best / worst in the hour; `reactionSummary` per kind (average %
  and points, how often it went its way, the CORRELATION `corr{h}` - Pearson's r of the signals' side, +1 / -1, with the raw
  move in % of the price: needs both sides and 3+ signals - and best / worst) plus an "All signals" row (kind `all`, last),
  the kinds sorted by the horizon picked; a row's day chart with every signal of
  it marked; CSV. A click loads - nothing polls. Not admin-only. It feeds no strategy or alert
  (`tests/telegram-signals.test.mjs` - the texts read from the senders themselves, `signalLive.js`'s included).
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
- ORDER FLOW in real time (`OrderFlowEngine`, `OrderFlowService`). Dhan sends a tick per
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
  socket) carry the book alone, no trades. THE BOOK: 200-LEVEL FIRST, 20-LEVEL THE FALLBACK (asked for - "we need to change to
  200 and fallback to 20"; `OrderFlowService.EnsureDepthAsync`, `OrderFlow:DepthMode` "200", the default): every NSE futures
  contract tracked - the nearest and one the Order Flow page picks (it was always on the 20-level feed) - goes on the
  200-level feed (`OrderFlow:MaxTwoHundredDepth` 2 connections - Dhan's 5 sockets an account), the nearest first (one with
  no connection free takes a picked contract's); the 20-level feed when no 200-level connection is free or its book has not
  arrived within 90 s of subscribing (kept on the 200-level one - OnDepth uses it again once it streams); judged again at
  every resolve (5 min). "20" / "5" still pick those feeds (`OrderFlowDepthFeedTests.cs`). So one packet's volume is often many trades, at several prices, both ways, and
  the rule in use gives ALL of it its last trade's side and price. The comparison rule "LTQ + book" (`RuleLtqBook`,
  `LtqBookDelta` / `BookTaken`, the card's own column; a day saved before it keeps the other three and shows "—"; a minute
  restored from such a checkpoint and traded on shows none) gives only the last trade (the LTQ, held to the packet's volume)
  that side and splits the rest of the second by what was TAKEN off each side of the PREVIOUS market feed packet's 5-level
  book (`_feedBids` / `_feedAsks`, fresh as the quote): ask levels the new best ask moved past plus the drop at it = bought,
  the bids the mirror = sold - LESS what the last trade itself took on its side (it is in the LTQ part); MORE taken than the
  rest traded = orders PULLED: each side scaled to the rest, its share kept; LESS = the leftover traded at the touch
  (refilled / hidden orders): split by bulk volume classification, Phi(the price's move / the day's typical
  packet-to-packet move BEFORE this packet - `_packetMoveSquares`, from `MinPacketMoves` 5 packets), else by the move's
  direction, else half and half (asked for - "are we using the best formula, considering all parameters": LTP, LTQ,
  cumulative volume, the Full packet's 5-level book; ATP is a float32 - too coarse to recover a second's average price -
  and the total buy / sell quantity and OI are not trades). Each bar's tallies also COUNT the packets that carried volume,
  those holding MORE THAN ONE TRADE (volume over the LTQ) and the volume in them (`TallyPackets` / `TallyMultiPackets` /
  `TallyMultiVolume` after the four rules - a day saved before them reads the rules and none for these), shown on the card
  as "Several trades" (`multiTradeShare` in `deltaRules.js`, a column and the day's total): how often the rule in use
  reads several trades as one, at one side and one price. It is a comparison only - the footprint stays on the rule in use
  until it is chosen against Dhan's candles. A trade with NO side
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
  typical change), the typical change the root mean square of the changes BEFORE that minute, `TypicalChanges`, started
  from `SeedWeight` 5 minutes of `SeedShare` 0.04% of the day's first price - it was the whole day's: a replayed minute
  depended on the afternoon after it, a live morning shifted at every load; then the changes up to AND INCLUDING the
  minute: its own change in its own sigma put the 09:15 minute - the day's heaviest - at 84 / 16 by its direction alone,
  however small the move (`cvdBackfill.estimateFlowMinutes` the same)) and lead the
  charts (`withBackfill`, drawn faded): on a 3 / 5 / 15-minute timeframe those in the first recorded candle before its
  first recorded minute count too (`firstMinuteMs` - they were dropped from the delta from the open). OI Replay's futures delta panes are LIVE: the "orderFlowDelta" push (group
  `ofd:{U}` - `OrderFlowService.DeltaGroup`, `OrderFlowEngine.LiveDelta`: the last two minutes' buy / sell, a few bytes;
  External may not join it) merged as the minutes trade (`mergeDeltaPush`; a missed minute / another contract or day
  loads the day again, once) - they reloaded the whole day every 60 s. `tests/cvd-backfill.test.mjs`. The Order Flow
  page's footprint "Delta per row" tick (`rowDelta`, `optionanalytics.orderFlow.rowDelta`, off by default - the cells as
  they were) adds a third column to every row: its buy - sell, green / red, shaded against the bar's largest (`rowDeltas`).
  The numbers NEVER RUN INTO EACH OTHER (asked for - a phone's bars with the delta column on were unreadable: "if the area
  is too small show delta only"; `footprintTextLayout` in `footprintText.js`, one choice for every bar on screen from the
  WIDEST sell / buy / delta string, measured once): sell x buy (+ delta) at the largest font that fits, 12 down to 8 px (the
  delta column widening from its 30% when its number needs it); else, with the delta column on, the ROW DELTA ALONE across
  the cells (the sell / buy cells give way, an imbalance / stacked row keeps a mark on its edge, the hover still shows
  every figure); else colours only - and a bar too narrow for two cells and the delta column shows the delta's colours
  alone (they ran into the next bar). Text that fits as before is drawn exactly as before. The strip under the bars drops
  its "Δ" / "ΣΔ" / "Vol" labels when they do not fit the bar (`tests/footprint-text.test.mjs`).
  AUCTIONS (the "Auctions" tick, on by default, `optionanalytics.orderFlow.auctions`; every footprint - the OI Replay
  review's too): each bar's high and low read on its sell (bid) x buy (ask) rows (`auctionOf`, in `analyzeBars`) - FINISHED
  (FA) = no selling at the top row (0 x N) / no buying at the bottom row (N x 0): that side ran out; UNFINISHED (UA) = both
  sides traded at the extreme - a dotted line runs on until a later bar trades back into that row (`unfinishedRevisits`),
  to the right edge while open; the other side alone there = neither. Not on an estimated day (its rows are a spread, not
  trades). `tests/order-flow-auction.test.mjs`.
  COT HIGH / LOW (asked for - "in order flow footprint add COT commitment of traders"; Sierra Chart's footprint COT, NOT the
  CFTC report - NIFTY has none; NSE's participant OI is the GEX card's): the "COT" tick (`optionanalytics.orderFlow.cot`,
  on by default) adds two lines to the strip under every footprint bar - COT H = the delta (buy − sell) traded AFTER the
  bar's last NEW high, COT L = after its last new low (+ green / − red, "—" when not known). The ENGINE keeps it per
  minute bar from every trade in order (`MinuteBar.Cot` [after high, after low] - a trade making a new high starts the
  count at 0, the trade itself not counted; a neutral trade adds its half-and-half; kept with the day -
  `OrderFlowDay.Bar.Cot`; `OrderFlowBar.CotHigh` / `CotLow`; null for an estimated bar and for a minute restored from a
  day saved before it, even when traded on after). `aggregateBars` adds the minutes up EXACTLY for 3 / 5 / 15 min: the
  minute that FIRST reached the bar's high brings its own count, every later minute its whole delta (an equal high is not
  a new one); such a minute with none = the bar none (`OrderFlowCotTests.cs`, `tests/order-flow-cot.test.mjs`).
  THE COT READ - BULLISH / BEARISH (asked for - "show bullish or bearish ... how institutional platforms use it"; `cotRead` /
  `COT_SHARE` in `orderFlowMath.js`): as the footprint platforms showing COT (Sierra Chart's Numbers Bars, ATAS, Exocharts)
  are read - what the aggressors did AFTER the extreme against where the bar CLOSED (its place in its range), a COT counting
  only at >= 20% of the bar's volume: at the HIGH, sellers after it + closed in the lower half = REJECTED (bearish), buyers
  after it + closed in the lower half = BUYERS TRAPPED / absorbed (bearish), buyers after it + closed in the top 30% = STILL
  PUSHING (bullish); the LOW the mirror; reads both ways = the larger COT for the volume, an equal pair none. Drawn as a pill
  outside the extreme (green "COT ▲" / red "COT ▼", at the end the read is about), a legend entry, and a line under the
  footprint (`CotReadLine`: the newest read with its reason, COT and share, "bar still forming" live, and the bullish /
  bearish count on screen). With the "COT" tick. A read - no alert, strategy or order (`tests/order-flow-cot.test.mjs`).
  THE LIQUIDITY HEATMAP (`DepthHeatmap` in `OrderFlowCharts.jsx` - the Order Flow page's and the External page's; asked
  for - "can we improve the liquidity heatmap on the data we have captured"; the rules pure in `heatmapLayout.js`,
  `tests/heatmap-layout.test.mjs`): each book column sits at its TIME and runs to the next (`columnSpans`) - the columns are
  NOT evenly spaced (the loaded day is the server's sample of every 2 s snapshot, ~900 of them - ~12 s apart on a morning -
  and the live feed adds one every 2 s), and drawn one width each the live part came out stretched against the time axis
  while the prints, signals, icebergs and VWAP (drawn by time) drifted off the cells; now the cells, the price line, those
  and the axis agree. A stretch with NO BOOK - a jump past max(5 x the spacing around it, 30 s) (a restart) or columns with
  no levels (the depth feed reconnecting) - is hatched and named "no book", the price line broken across it, its hover
  "No book recorded HH:MM:SS – HH:MM:SS" (it was a black stripe the price line ran across). The STACK / PULL / SWEEP / SPOOF
  pills are placed strongest first and never over each other (`placeLabels` - above the anchor, else below; no room = a
  small dot). The hover adds how long the level has rested (`restingSince` - back while that side held at least half its
  size there, stopped by less, no book or a gap): "resting since 10:36:12 (10 min)" / "just placed" - a wall that stays vs
  one flashed (a spoof). AS THE PROFESSIONAL HEATMAPS DRAW IT (asked for - "check the liquidity heatmap for the best possible
  representation ... how professional systems do it"; Bookmap's heatmap settings / main chart - `heatmapLayout.js`,
  `tests/heatmap-layout.test.mjs`): the COLOUR is Bookmap's PERCENTAGE CUTOFFS (asked for - "use it in professional way only", "if there are any deviation
  from what industry uses you do"; `HEAT_BANDS`, `heatScale` / `heatLevel`): each colour band pinned to a SHARE of the
  sizes in view (adaptive to what is on screen) - the bottom 50% the dark background, up to the 80th percentile dark ->
  blue, the 93rd cyan, the 98th yellow, the top 0.5% red, sizes interpolated between those percentiles' values - so the
  picture has the same balance whatever the day's size distribution (a straight line between two size cutoffs lit a real
  5-point book cyan almost everywhere), AND a WALL is always hot: a level at `WALL_RATIO` 4x the median size in view (the
  app's own `findWalls` rule) at least yellow, red from 8x - else a busy book with many walls pushed them down the bands
  (`tests/heatmap-layout.test.mjs` - the shares on any book, the wall rule). A Low / Normal / High "Contrast" choice with
  a lifting curve was tried and REMOVED - it lit up 20 - 34% of cells, confetti; the card's "Pro colours" tick (asked for - "keep the old heatmap as
  well, when unticked the older will be shown"; `optionanalytics.orderFlow.heatPro`, ON by default; `classicColours` /
  `heatScale(q, { classic: true })`) unticked = the ORIGINAL heatmap's colours, a straight scale from 0 to the 98th
  percentile of the sizes in view - with "Volume dots" and "Book column" unticked too, the heatmap as it first was; THE PRICE LINE - the mid as a BOLD WHITE step line (2.5 px on a dark 5 px outline - the one colour nothing else on
  the heatmap uses; asked for twice - "I cannot see the price line": green / red bid / ask lines vanished into a real day's
  green / red cells, STACK / PULL pills and walls), zoomed in (a row 3 px or more) with the BEST BID / BEST ASK as thin
  DOTTED green / red guides (`bestQuotes`), all DRAWN LAST - over the volume dots and the prints, under the signal pills
  (`drawPriceLines`); VOLUME DOTS - every traded minute at each heatmap row, sized by its volume against
  the largest in view (at most half a row / half a minute across), split green bought / red sold by its share
  (`volumeDots` on the page's `view.minuteBars` - cut at the replay clock; "Volume dots", on by default,
  `...heatVolumeDots`; the big prints still drawn on top, ringed); the CURRENT ORDER BOOK column at the right of the plot -
  the last column in view (the book at the clock) as bars, bids green / offers red, the best of each brighter, its hover
  the level's size and resting time (`cobBars`; "Book column", on by default, `...heatCob`; 64 / 44 / 32 px by width). The
  External page's heatmap passes none of these props and stays as it was (only the contrast curve, Normal, is shared).
  Drawing only: `liquidityMap` / `liquiditySignals` / `pullStackSignals` (what the Signal backtest reads) are untouched.
  CHART AND ORDER BOOK (asked for - "on Order Flow the liquidity heatmap on the futures chart, like the one I sent";
  `OrderBookChartCard.jsx`, the reading `bookLadder.js`, the drawing `bookLadderPrimitive.js`; under the heatmap card): the
  futures candles (own timeframe, 1 min by default - `optionanalytics.orderFlow.bookChartTf`; the newest ~70 shown, 36 on a
  phone, until dragged) with the BOOK AT THE CLOCK standing beside them in rows of N points (NIFTY 5, BANKNIFTY / SENSEX
  10 - `LADDER_ROWS`, picked per index, `...bookChartRows`; a whole number of the footprint's rows - `ladderRow`):
  BUYERS left of the row's price - bids WAITING (solid green, their lots / qty at the bar's end) and BOUGHT there (the
  light strip under it), SELLERS right of it - offers waiting (red) and SOLD; what was PULLED there as an orange dashed
  outline running on past the bar; a BIG row (>= `BIG_FACTOR` 2.5x the median waiting row of its side) brighter. Over
  the chart: the futures price, the book's lean within `ROWS_EACH` (12) rows, the NEAREST BIG BUYERS under the price and
  BIG SELLERS over it (adjacent big rows one zone - `nearestZone`), also as faint bands across the candles and dashed
  lines on the axis (no caption - it covered the ladder). Bought / sold = the footprint's 1-minute bars overlapping the
  last `windowMin` minutes (1 / 2 / 5 / 10 / 15, default 5, `...bookChartWindow`); PULLED = a drop between two book
  columns at a row AWAY from the touch in both (the PULL signals' rule) and still inside the newer book - a level that
  fell off the far edge of the 200 levels as price moved is out of view, not cancelled (`pulledByRow`). Live the push's
  whole book, replayed the column at the clock; nothing after the clock (`tests/book-ladder.test.mjs`). A day with no
  depth (estimated / rebuilt) says so. Drawing only - it feeds no signal or strategy.
  SCORED ABSORPTION / EXHAUSTION on the footprint (asked for - "is there any better way to identify exhaustion / absorption
  on the footprint ... please work on this area", "yes, you fix absorption exhaustion"; `flowReads.js` - `scoredFlowReads` /
  `withScoredReads`, `tests/flow-reads.test.mjs`): the Order Flow page's footprint and signal list show ABS / EXH from this
  read, each mark with its 0 - 100 SCORE on the pill ("Scored ABS / EXH" box, on by default -
  `optionanalytics.orderFlow.scoredReads`; marks from "score ≥" 40 / 50 (default) / 60 / 70 - `...scoredReadsMin`). THE
  BIAS AND OI REPLAY'S REVIEW FOOTPRINT KEEP `analyzeBars`' FIRST ONE-BAR RULES
  - the page marks a COPY of the bars (`markedBars`); an estimated day keeps the candle rules. ABSORPTION = an effort
  that failed at a price (at the low, bullish; the high the mirror), parts 0 - 1 weighted 30 / 20 / 20 / 15 / 15: effort
  (the selling in the bar's bottom third - at least two rows - with the same prices in the bars before FOR AS LONG AS PRICE
  KEPT TRADING THERE (back to the first bar that did not touch them), against 1.5x a usual bar's selling; the bar's own at
  least half a usual bar's and 1.5x the buying there - required, and effort >= 0.5), result (closed above the zone, >= 30%
  off the low - required), efficiency (sellers ahead on the bar yet it closed up, or moved less a lot of delta than usual),
  context (a break of the STRUCTURE 0.7 - a new session low, under the last swing low, a new low of the move - a retest of
  it 0.5, past the bar before 0.35, + 0.5 at a level - the bar's OWN VWAP, yesterday's POC / VAH / VAL / HIGH / LOW), book
  (what traded there against the most the bids showed through the bar, and how much still stands; an ICEBERG the engine
  caught on the bid in the zone during the bar and detected by its end - `icebergs`, the page's `view.icebergs` - = 1). EXHAUSTION =
  participation fading at a new high of the STRUCTURE (bearish; the low the mirror), closed >= 25% off it, weights 20 / 25
  / 15 / 15 / 25: less volume than the last push (the last bar that made a new high of the structure; none = the usual
  bar), less delta (none at all = 1; + 0.3 on a lower cumulative delta), little in the top TWO rows (one row is an artefact
  of Dhan's one-second packets; a FINISHED AUCTION there - nothing bought at the top - = 1), the POC not following, the rejection. NO FIXED BAR COUNT (asked for - "like how a human
  reads it ... not 5 - 10 candles, adaptive and dynamic"; "I am only loading the current day - 10 bars come after 50 min"):
  "usual" (volume, selling, buying, range, move per delta) = the median of TODAY's bars before the bar together with
  YESTERDAY's bars of the same timeframe within 30 min of its time of day (`prior` - the page passes the previous session it
  already loads, `aggregateBars` of `fetchPreviousSession`; `PRIOR_CLOCK_MS`), so it reads from the first bars of the day
  and today's own bars weigh more as they come; the structure = `swingTracker` (a zigzag: a swing confirmed once price comes
  back from it by `swingRanges` 1.5x the usual bar range, at least two rows - sized by the market itself), the session's
  high / low and the current move's extreme; a new IST day starts fresh. CONFIRMATION (asked for - "identify the best
  solution, how professionals identify exhaustion and absorption": a read is a candidate until the market agrees): each mark
  has `status` - 'pending' when printed, 'confirmed' once a later bar of the day CLOSES past the signal bar's other end,
  'failed' once a later bar TRADES past the level (the zone's far edge / the extreme; checked first - a sweep that closes
  back fails), `statusAt` that bar, the reason added to its text; the pill shows ✓ / ✗ (failed faded). The score never
  changes; the status is the one known at the clock (`tests/flow-reads.test.mjs`). A SHOWN READ NEVER VANISHES (asked for - "it gives signals, absorption / exhaustion, and then it just disappears if price went in the opposite direction"): the reads are worked out again from the bars on every update, so a bar still forming - or an input that arrives or changes later (the book, yesterday's bars) - made a mark disappear after it was on screen. LIVE, `keepShownReads` (flowReads.js; the page keeps its `memory` per index / day / timeframe / row / minimum score) remembers every read produced for a bar (bar time, kind, side) and one that is no longer produced STAYS - FAILED (✗, faded to 65% - readable, it was 40%), a DASHED outline (`kept`), its text ending "NO LONGER READ - it was shown, then the bar's read changed"; a confirmed one keeps its ✓. A replayed day keeps nothing (worked out again at its clock), and a page reload starts the memory empty. `tests/flow-reads.test.mjs`. A part that cannot be read (no book, no
  push) is left out and the rest re-weighted. Each bar from itself and the bars before (the forming bar's read can change until it
  closes, as the first rules' did). A read - no strategy, alert or order.
  POSITIONING and LIQUIDITY ADDED vs PULLED (asked for - "delta + OI positioning on futures ... book pressure line ... net
  liquidity added versus pulled ... build these in separate card components"; two cards under the chart and order book -
  `FlowToolCards.jsx`, the reading `flowTools.js`, `tests/flow-tools.test.mjs`): (1) `PositioningCard` - the futures candles
  (1 / 3 / 5 / 15 min, default 5, `optionanalytics.orderFlow.positioningTf`) coloured by the candle's AGGRESSOR DELTA with
  the change in the FUTURES' OI over it (`positioningCandles` - the OI at the candle's end less the candle before's;
  useDayOi's `futures`, a replayed day's reading known a minute after its minute - `lag`, nothing after the clock): buyers
  aggressive + OI up = NEW LONGS, + OI down = SHORT COVERING, sellers + OI up = NEW SHORTS, + OI down = LONG LIQUIDATION; a
  delta under 5% of the volume = balanced, no OI change / reading = no read; each candle's OI change as bars under it, the
  delta done under each read (day and last 6 candles) and a read (fresh vs closing; "two-sided" when the other side is
  >= 60% as large - `positioningRead`). The OI is the NEAREST contract's: another contract picked = the card says so.
  (2) `LiquidityNetCard` - `liquidityFlow`'s `cumBid` / `cumAsk`: between two book columns, at the rows away from the touch
  in BOTH (the PULL / STACK signals' rule) and inside both books (a level off the far edge is not cancelled), a rise =
  orders ADDED, a drop = PULLED; added − pulled a side as a running line from the day's first column, within 10 / 20 / 30
  (default) / 50 rows (`...liquidityNetBand`), and `liquidityRead` over the last N min (bids stacked / pulled, offers
  stacked / pulled, quiet). The columns are a SAMPLE of the book (2 s live, ~12 s+ on a loaded day), so the lines are a
  floor and a loaded day reads smaller than the same day live - said on the card. Each column is parsed once (WeakMaps - a
  live day is ~11 000 columns); every point from the columns up to it. No depth (estimated / rebuilt day) = the card says
  so. Reads only - they feed no signal, strategy or alert, and `liquidityMap` / `pullStackSignals` are untouched.
  BOOK PRESSURE and the ORDER FLOW IMBALANCE (OFI) were two more cards here and were REMOVED on request ("from order flow
  remove OFI, book pressure"), code and tests: `bookPressure` / `pressureRead` and `OFI_*` / `ofiStep` / `ofiSeries` /
  `ofiCandles` / `ofiAgreement` / `ofiRead` are gone, `liquidityFlow`'s points and `bucketFlow`'s buckets no longer carry a
  `pressure`, and the page imports only the two cards left. (OFI had been kept beside them on request - "do not remove for
  now, I will see a few days and then decide".) The Tape / Time & Sales card's own one-line BOOK READ went with them
  (asked for - "no pull and stack should be there but anything related to book pressure should be removed"): its
  `BookPressure` line and the `pressure` `TapeCard` takes are gone, and `pullStackSignals` returns `{ signals }` alone -
  the PULL / STACK pills on the heatmap, their signals in the list, the bias's pulling / stacking weight and the
  Liquidity added vs pulled card all STAY (`tests/footprint-signals.test.mjs` holds the signals: bids pulled away from
  the touch = support withdrawn, offers added = resistance building, and nothing from a book that never changes).
  RECORDED DAYS ON DISK (`OrderFlowDayStore`, `Storage:OrderFlowPath` - /app/data/order-flow, in docker-compose AND the
  Dockerfile; none = memory only): the days the server recorded live replay EXACTLY - footprint, imbalances, stacked
  imbalances, auctions, tape, book - through a restart / deploy (they lived in memory only, so after every deploy a past day
  came back as the candle estimate, which has no imbalances at all). One gzip JSON per contract and day
  (`{UNDERLYING}/{securityId}/{yyyy-MM-dd}.json.gz`, heatmap rows as [row, qty]; ~4 MB a full day), the newest
  `OrderFlow:DaysOnDisk` dates (252 trading days - about ONE YEAR, asked for - kept, a few GB at most, only memory's newest 3 and a few read-back days in RAM; written on ONE background queue (never on an engine's lock or the tick path), a
  day read back kept for the next asks. TODAY is checkpointed every `CheckpointInterval` (5 min) and at shutdown, and a new
  engine starts from it (`NewEngine` -> `ImportDay`): a deploy mid-session keeps the morning exact - only the minutes the
  server was down are missing, and the first tick after sets a new baseline (no giant print). `OrderFlowDayStoreTests.cs`.
  The live push carries only the engine's last two minute bars, so a page (or the server alert runner) that missed a minute -
  a phone asleep, pushes skipped, the connection down and back - LOADS THE DAY AGAIN (`orderFlowPushGap`; the Order Flow
  page also on every hub reconnect, once a load is not already on its way): it used to fold in what came next and keep a
  hole in the footprint, the cumulative delta and the tape until a manual reload (`tests/scanner-runner.test.mjs`).
  Alerts may lag the pushes; the ticks are applied as they arrive. The live push still carries the last 40
  prints: a client that skips pushes for several seconds (a slow phone - the conflated batcher) can miss prints in its tape
  (bars are whole; the server alert runner is local and does not).
  ON A PHONE (asked for - "order flow is not mobile supportive"): the page is never wider than the screen
  (`.oa-of-page { overflow-x: clip }` in `index.css`) - the footprint legend's longest line did not wrap, the page came out
  wider than a phone, and iOS drew the WHOLE page shrunk with the ☰ off its edge; legend items now wrap inside the card.
  Under 640 px (`useNarrow`) the less-used settings (imbalance, stack, big order, the server's Telegram sizes, the switches) fold
  behind "Settings ▾" and the footprint legend to one line ("▸ Legend"), both remembered (`optionanalytics.orderFlow.
  settingsOpen` / `legendOpen`; a wide screen shows both always); the page's side padding is 8 px; inputs are 16 px
  (iOS zooms in on a smaller one when tapped and stays zoomed). The footprint's narrow mode (its own width < 640) draws
  big-order bubbles smaller (3 - 10 px radius - a 30 px one hid a phone's 28 px cells) and the profile levels' labels on
  a dark backing (they ran over the narrow profile's bars).
- The BACKTRACK page (`/backtest`) was removed on request, page and server endpoints (an old bookmark goes to the
  dashboard). `BacktestService` and its `IBacktestStrategy` strategies STAY: they are what the armed Triggers run
  (`StrategyTriggerHostedService` - `RunStrategy` / `ReplayForStrategy`, in memory) and their list is
  `GET /api/triggers/strategies` (admin, the Triggers page). The Expired Backtest and Signal backtest pages are separate.
- AI ANALYSIS of a run (asked for - "integrate everything into our system, we should be able to analyse every run";
  `LlmAnalysisService`, `LlmController` `/api/llm` - `GET status`, `POST analyse`; the page's `AiAnalyse.jsx`, the texts in
  `llmAnalysis.js`): an "Analyse with AI" button on the Signal backtest report (a page run and an opened background run -
  the same card), on the Feature finder (page run and background run - `FeatureReportBody`) and on Compare all. The page turns
  the report into compact TEXT (`backtestReportText` / `featureReportText` / `compareText` - every figure is one the report
  holds, nothing is worked out for the model, `MAX_TEXT_CHARS` cuts a huge one) and a LOCAL model (Ollama, `Llm:BaseUrl`
  default http://localhost:11434, `Llm:Model` default qwen2.5:14b, `Llm:Enabled`) reads it - nothing leaves the machine. The
  system prompt forbids inventing numbers and asks for what holds / what is noise / ONE rule to backtest / what would drop
  it; the answer is a LEAD, never a signal: it feeds no strategy, alert or order. The model is picked from the INSTALLED ones
  (`GET /api/tags` - never an arbitrary name), one analysis at a time (a 14 - 27B model fills the memory; a crowd gets 429),
  the report is cut at `Llm:MaxChars` (60 000). Admin / User only - External and the Runner key are denied by default
  (`ExternalAccessTests` checks the route). Nothing polls: status is asked when the dialog opens. Production's Docker has no
  Ollama, so there the status says "not running" and the button explains it. `LlmAnalysisServiceTests.cs` (a fake Ollama),
  `tests/llm-analysis.test.mjs`. `llm/analyse.mjs` is the same thing from a terminal for any report file.
  LOCAL ONLY: the AI analysis is behind `AppEnvironment.LocalTools` (`Environment:LocalTools`, which FOLLOWS `Environment:IsLocal` unless set itself - a
  deployment, with neither set and ASPNETCORE_ENVIRONMENT=Production, has it OFF). It is its own switch because IsLocal also makes past days
  come from the stored database ONLY (never Dhan), so a machine with no database sets IsLocal false and LocalTools true.
  `[LocalOnly]` is a RESOURCE filter - it answers 404 before the controller is built - on `LlmController.Analyse`; `GET status` says "not available";
  `GET /api/auth/me` and the login answer carry `isLocal` (= LocalTools) and every "Analyse with AI" button shows only then (`AiAnalyse`).
  Nothing runs at startup, no hosted service, no timer (`LocalToolsTests`: the gate in every combination). The .dockerignore keeps `llm/` out of an image.
- The dataset CSV (a Feature finder run's `{id}.features.csv` - Signal backtest, "Run in background" with "Feature finder": it needs NO rule or
  condition) carries CONTEXT columns right after `date,time` - `CONTEXT` in `featureFinder.js`: the candle's spot open / high / low / close, the near
  futures' close, volume, the ATM strike, the ATM CE / PE premium and the VWAP level (`vwapLevel` - not `vwap`, which is a reading) - then every
  reading, then the labels (what happened after - never an input of anything). The context is for READING the file (a spreadsheet, a chart, the AI,
  a model of your own): a price LEVEL is not comparable day to day. A Feature finder run in which not one day could be read FAILS with the reason
  (it used to finish "done" with an empty file). The volume-profile readings need volume: the near futures' (only for days Dhan still holds - the
  last couple of months) or the index's (from January 2026), so they are blank for older days; the market profile and the option delta profile
  are there for every day.
- The project targets .NET 8 (`net8.0`; it was on 11 for a while). On this Mac .NET 8 is in `~/.dotnet` beside the system .NET 11 (RUNNING.md section 10). .NET 11 changed `(decimal)aDouble` / `(decimal)aFloat` to keep the EXACT binary value (a feed price 101.60f became
  101.59999847412109375, an IV 12.34 became 12.3399999...); .NET 8 rounded to 15 / 7 significant digits. Every double / float
  that reaches a decimal goes through `DecimalConversion.FromDouble` / `FromSingle` - never a plain cast (it gives the same numbers on 8 and on 11)
  (`DecimalConversionTests.cs`).
- AN API ANSWER KEPT AS A LIST goes through `asList` (shared.jsx): anything not an array - an error object `{ error }`, null -
  reads as none. `x ?? []` lets an error object through, and the page then called `.some` / `.map` on it and fell to the
  "Something went wrong" screen (the dashboard, Expired backtest, Contracts, Strike data, Triggers - found by a browser
  check with every API answering 500). Use it for any new list a page fetches.
- Live order placement only ever happens from a confirmed order on a page (OI Replay's Live order panel) or a saved
  Signal strategy's admin-only, confirmed "Live orders (Dhan)" switch (`SignalLiveOrders`); alerts are never orders.
