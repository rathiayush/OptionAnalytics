using OptionAnalytics.Server.Models;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// Keltner Channels (Chester Keltner's original concept, refined into its modern EMA+ATR form by
/// Linda Bradford Raschke) - an EMA centerline with bands a multiple of ATR away, the volatility-
/// adjusted counterpart to TurtleDonchianBreakoutStrategy's pure high/low channel: Donchian reacts
/// to the exact recent extreme, Keltner reacts to how much the market has actually been moving
/// lately (ATR), so its bands widen and narrow with volatility rather than jumping to whatever the
/// single most extreme recent bar happened to print.
///
/// Signal: a close beyond either band is read as a breakout - the same "genuine expansion, not
/// exhaustion" reading BollingerBandsStrategy's own Breakout mode uses, just on a volatility-scaled
/// channel instead of a standard-deviation one. Only the FIRST close past a side counts, same "state
/// holds until it clears" rule this app's other band/channel strategies already use, and nothing
/// carries overnight.
///
/// Small default stop-loss + wide default take-profit (SmallStopLossParameter/
/// LongRangeTakeProfitParameter), same trend-following reasoning as this app's other long-range
/// strategies: most breakouts fail and should be cut loose quickly, while a genuine trend day is
/// bounded by the session's own EOD exit rather than a target set too close to let it pay off.
/// </summary>
public sealed class KeltnerChannelBreakoutStrategy : IBacktestStrategy
{
    public string Key => "keltner-channel-breakout";
    public string Name => "Keltner Channel Breakout";
    public string Description => "An EMA centerline with bands a multiple of ATR away (20 EMA, 10-bar ATR, 2x multiplier by default) - a close beyond either band is a breakout. Small stop-loss, wide take-profit by default - cut a failed breakout loose quickly, give a real trend room to run.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.SmallStopLossParameter(),
        OptionTradeSimulator.LongRangeTakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        new BacktestParameterSpec("emaPeriod", "Centerline EMA (bars)", Default: 20, Min: 2, Max: 200, Step: 1),
        new BacktestParameterSpec("atrPeriod", "ATR (bars)", Default: 10, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("multiplier", "ATR multiplier", Default: 2, Min: 0.5m, Max: 10, Step: 0.1m),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Upside breakouts only (buy CE)"),
            new BacktestParameterOption(DirectionShortOnly, "Downside breakouts only (buy PE)"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var emaPeriod = (int)parameters["emaPeriod"];
        var atrPeriod = (int)parameters["atrPeriod"];
        var multiplier = (double)parameters["multiplier"];
        var direction = parameters["direction"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (emaPeriod < 1 || atrPeriod < 1 || bars.Count == 0) return (entries, signals);

        var quotes = bars.Select(c => new Quote
        {
            Date = c.Time.UtcDateTime,
            Open = c.Open,
            High = c.High,
            Low = c.Low,
            Close = c.Close,
            Volume = 0,
        }).ToList();

        var keltner = quotes.GetKeltner(emaPeriod, multiplier, atrPeriod).ToList();

        string? channelState = null;
        DateOnly? currentDay = null;

        for (var i = 0; i < bars.Count; i++)
        {
            var bar = bars[i];

            var day = BacktestUtil.IstDate(bar.Time);
            if (currentDay != day)
            {
                currentDay = day;
                channelState = null;
            }

            if (keltner[i].UpperBand is not { } upper || keltner[i].LowerBand is not { } lower) continue;

            var brokeUp = bar.Close > (decimal)upper;
            var brokeDown = bar.Close < (decimal)lower;
            string? rawBreak = brokeUp ? "Upper" : brokeDown ? "Lower" : null;

            var isFreshBreak = rawBreak is not null && rawBreak != channelState;
            channelState = rawBreak;
            if (!isFreshBreak) continue;

            var current = rawBreak == "Upper" ? "Bullish" : "Bearish";
            var summary = rawBreak == "Upper"
                ? $"Closed ({bar.Close:0.##}) above the Keltner upper band ({upper:0.##})"
                : $"Closed ({bar.Close:0.##}) below the Keltner lower band ({lower:0.##})";

            var isBullish = current == "Bullish";

            if (signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current,
                    $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
            }
            else if (isBullish && !takeLongs)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{summary} - skipped, downside only"));
            }
            else if (!isBullish && !takeShorts)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{summary} - skipped, upside only"));
            }
            else
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", current, summary));
                entries.Add((bar.Time, current));
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }
}
