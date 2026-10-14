# OptionAnalytics - notes for every session

## The strategy scanner is the most important part of the app

The strategy scanner (`optionanalytics.client/src/strategyEngine.js`, `spotEngine.js`, `scannerCore.js`, fed by
`liveFeeds.js`, `orderFlowMath.js`, `profiles.js`, `suddenOi.js` and `dayRegime.js`) decides when a trade
is signalled, at what entry, stop-loss and target, how a trailing stop moves, when a trade exits and
what the paper / live option trade does. A mistake there costs real money. It runs on the SERVER (`scanner-runner/`,
below); the Order Flow page no longer runs strategies. The **Strategies page** (`StrategiesPage.jsx`) is where they are
seen and set: every strategy (a new one appears by itself) and what the server does with it per index (LIVE / live list /
paper / signals only, tuned), each index's Live today, today's signals and trades, the applied settings, the live list and
the scanner settings (alert list, trailing stop, per-strategy filters, Telegram - saved to the server's config). A
strategy is traded where it is in the alert list, on the index's live list, or has a fine-tuned setting applied there.
The **Strategy lab** (`StrategyLabPage.jsx`, tuning job `what: 'lab'`, `evaluateSetting` in `strategyTuning.js`) measures
an edited setting over past days with the tuning's own functions - one strategy on one index (the whole setting), or several
of each (the changes - `labOverrides` - on top of each one's start, `labBase` written / applied; one job per index, the
first run now and the rest queued, every strategy measured on one day scan); it writes no tuning history. Each index keeps its
last lab result; a lab run that fails, crashes or is stopped REPLACES it with why (`WriteLabFailure`) - an older run's numbers
never pass for a new run's. The page counts only results of the setting and days set now: an index it started that has not
written its new result yet ("running / queued - showing its previous run") or an older setting / other days is greyed and
left out of the totals; results are read again on every job start / end.

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
there changes both - `tests/scanner-core.test.mjs` and `tests/scanner-runner.test.mjs` cover them. The runner ALSO runs
the spot + options strategies (`spotEngine.js`, server only): once each finished minute on the server's own spot candles
(`/api/spot/{index}/candles?from=`), traded where applied or on the live list, their live orders watched on the SPOT price
(`priceBasis: 'spot'`) - `tests/scanner-runner-spot.test.mjs` keeps live == the tuning's day scan. Spot #111 - #113 read the
day's OWN spot profile, built inside the engine from the same spot bars (`spotProfile`: time at price - spot has no volume -
over the minutes finished `PROFILE_LAG` (15)+ minutes before the clock; its nodes, POC and the thin areas between two nodes),
never the server's previous-day profile or the futures' - so every caller gets the same one with nothing to pass. Spot #114
(OI confluence) has the Strategy lab's OI filters as its own rules - the whole chain's net CE - PE since the open with the
trade, CE / PE with it (15 min) and not against it (since the open), the wall in the way not growing and at least the target
away, the day not trending against it - and buys the dip / sells the pop (`tests/spot-strategies-5.test.mjs`). On the page they live on
the OI Replay page (`SpotStrategyScanner.jsx`, its data), judged by the same `spotScanTick` / `spotScanMinutes`
(`scannerCore.js`) and traded in options like the Order Flow scanner: paper on each alert, Live (Dhan) + confirmed
"Auto-place on alert" for real super orders, exits on the signal's spot SL / target / trail / time stop. The runner is
paper unless an admin switches an index to Live for TODAY (Trade settings / Order Flow page - `ServerLiveService`):
then it asks `/api/scanner-runner/live/{index}/order`, where the server checks every limit (Live today, 09:15 - 14:45,
one open trade per index, the index's max trades / max loss, the strategy on the index's live list - `LiveListService`:
proven after costs on the tuning and live records, or added by hand -, the account kill switch) and places it with the index's
Trade settings. Its "Runner" role still cannot reach the manual live-trading API; `ServerLiveServiceTests.cs` guards
the limits. Every live order is a Dhan super order WITH its SL and target legs (refused at 0), the server moves its
trailing SL and closes it at its time stop, and the server ALSO watches each live trade's INDEX stop-loss on the futures
price (`ServerLiveStopWatcher`, trailed only tighter) - the stop holds even when the scanner is down. Every 2 s it also
reads what Dhan did by itself (`ReconcileAsync`, from the order book in memory - `LiveTradingService.StateOf`): a trade whose
SL / target leg filled is closed at once with its P&L from the fills (kept over the scanner's later report), an entry
rejected / cancelled before it traded is no trade (not counted, P&L 0), and a server scanner entry with nothing traded
`EntryFillSeconds` (60) after it was placed is cancelled through the trade's own exit; an order the book does not list,
or a filled one whose legs are not listed, is never guessed closed. A change of an open live trade's option SL / target
(a new Max SL / Max target reaching it from that minute - `withCapChange`) moves its Dhan legs at once: the runner compares
`liveLegsNow(p)` with the legs Dhan has (`p.liveLegs`) each tick and posts `/api/scanner-runner/live/{index}/levels`
(`ServerLiveService.MoveLegsAsync`, held to the max, `UpdateTradeLevelsAsync`), a failure retried each minute. In a fast
market (a sudden fall moves an option - SENSEX's above all - faster than a limit order) the SERVER re-prices: a server
scanner entry (`ChaseEntry`) the market ran away from goes to the LATEST ask / bid plus the slippage every 2 s, widened up
to 4x, its legs moved along, never further than its SL distance from its first price (`ChaseEntryAsync` /
`RepriceEntry`); every exit follows the latest bid / ask until it fills (`ChaseExitAsync`, up to 6x slippage, ~5 min), and
one Dhan rejects is placed again at the latest price for what is still open (`ReplaceRejectedExitAsync`, 3 times).
The pages hear the server scanner's changes the moment they happen, not at their next poll (`ScannerEvents` on SpotHub groups
"scanner" / admin-only "scanner-live", `scannerEvents.js`): the runner reports at once on a signal or a trade punched / exited
(`changeSig`, else every 5 s with the P&L) and saves the record at once on a trade change; the Server scanner card, Trades →
Scanner record (an open trade's premium and P&L now), the applied runs and the Live today views refresh from the push - their
polls stay as the fallback.

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
- the tuning CHOOSES a setting month by month (`periodsOf` / `robustScore` / `pickSimplest` in `strategyTuning.js`): each
  setting is scored on every month of the train days (2-week stretches under two months; one stretch under 15 days - the
  old score), as the mean of its shrunk monthly averages less their spread; one that made money in under half of 3+ months,
  or trades under `minPerMonth` (the job's "Min a month", 4 by default, 0 = off) a month, is not chosen; of the settings
  within `NEAR_BEST` (15%) of the top score the one changing the fewest parameters from as written wins. Strategy
  performance ranks fine-tuned strategies by their proof on days they were NOT tuned on (`proofOf` / `byProof` in
  `settingCompare.js`) - their tuned-day numbers are labelled as such. `tests/robust-tuning.test.mjs` guards it and the
  walk-forward (`walkForward` / `withWalkForward`, the job's "Walk-forward" blocks, 0 = off): the way of choosing is run again
  before each of N later blocks of days (training = every day before the block) and traded on the block it never saw; a
  setting that does not make money on them, beat as written and win half the blocks is not recommended
  (`tests/strategy-tuning.test.mjs`);
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
  An option out with its signal is priced at the close of the minute the signal ended in (`closePremiumAt` - live data is
  stamped at the minute's START and still moving, so a plain read at the exit time was the NEXT minute's running price),
  the same live as replayed; once the server scanner has announced an exit it keeps it on the position (`exitFinal`) -
  the record is what Telegram said, never re-priced by a later read or a reload. The option side a signal was traded on
  IS that trade in the record's If bought / If sold (`scannerLogBody`). `tests/exit-price.test.mjs` guards it.
- **A strategy follows its own exits.** A setup trailing its strategy's own stop (`tradeTrail`, or the scanner's trail pinned
  as `_trail` when a tuned setting was applied - `withOwnTrail`) is not moved by a later change of the scanner's trailing
  stop. Every strategy's option leaves the trade by ITS OWN exit (`tradeOptExit`, carried from the tuning by
  `filtersFromTuning`; none set = read from its % - neither: out with the index trade) with its own SL / target %
  (`optionPlanFor` / `newPosition` / `positionRows`) - NEVER the Trade settings' SL / target / trail (those are a manual
  trade's). The only index rule on it is the MAX (Trade settings Max SL / Max target, `capPoints`): never a wider SL or a
  farther target, the max alone where it has none; a change of the max reaches open strategy trades from that minute
  (`withCapChange`). Its live super order carries those legs (a safety leg at the signal's own index distance where there
  is none - `liveLegsFor`; the server clamps to the max too) and no option trail. The tuning measures every option with the
  same max rules (each day's `optionCaps`, `optionLevelsOf`); `tests/strategy-own-exits.test.mjs` keeps the paper trade ==
  the tuning's `optionOutcome` for every exit. The scanner record's If bought / If sold (`signalLegs`, with the index's
  `runnerSettingsOf`) take each option the SAME way - the leg of the side traded IS the trade (same exit, time, reason).

## Other rules

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
  (`DhanDataCacheTests.cs`).

- Never commit local-only auth bypasses, credentials or `appsettings.Local.json`; never change Dhan
  credentials. Don't run the real server against Dhan just to test - use the tests, `vite preview` with
  a mocked `/api`, or a local feeder.
- Live order placement only ever happens behind an explicit, confirmed switch: the page's "Auto-place on alert" in
  Live (Dhan) mode, or an index switched to "Live today" for the server scanner (back to paper every morning). Alerts
  and the default auto trade are paper.
