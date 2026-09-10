using OptionAnalytics.Server.Models;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A 33 EMA envelope breakout, confirmed by both RSI and ADX/DMI - three independent checks all
/// have to agree before this takes a side.
///
///   BULLISH: spot CLOSES above the EMA's upper band (EMA * (1 + BandPercent/100)), AND RSI is at
///            or above RsiBullishMin, AND ADX is at or above AdxMinimum with DI+ above DI-.
///   BEARISH: the mirror - closes below the lower band, RSI at or below RsiBearishMax, ADX at or
///            above AdxMinimum with DI- above DI+.
///
/// The band (not the bare EMA line) is what a close has to clear - a plain EMA touch/cross is too
/// easily grazed by ordinary noise on an index trading in the tens of thousands; a percentage
/// envelope around it is scale-invariant the same way FiveEmaObvCrossoverStrategy's OBV lead and
/// EmaCrossoverStrategy's slope filter are, so the same BandPercent means the same thing on NIFTY
/// and BANKNIFTY alike.
///
/// RSI and ADX/DMI are genuinely different checks, not two views of the same thing: RSI asks
/// whether MOMENTUM already favors this side (has the winning/losing streak been strong enough),
/// ADX/DMI asks whether there is a real TREND worth trading at all (a high ADX) and, if so, which
/// way it currently points (DI+ vs DI-). A band breakout that fails either is exactly the kind of
/// move this strategy is built to sit out - reported as a Rejected signal with whichever check
/// failed, not silently dropped, matching every other filter in this app's strategies.
///
/// Only one signal fires per breakout: once a bar closes outside a band, that side's "already
/// signaled" state holds until price comes back inside the band (or flips straight to the other
/// side), so a run of many bars all closed above the upper band produces one event, not one per
/// bar. Nothing carries overnight, same as every other strategy here.
///
/// The default thresholds (RSI 50, ADX 20) are the commonly taught defaults for "which side is RSI
/// leaning" and "is there a real trend at all" respectively - every one of them, plus the EMA
/// period and band width, is a tunable parameter, not a hidden constant.
/// </summary>
public sealed class EmaBandRsiAdxStrategy : IBacktestStrategy
{
    public string Key => "ema33-band-rsi-adx";
    public string Name => "33 EMA Band + RSI + ADX/DMI";
    public string Description => "Enters Bullish when spot closes above the EMA's upper band, confirmed by RSI above its bullish threshold and ADX/DMI (ADX above its minimum with DI+ above DI-); Bearish is the mirror off the lower band, RSI below its bearish threshold, and DI- above DI+. Every threshold defaults to the commonly taught value and is tunable.";

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
        new BacktestParameterSpec("emaPeriod", "EMA (bars)", Default: 33, Min: 2, Max: 200, Step: 1),
        new BacktestParameterSpec("bandPercent", "Band width from EMA (%)", Default: 0.3m, Min: 0.01m, Max: 5, Step: 0.01m),
        new BacktestParameterSpec("rsiPeriod", "RSI (bars)", Default: 14, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("rsiBullishMin", "RSI must be at least (bullish)", Default: 50, Min: 0, Max: 100, Step: 1),
        new BacktestParameterSpec("rsiBearishMax", "RSI must be at most (bearish)", Default: 50, Min: 0, Max: 100, Step: 1),
        new BacktestParameterSpec("adxPeriod", "ADX/DMI (bars)", Default: 14, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("adxMinimum", "Minimum ADX - trend strength (0 = off)", Default: 20, Min: 0, Max: 100, Step: 1),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Longs only (upper band)"),
            new BacktestParameterOption(DirectionShortOnly, "Shorts only (lower band)"),
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
        var bandPercent = parameters["bandPercent"];
        var rsiPeriod = (int)parameters["rsiPeriod"];
        var rsiBullishMin = parameters["rsiBullishMin"];
        var rsiBearishMax = parameters["rsiBearishMax"];
        var adxPeriod = (int)parameters["adxPeriod"];
        var adxMinimum = parameters["adxMinimum"];
        var direction = parameters["direction"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (bars.Count == 0) return (entries, signals);

        var quotes = bars.Select(c => new Quote
        {
            Date = c.Time.UtcDateTime,
            Open = c.Open,
            High = c.High,
            Low = c.Low,
            Close = c.Close,
            Volume = 0,
        }).ToList();

        var ema = quotes.GetEma(emaPeriod).ToList();
        var rsi = quotes.GetRsi(rsiPeriod).ToList();
        var adx = quotes.GetAdx(adxPeriod).ToList();

        string? bandState = null;
        DateOnly? currentDay = null;

        for (var i = 0; i < bars.Count; i++)
        {
            var bar = bars[i];

            // Nothing carries overnight - a band worked out on yesterday's EMA level says nothing
            // about where today's price should sit relative to a freshly-continuing average.
            var day = BacktestUtil.IstDate(bar.Time);
            if (currentDay != day)
            {
                currentDay = day;
                bandState = null;
            }

            if (ema[i].Ema is not { } emaValue) continue;

            var upperBand = (decimal)emaValue * (1 + bandPercent / 100);
            var lowerBand = (decimal)emaValue * (1 - bandPercent / 100);

            string? rawBias = bar.Close > upperBand ? "Bullish" : bar.Close < lowerBand ? "Bearish" : null;

            // Only a FRESH breakout - a transition into this side from either "inside the band" or
            // the opposite side - is a new event. A run of bars all still outside the same band is
            // the same event continuing, not a new one.
            var isFreshBreakout = rawBias is not null && rawBias != bandState;
            bandState = rawBias;
            if (!isFreshBreakout) continue;

            var bias = rawBias!;
            var bandLabel = bias == "Bullish" ? "upper" : "lower";
            var bandValue = bias == "Bullish" ? upperBand : lowerBand;
            var summary = $"Spot closed {(bias == "Bullish" ? "above" : "below")} the {emaPeriod} EMA's {bandLabel} band ({bar.Close:0.##} vs {bandValue:0.##})";

            var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes;
            decimal? rsiValue = (decimal?)rsi[i].Rsi;
            decimal? adxValue = (decimal?)adx[i].Adx;
            decimal? pdi = (decimal?)adx[i].Pdi;
            decimal? mdi = (decimal?)adx[i].Mdi;

            if (beforeSignalStart)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bias, $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
            }
            else if (bias == "Bullish" && !takeLongs)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bias, $"{summary} - skipped, shorts only"));
            }
            else if (bias == "Bearish" && !takeShorts)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bias, $"{summary} - skipped, longs only"));
            }
            else if (rsiValue is null || adxValue is null || pdi is null || mdi is null)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bias, $"{summary} - skipped, not enough bars for RSI/ADX yet"));
            }
            else if (bias == "Bullish" && rsiValue < rsiBullishMin)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bias, $"{summary} - skipped, RSI {rsiValue:0.##} is below the required {rsiBullishMin}"));
            }
            else if (bias == "Bearish" && rsiValue > rsiBearishMax)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bias, $"{summary} - skipped, RSI {rsiValue:0.##} is above the required {rsiBearishMax}"));
            }
            else if (adxMinimum > 0 && adxValue < adxMinimum)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bias, $"{summary} - skipped, ADX {adxValue:0.##} is below the minimum {adxMinimum}"));
            }
            else if (bias == "Bullish" && pdi <= mdi)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bias, $"{summary} - skipped, DI+ {pdi:0.##} is not above DI- {mdi:0.##}"));
            }
            else if (bias == "Bearish" && mdi <= pdi)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bias, $"{summary} - skipped, DI- {mdi:0.##} is not above DI+ {pdi:0.##}"));
            }
            else
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", bias, $"{summary} - confirmed by RSI {rsiValue:0.##} and ADX {adxValue:0.##} ({(bias == "Bullish" ? $"DI+ {pdi:0.##} > DI- {mdi:0.##}" : $"DI- {mdi:0.##} > DI+ {pdi:0.##}")})"));
                entries.Add((bar.Time, bias));
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }
}
