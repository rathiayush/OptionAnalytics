using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// Spot closing across its Volume Weighted Moving Average: a candle that CLOSES above the VWMA is a
/// long entry at that close, a candle that closes below it a short entry - the plain "close crosses
/// the line" rule, taken on the cross rather than on every bar that happens to sit the right side of
/// it (a position is opened once when the side changes, not re-opened every bar until it changes
/// back).
///
/// WHERE THE VOLUME COMES FROM, because this is the part that is not obvious and does change what
/// the line means: an index has no volume of its own. Dhan's IDX_I feed carries none and SpotBars is
/// a plain Candle with no volume field at all, so there is nothing native to weight spot by - a
/// textbook VWMA on an index would use its FUTURES volume, which this app does not track. What it
/// does have is the ATM option contracts' own traded volume (AtmCeVolumeBars/AtmPeVolumeBars), and
/// that is what weights each spot close here: CE + PE volume in the same bucket, so the average
/// leans toward the prices where the option chain actually traded rather than treating a dead
/// mid-afternoon bar and a heavy open bar alike.
///
/// The price series is spot and nothing but spot - only the WEIGHTS come from the option side.
///
/// Where a window has no volume at all (before the ATM contracts started being tracked, or a bar
/// that simply did not trade) the window degrades to an unweighted average of the same closes rather
/// than going undefined: a moving average that vanished for the first part of every session would
/// suppress exactly the signals a morning-heavy strategy most wants, and an unweighted mean is the
/// honest limit of a weighted one as the weights flatten.
/// </summary>
public sealed class VwmaCloseCrossStrategy : IBacktestStrategy
{
    public string Key => "vwma-close-cross";
    public string Name => "VWMA Close Cross (spot)";
    public string Description => "Spot closing across its Volume Weighted Moving Average - the same average TradingView's ta.vwma(source, length) computes, sum(source x volume) / sum(volume) over the window. A candle closing ABOVE the VWMA enters long at that close, a candle closing BELOW it enters short, taken on the cross rather than on every bar sitting the right side of the line. An index has no volume of its own, so the line weights each spot bar by the ATM CE+PE option volume in the same bucket - the prices are purely spot, only the weights come from the option chain; a window with no volume falls back to an unweighted average (where TradingView would show nothing at all).";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    /// <summary>The "Source" input TradingView's own VWMA indicator exposes, same set and same
    /// meaning, so a line tuned there reproduces here. Only the LINE is built from this - the cross
    /// is always judged on the candle's CLOSE, since "the candle closed above it" is the rule and
    /// an hl2-vs-hl2 comparison would signal on a bar whose close never got there.</summary>
    private const decimal SourceClose = 0;
    private const decimal SourceOpen = 1;
    private const decimal SourceHigh = 2;
    private const decimal SourceLow = 3;
    private const decimal SourceHl2 = 4;
    private const decimal SourceHlc3 = 5;
    private const decimal SourceOhlc4 = 6;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        new BacktestParameterSpec("vwmaPeriod", "VWMA (bars)", Default: 20, Min: 2, Max: 200, Step: 1),
        new BacktestParameterSpec("vwmaSource", "Source", Default: SourceClose, Min: SourceClose, Max: SourceOhlc4, Step: 1, Options: new[]
        {
            new BacktestParameterOption(SourceClose, "Close"),
            new BacktestParameterOption(SourceOpen, "Open"),
            new BacktestParameterOption(SourceHigh, "High"),
            new BacktestParameterOption(SourceLow, "Low"),
            new BacktestParameterOption(SourceHl2, "hl2 (median)"),
            new BacktestParameterOption(SourceHlc3, "hlc3 (typical)"),
            new BacktestParameterOption(SourceOhlc4, "ohlc4 (average)"),
        }),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Longs only"),
            new BacktestParameterOption(DirectionShortOnly, "Shorts only"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters, null);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var period = (int)parameters["vwmaPeriod"];
        var source = parameters.GetValueOrDefault("vwmaSource", SourceClose);
        var direction = parameters["direction"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        var vwma = VwmaSeries(bars, VolumeByTime(context), period, source);

        DateOnly? currentDay = null;
        bool? wasAbove = null;

        for (var i = 0; i < bars.Count; i++)
        {
            var bar = bars[i];

            // A session opens with a gap often enough that comparing today's first close against
            // yesterday's last side would manufacture a cross nobody traded. The side is re-learned
            // from the first bar of each day and only compared within that day, the same
            // nothing-carries-overnight rule FiveEmaStrategy applies to its alert candle.
            var day = BacktestUtil.IstDate(bar.Time);
            if (currentDay != day)
            {
                currentDay = day;
                wasAbove = null;
            }

            if (vwma[i] is not { } line) continue;

            var isAbove = bar.Close > line;

            // First readable bar of the day establishes the side without signalling: there is no
            // previous close on this side of the gap to have crossed FROM.
            if (wasAbove is not { } previouslyAbove)
            {
                wasAbove = isAbove;
                continue;
            }

            if (isAbove == previouslyAbove) continue;
            wasAbove = isAbove;

            var bullish = isAbove;
            var summary = $"Spot closed {bar.Close:0.##} {(bullish ? "above" : "below")} the {period}-bar VWMA at {line:0.##}";

            // Same pre-open guard every other strategy here applies - see SignalStartTimeParameter.
            if (signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bullish ? "Bullish" : "Bearish",
                    $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
                continue;
            }

            if (bullish ? !takeLongs : !takeShorts)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bullish ? "Bullish" : "Bearish",
                    $"{summary} - skipped, {(bullish ? "shorts" : "longs")} only"));
                continue;
            }

            signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", bullish ? "Bullish" : "Bearish", summary));
            entries.Add((bar.Time, bullish ? "Bullish" : "Bearish"));
        }

        return (entries, signals);
    }

    /// <summary>Total ATM CE+PE traded volume per bar timestamp - the weights this VWMA uses, since
    /// spot has none of its own. Summed rather than taken from one side because the weight is meant
    /// to say "how much did the chain trade around this price", which is both legs.</summary>
    internal static Dictionary<DateTimeOffset, long> VolumeByTime(BacktestStrategyContext context)
    {
        var byTime = new Dictionary<DateTimeOffset, long>();

        foreach (var bar in context.AtmCeVolumeBars)
            byTime[bar.Time] = byTime.GetValueOrDefault(bar.Time) + bar.Volume;

        foreach (var bar in context.AtmPeVolumeBars)
            byTime[bar.Time] = byTime.GetValueOrDefault(bar.Time) + bar.Volume;

        return byTime;
    }

    /// <summary>Rolling volume-weighted mean of <paramref name="bars"/>' closes: sum(close x volume)
    /// / sum(volume) over the trailing <paramref name="period"/> bars. Null until there are that many
    /// bars to average. A window whose volumes are all zero (or simply absent from
    /// <paramref name="volumeByTime"/>) falls back to the unweighted mean of the same closes - see
    /// this class's own doc comment for why that beats going undefined.
    ///
    /// Internal for direct unit testing: this is the whole strategy's arithmetic, and the live
    /// CDV/Dhan state the rest of it reads has no test harness.</summary>
    internal static decimal?[] VwmaSeries(
        IReadOnlyList<Candle> bars, IReadOnlyDictionary<DateTimeOffset, long> volumeByTime, int period, decimal source = SourceClose)
    {
        var result = new decimal?[bars.Count];
        if (period <= 0) return result;

        for (var i = 0; i < bars.Count; i++)
        {
            if (i + 1 < period) continue;

            decimal weighted = 0;
            decimal volume = 0;
            decimal plain = 0;

            for (var k = i - period + 1; k <= i; k++)
            {
                var price = SourcePrice(bars[k], source);
                var barVolume = volumeByTime.TryGetValue(bars[k].Time, out var v) && v > 0 ? v : 0;

                weighted += price * barVolume;
                volume += barVolume;
                plain += price;
            }

            result[i] = volume > 0 ? weighted / volume : plain / period;
        }

        return result;
    }

    /// <summary>TradingView's own source options, computed the same way: hl2 = (H+L)/2,
    /// hlc3 = (H+L+C)/3, ohlc4 = (O+H+L+C)/4.</summary>
    internal static decimal SourcePrice(Candle bar, decimal source) => source switch
    {
        SourceOpen => bar.Open,
        SourceHigh => bar.High,
        SourceLow => bar.Low,
        SourceHl2 => (bar.High + bar.Low) / 2m,
        SourceHlc3 => (bar.High + bar.Low + bar.Close) / 3m,
        SourceOhlc4 => (bar.Open + bar.High + bar.Low + bar.Close) / 4m,
        _ => bar.Close,
    };
}
