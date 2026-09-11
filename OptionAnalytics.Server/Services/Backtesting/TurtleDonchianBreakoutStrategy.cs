using OptionAnalytics.Server.Models;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// The "Turtle" system (Richard Dennis and William Eckhardt's famous 1980s trend-following
/// experiment) in its core form: a Donchian Channel breakout - the highest high / lowest low of the
/// PRECEDING N bars (never including the breakout bar itself - Skender's own GetDonchian window
/// excludes the current bar, which is what makes a breakout possible to begin with). A close beyond
/// either side is read as a genuine new trend starting, worth risking a small, fixed amount to find
/// out - the Turtles' own money management was more elaborate (ATR-based position sizing and
/// pyramiding), but the entry rule and the "small loss, let a real trend pay for many small losses"
/// philosophy are exactly this.
///
/// Small default stop-loss + a much wider default take-profit (SmallStopLossParameter/
/// LongRangeTakeProfitParameter, shared with this app's other trend-following strategies) reflect
/// that philosophy directly: most breakouts fail and should be cut loose quickly, while the target
/// is set wide enough that a genuinely extended trend day is capped by the session's own EOD exit
/// (or SquareOffTimeParameter) rather than by a target too close to let the move actually pay off.
///
/// Only the FIRST close past a side counts - once through, that side will not re-signal until price
/// comes back inside the channel (or the opposite side breaks), same "state holds until it clears"
/// rule this app's other band/channel strategies already use, and nothing carries overnight.
/// </summary>
public sealed class TurtleDonchianBreakoutStrategy : IBacktestStrategy
{
    public string Key => "turtle-donchian-breakout";
    public string Name => "Turtle / Donchian Channel Breakout";
    public string Description => "The classic Turtle Trading entry: a close beyond the highest high or lowest low of the preceding N bars (20 by default) is read as a fresh trend starting. Small stop-loss, wide take-profit by default - cut a failed breakout loose quickly, give a real trend room to run.";

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
        new BacktestParameterSpec("channelPeriod", "Donchian channel (bars)", Default: 20, Min: 2, Max: 200, Step: 1),
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
        var channelPeriod = (int)parameters["channelPeriod"];
        var direction = parameters["direction"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (channelPeriod < 1 || bars.Count == 0) return (entries, signals);

        var quotes = bars.Select(c => new Quote
        {
            Date = c.Time.UtcDateTime,
            Open = c.Open,
            High = c.High,
            Low = c.Low,
            Close = c.Close,
            Volume = 0,
        }).ToList();

        var donchian = quotes.GetDonchian(channelPeriod).ToList();

        string? channelState = null;
        DateOnly? currentDay = null;

        for (var i = 0; i < bars.Count; i++)
        {
            var bar = bars[i];

            // Nothing carries overnight - yesterday's channel says nothing about today's freshly
            // forming one, same rule every other band/channel strategy in this app already uses.
            var day = BacktestUtil.IstDate(bar.Time);
            if (currentDay != day)
            {
                currentDay = day;
                channelState = null;
            }

            if (donchian[i].UpperBand is not { } upper || donchian[i].LowerBand is not { } lower) continue;

            var brokeUp = bar.Close > (decimal)upper;
            var brokeDown = bar.Close < (decimal)lower;
            string? rawBreak = brokeUp ? "Upper" : brokeDown ? "Lower" : null;

            var isFreshBreak = rawBreak is not null && rawBreak != channelState;
            channelState = rawBreak;
            if (!isFreshBreak) continue;

            var current = rawBreak == "Upper" ? "Bullish" : "Bearish";
            var summary = rawBreak == "Upper"
                ? $"Closed ({bar.Close:0.##}) above the {channelPeriod}-bar Donchian high ({upper:0.##})"
                : $"Closed ({bar.Close:0.##}) below the {channelPeriod}-bar Donchian low ({lower:0.##})";

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
