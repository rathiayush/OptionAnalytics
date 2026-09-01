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
}
