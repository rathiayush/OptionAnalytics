using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// The extension point for the Backtrack page's trade simulation: implement this once per
/// strategy and register it with <c>builder.Services.AddSingleton&lt;IBacktestStrategy,
/// YourStrategy&gt;()</c> in Program.cs - BacktestService picks it up automatically (it takes
/// <c>IEnumerable&lt;IBacktestStrategy&gt;</c>), GET /api/backtest/strategies lists it, and the
/// Backtrack page renders its Parameters as generic controls and lets a user pick and run it.
/// Nothing else needs to change - no controller edits, no frontend edits - to add a new strategy.
///
/// A strategy only has to answer "given the Confluence signals and candle history that already
/// exist, what trades would this approach have taken?" - it does not touch Dhan, does not know
/// about timeframe aggregation, and does not implement its own signal detection; all of that is
/// handled once by BacktestService and handed in via BacktestStrategyContext.
/// </summary>
public interface IBacktestStrategy
{
    /// <summary>Stable identifier used in the trades API's ?strategy= query param and as this
    /// strategy's React key - must never change once a strategy ships, or old bookmarked/shared
    /// URLs referencing it break.</summary>
    string Key { get; }

    /// <summary>Short display name for the Backtrack page's strategy dropdown.</summary>
    string Name { get; }

    /// <summary>One or two sentences shown under the dropdown explaining what the strategy does.</summary>
    string Description { get; }

    /// <summary>Every numeric input this strategy needs, in the order they should be shown. The
    /// Backtrack page renders one InputNumber per entry using Label/Default/Min/Max/Step - a
    /// strategy with no parameters can return an empty list.</summary>
    IReadOnlyList<BacktestParameterSpec> Parameters { get; }

    /// <summary>Runs this strategy over <paramref name="context"/> and returns the trades it would
    /// have taken, most recent first. <paramref name="parameters"/> is keyed by each spec's Key
    /// (BacktestService has already filled in any parameter the caller omitted with that spec's
    /// own Default, so this is always complete - safe to index without a fallback).</summary>
    IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters);

    /// <summary>The signals THIS strategy reasons about, newest first - what the Backtrack page's
    /// signal table shows while this strategy is selected, so the table always explains the trades
    /// listed under it rather than describing some other strategy's logic. Same parameters as
    /// Simulate, since a strategy's signals usually depend on them.</summary>
    IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters);

    /// <summary>Parameter Default overrides for a specific page timeframe (1/3/5 minutes) - GET
    /// .../strategies applies these on top of Parameters' own static Default when the caller names a
    /// timeframe (see BacktestUtil.ApplyTimeframeDefaults), so the Backtrack/Expired Backtest pages
    /// pre-fill a NEW parameter form with values suited to whichever timeframe is currently
    /// selected, rather than one fixed number that only really fits one of them. Only the keys
    /// present here are overridden; anything not returned keeps that spec's own Default, and a key
    /// with no matching Parameters entry is silently ignored (safe to inherit unchanged even for a
    /// strategy with a different parameter set).
    ///
    /// The default implementation scales the standard slPoints/tpPoints stop and target
    /// (OptionTradeSimulator.StopLossParameter/TakeProfitParameter's own 10/20) by
    /// OptionTradeSimulator.TimeframeScale - larger bars mean larger typical price swings, so a
    /// fixed points value tuned for 1-minute bars is often too tight to be meaningful at 5-minute
    /// ones. A strategy with its own extra timeframe-sensitive parameters overrides this to add them
    /// on top (see SrFlowSellStrategy); a strategy whose SL/TP genuinely should not scale overrides
    /// it to return an empty dictionary instead.
    ///
    /// Deliberately NOT extended to bar-count parameters (EMA/lookback periods, retest counts, pivot
    /// left/right bars, RSI/ADX/MACD/SuperTrend periods and thresholds) in this first pass - unlike
    /// points, which straightforwardly want to be bigger at a coarser timeframe, the "right" bar
    /// count at each timeframe is a real trading-judgment call this class should not guess at
    /// without the specific numbers to use.</summary>
    IReadOnlyDictionary<string, decimal> DefaultsForTimeframe(int timeframeMinutes)
    {
        var scale = OptionTradeSimulator.TimeframeScale(timeframeMinutes);
        return new Dictionary<string, decimal>
        {
            ["slPoints"] = 10m * scale,
            ["tpPoints"] = 20m * scale,
        };
    }
}
