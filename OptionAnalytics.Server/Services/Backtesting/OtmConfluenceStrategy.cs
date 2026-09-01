using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// The original Backtrack trade simulation: enter on every Confluence signal - the three legs'
/// EMA9/21 BIASES all pointing the same way (spot up + ATM CE up + ATM PE down, or the bearish
/// mirror), which is what the live ConfluenceAlertService alerts on. Note this fires whenever the
/// alignment first forms, which can be because only ONE leg just flipped while the other two had
/// been sitting that way for hours - see EmaSurgeStrategy for the stricter "all of them actually
/// cross at once" version.
///
/// Everything after the entry decision - which leg, which strike, entry fill, stop/target, day-close
/// exit, one-position-at-a-time - is OptionTradeSimulator's, shared with every other strategy.
/// </summary>
public sealed class OtmConfluenceStrategy : IBacktestStrategy
{
    public string Key => "otm-confluence";
    public string Name => "OTM/ITM Confluence";
    public string Description => "On every spot+ATM-CE+ATM-PE Confluence signal (all three EMA biases aligned), either buy the matching CE/PE or sell the opposite leg, N strikes from ATM (positive = OTM, negative = ITM); exit on a points-based stop-loss/take-profit or day close.";

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var entries = context.ConfluenceSignalsAscending
            .Select(s => (s.TimeUtc, s.Direction))
            .ToList();

        return OptionTradeSimulator.Run(context, entries, parameters);
    }

    /// <summary>This strategy reasons about the whole replay - the individual leg flips as much as
    /// the Confluences they build up to - so it reports all of them.</summary>
    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        context.AllSignals;
}
