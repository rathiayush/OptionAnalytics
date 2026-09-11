using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// Opening Range Breakout (ORB) - one of the most famous intraday strategies anywhere, tracing back
/// to Toby Crabel's research on US equities/futures and, independently, one of the single
/// most-traded setups in Indian index-options day trading specifically (this app's own home turf):
/// the first few minutes after the open set a range, and a break of that range is read as the day's
/// real direction asserting itself once the pre-open positioning has settled.
///
/// Mechanics: the OPENING RANGE is the high/low of every bar from the session's own open
/// (SignalStartTimeParameter's 09:15 IST default) through OpeningRangeMinutes later (15 by default -
/// the classic 09:15-09:30 window). While that window is still forming, this strategy takes no
/// signals at all - there is no range yet to break. The instant a LATER bar's close clears the
/// range's high, that is a Bullish breakout; clears the low, Bearish. Only the FIRST breakout each
/// side each day fires - once broken, that side will not signal again until the range resets at the
/// next day's open, so a strong trend day produces one entry, not one per bar still outside the
/// range.
///
/// This is the one strategy in this app for which SignalStartTimeParameter doing double duty (both
/// "no signals before this" AND "the opening range starts here") is exactly right, not a
/// coincidence: the range and the earliest possible signal are the same session boundary by
/// definition, so there is no separate "range start" parameter to keep in sync with it.
/// </summary>
public sealed class OpeningRangeBreakoutStrategy : IBacktestStrategy
{
    public string Key => "opening-range-breakout";
    public string Name => "Opening Range Breakout (ORB)";
    public string Description => "The first OpeningRangeMinutes after the open (09:15-09:30 IST by default) sets the day's range. The first close afterward that clears the range high is a Bullish breakout; clears the low, Bearish - one signal per side per day, not one per bar still outside the range.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        new BacktestParameterSpec("openingRangeMinutes", "Opening range length (minutes)", Default: 15, Min: 1, Max: 120, Step: 1),
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
        var openingRangeMinutes = (int)parameters["openingRangeMinutes"];
        // The session's own open, in minutes past midnight IST - SignalStartTimeParameter's own
        // doc comment explains why 09:15 (555) is the right default rather than 0: the pre-open
        // call-auction bars before it are not real continuous trading and must never seed a range.
        var sessionStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);
        var direction = parameters["direction"];

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (openingRangeMinutes < 1 || bars.Count == 0) return (entries, signals);

        var rangeEndMinutes = sessionStartMinutes + openingRangeMinutes;

        DateOnly? currentDay = null;
        decimal? rangeHigh = null, rangeLow = null;
        var brokeUp = false;
        var brokeDown = false;

        for (var i = 0; i < bars.Count; i++)
        {
            var bar = bars[i];
            var day = BacktestUtil.IstDate(bar.Time);
            var minuteOfDay = IstClock.MinutesOfDay(bar.Time);

            // A new day resets everything - the range, and which side (if either) has already
            // broken out, since ORB is inherently a once-a-day setup keyed to that day's own open.
            if (currentDay != day)
            {
                currentDay = day;
                rangeHigh = null;
                rangeLow = null;
                brokeUp = false;
                brokeDown = false;
            }

            if (minuteOfDay < sessionStartMinutes) continue; // pre-open - never part of the range

            if (minuteOfDay < rangeEndMinutes)
            {
                // Still building the range - widen it, but this bar itself can never be a signal:
                // there is no complete range yet to have broken out of.
                rangeHigh = rangeHigh is { } h ? Math.Max(h, bar.High) : bar.High;
                rangeLow = rangeLow is { } l ? Math.Min(l, bar.Low) : bar.Low;
                continue;
            }

            if (rangeHigh is not { } high || rangeLow is not { } low) continue; // no bars ever fell inside the range window (a gappy/missing session)

            var brokeUpNow = !brokeUp && bar.Close > high;
            var brokeDownNow = !brokeDown && bar.Close < low;
            if (!brokeUpNow && !brokeDownNow) continue;

            var current = brokeUpNow ? "Bullish" : "Bearish";
            if (brokeUpNow) brokeUp = true; else brokeDown = true;

            var summary = brokeUpNow
                ? $"Closed ({bar.Close:0.##}) above the opening range high ({high:0.##})"
                : $"Closed ({bar.Close:0.##}) below the opening range low ({low:0.##})";

            if (current == "Bullish" && !takeLongs)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{summary} - skipped, downside only"));
            }
            else if (current == "Bearish" && !takeShorts)
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
