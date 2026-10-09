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

### Part 4 - the rest of the "never fire" audit (16 strategies not yet audited) and the OI plan items not built
OI plan (in the earlier synthesis): richer `oiCtx` fields into the audit `sig`, a `keepVetoed` measurement of the options-OI veto, the
tuner honesty items (min days, day-clustered error, held-out final check), `openingBias` live-vs-replay mismatch, expiry calendar.

## Security - needs the trader
`NiftyDataCollector/appsettings.json` is tracked in git with a Dhan PIN, a TOTP secret and a database password. Rotate the PIN / TOTP /
password yourself, then remove the file from the repo (move the values to an ignored `appsettings.Local.json`). Never commit credentials.

## Where things are
- Strategy tuning: `src/strategyTuning.js`, `scanner-runner/tune.mjs`, `src/StrategyTuningPage.jsx`, server `StrategyTuning{Controller,Service}.cs`.
- Spot + options strategies: `src/spotEngine.js`; tests `tests/spot-strategies*.test.mjs`; option-trade tuning `tests/option-tuning.test.mjs`.
- OI filters: `TRADE_FILTERS`, `oiGatePasses`, `oiCtx` in `src/strategyEngine.js`; tests `tests/oi-confirmation.test.mjs`, `oi-hygiene.test.mjs`.
