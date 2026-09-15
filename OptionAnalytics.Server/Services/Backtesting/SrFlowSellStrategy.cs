using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A directional option-SELLING strategy built around support/resistance on a higher timeframe,
/// price action against that level on the page's own (lower) timeframe, and order flow (OBV/CDV)
/// used to tell a genuine breakout apart from a fakeout - the setup the user described directly:
/// "support and resistance on 30min ... on 1min or 3min candle rejection of that support or
/// breakout retest ... if cdv and obv rising in bull direction growing from last few candles then
/// it is breakout, if not it is going to be a fakeout".
///
/// THE LEVEL: a rolling high/low channel over the last SrLookbackBars 30-MINUTE bars (aggregated
/// here from SpotBarsOneMinute, independent of whatever timeframe the page itself is running at) -
/// resistance is that window's own High, support its own Low. Deliberately a plain rolling channel
/// rather than swing/fractal pivot detection: simpler to reason about and to test, and still a
/// legitimate, common definition of "the level currently in play." Only ever read as of the most
/// recently CLOSED 30-minute bar strictly before the bar being evaluated - never the still-forming
/// one - so this never looks ahead of what a live run could actually have known.
///
/// PRICE ACTION: walked bar by bar on context.SpotBars - the page's own selected timeframe (1 or 3
/// minute, exactly the "1min or 3min" the user asked for), which is also the SAME cadence
/// context.ObvCeSeries/CdvCeSeries already come pre-aggregated to, so the flow check below reads
/// data that lines up with the price bars with no separate re-aggregation of its own. Two setups:
///
///   REJECTION: a bar's High reaches resistance (or Low reaches support) but its own Close pulls
///   back beyond LevelBreakBufferPoints on the other side - a wick through the level that failed to
///   hold. Fires immediately, opposite direction to the level (a resistance rejection is Bearish, a
///   support rejection Bullish) - no flow confirmation needed, since a same-bar failure to hold is
///   already the outcome flow confirmation exists to predict for a break.
///
///   BREAKOUT + RETEST: a bar CLOSES beyond the level by at least LevelBreakBufferPoints (a
///   decisive break, not a rejection - see above). This starts a pending breakout that expires
///   after MaxRetestBars if price never comes back. If a later bar's Low (bullish) or High
///   (bearish) returns to within RetestTolerancePoints of the broken level, that retest bar is
///   where the call is made:
///     - order flow (OBV and/or CDV, per FlowMode) on the winning side (CE for a bullish breakout,
///       PE for a bearish one) is both NET RISING over FlowLookbackBars bars AND ACCELERATING (its
///       rise over the more recent half of that window bigger than over the earlier half, not just
///       flat or slowing) -> the breakout is real: a "Breakout" entry continuing in the ORIGINAL
///       breakout direction.
///     - otherwise -> it is a fakeout: an entry in the OPPOSITE direction, back into the range,
///       exactly the reversal the user described.
///
/// SELLING: this strategy exists to sell premium directionally, so its own "side" parameter
/// defaults to Sell (OptionTradeSimulator already handles the mirroring: a bullish call here sells
/// the PE, a bearish one sells the CE) - still user-overridable to Buy like every other strategy's
/// own side parameter, for symmetry and easy comparison. ExcludeLastDaysParameter is included for
/// the same reason OptionTradeSimulator's own doc comment gives it: a seller this close to expiry
/// has too little premium left to be worth selling.
/// </summary>
public sealed class SrFlowSellStrategy : IBacktestStrategy
{
    public string Key => "sr-flow-sell";
    public string Name => "S/R Rejection + Breakout-Retest Seller (CDV/OBV confirmed)";
    public string Description => "Sells premium directionally off a 30-minute support/resistance channel: an immediate reversal on a wick rejection of the level, or - on a decisive close through it - waits for a retest and uses OBV/CDV (rising and accelerating on the winning side) to tell a genuine breakout from a fakeout, entering with the breakout if confirmed or against it if not.";

    private const decimal ModeObvOnly = 0;
    private const decimal ModeCdvOnly = 1;
    private const decimal ModeEither = 2;
    private const decimal ModeBoth = 3;

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    private const int SrTimeframeMinutes = 30;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter() with { Default = OptionTradeSimulator.SideSell },
        OptionTradeSimulator.StrikeOffsetParameter() with { Default = 2 },
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        OptionTradeSimulator.ExcludeLastDaysParameter(),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish only"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish only"),
        }),
        new BacktestParameterSpec("srLookbackBars", "Support/resistance channel (30-min bars)", Default: 20, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("levelBreakBufferPoints", "Close must clear the level by at least (points)", Default: 10, Min: 0, Max: 500, Step: 1),
        new BacktestParameterSpec("retestTolerancePoints", "Counts as a retest within (points of the broken level)", Default: 10, Min: 0, Max: 500, Step: 1),
        new BacktestParameterSpec("maxRetestBars", "Give up waiting for a retest after (bars)", Default: 10, Min: 1, Max: 100, Step: 1),
        new BacktestParameterSpec("flowLookbackBars", "OBV/CDV rising+accelerating check window (bars)", Default: 6, Min: 2, Max: 60, Step: 1),
        new BacktestParameterSpec("flowMode", "Confirm breakout using", Default: ModeEither, Min: ModeObvOnly, Max: ModeBoth, Step: 1, Options: new[]
        {
            new BacktestParameterOption(ModeObvOnly, "OBV only"),
            new BacktestParameterOption(ModeCdvOnly, "CDV only"),
            new BacktestParameterOption(ModeEither, "Either OBV or CDV"),
            new BacktestParameterOption(ModeBoth, "Both OBV and CDV"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private sealed record PendingBreakout(bool Bullish, decimal Level, int BarIndex);

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var direction = parameters["direction"];
        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

        var srLookbackBars = Math.Max(1, (int)parameters["srLookbackBars"]);
        var levelBreakBufferPoints = parameters["levelBreakBufferPoints"];
        var retestTolerancePoints = parameters["retestTolerancePoints"];
        var maxRetestBars = Math.Max(1, (int)parameters["maxRetestBars"]);
        var flowLookbackBars = Math.Max(2, (int)parameters["flowLookbackBars"]);
        var flowMode = parameters["flowMode"];

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        var srBars = BacktestUtil.AggregateCandles(context.SpotBarsOneMinute, SrTimeframeMinutes);
        if (bars.Count == 0 || srBars.Count == 0) return (entries, signals);

        PendingBreakout? pending = null;
        var srIndex = -1; // index of the most recently CLOSED 30-min bar as of the current SpotBars bar

        for (var i = 0; i < bars.Count; i++)
        {
            var bar = bars[i];

            // Advance to every 30-min bar that has fully closed by this bar's own time - never the
            // bucket still forming through it, so the level in play is always one this bar could
            // actually have known about live.
            while (srIndex + 1 < srBars.Count && srBars[srIndex + 1].Time.AddMinutes(SrTimeframeMinutes) <= bar.Time)
                srIndex++;

            if (srIndex + 1 < srLookbackBars) continue; // not enough 30-min history yet for a full channel

            var windowStart = srIndex - srLookbackBars + 1;
            decimal? resistance = null, support = null;
            for (var w = windowStart; w <= srIndex; w++)
            {
                resistance = resistance is null ? srBars[w].High : Math.Max(resistance.Value, srBars[w].High);
                support = support is null ? srBars[w].Low : Math.Min(support.Value, srBars[w].Low);
            }

            var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes;

            // ---- Rejection: a wick through the level that failed to hold -------------------------
            if (resistance is { } r && bar.High >= r && bar.Close <= r - levelBreakBufferPoints)
            {
                Emit(bearish: true, "Rejection", $"Wicked to {bar.High:0.##} against resistance {r:0.##} (30-min, last {srLookbackBars} bars) but closed back below at {bar.Close:0.##}");
                pending = null;
            }
            else if (support is { } s && bar.Low <= s && bar.Close >= s + levelBreakBufferPoints)
            {
                Emit(bearish: false, "Rejection", $"Wicked to {bar.Low:0.##} against support {s:0.##} (30-min, last {srLookbackBars} bars) but closed back above at {bar.Close:0.##}");
                pending = null;
            }
            // ---- Fresh breakout: a decisive close through the level -------------------------------
            else if (resistance is { } r2 && bar.Close >= r2 + levelBreakBufferPoints && pending is not { Bullish: true })
            {
                pending = new PendingBreakout(Bullish: true, r2, i);
            }
            else if (support is { } s2 && bar.Close <= s2 - levelBreakBufferPoints && pending is not { Bullish: false })
            {
                pending = new PendingBreakout(Bullish: false, s2, i);
            }
            // ---- Retest of a pending breakout -> confirm (breakout) or reject (fakeout) -----------
            else if (pending is { } p && i > p.BarIndex)
            {
                if (i - p.BarIndex > maxRetestBars)
                {
                    pending = null; // gave up waiting - price never came back to retest
                }
                else
                {
                    var retested = p.Bullish ? bar.Low <= p.Level + retestTolerancePoints : bar.High >= p.Level - retestTolerancePoints;
                    if (retested)
                    {
                        var (accelerating, flowSummary) = IsAccelerating(context, bar.Time, p.Bullish, flowLookbackBars, flowMode);
                        var levelWord = p.Bullish ? "resistance" : "support";
                        if (accelerating)
                        {
                            Emit(bearish: !p.Bullish, "Breakout", $"Retested broken {levelWord} {p.Level:0.##} and {flowSummary} - continuing {(p.Bullish ? "up" : "down")}");
                        }
                        else
                        {
                            Emit(bearish: p.Bullish, "Fakeout", $"Retested broken {levelWord} {p.Level:0.##} but {flowSummary} - reversing back {(p.Bullish ? "down" : "up")}");
                        }
                        pending = null;
                    }
                }
            }

            continue;

            void Emit(bool bearish, string kind, string detail)
            {
                var dir = bearish ? "Bearish" : "Bullish";
                if (beforeSignalStart)
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{kind}: {detail} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
                }
                else if (bearish && !takeShorts)
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{kind}: {detail} - skipped, bullish only"));
                }
                else if (!bearish && !takeLongs)
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{kind}: {detail} - skipped, bearish only"));
                }
                else
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", dir, $"{kind}: {detail}"));
                    entries.Add((bar.Time, dir));
                }
            }
        }

        return (entries, signals.OrderByDescending(sig => sig.TimeUtc).ToList());
    }

    /// <summary>Whether order flow confirms a breakout in the given direction: the winning side's
    /// series (CE OBV/CDV for a bullish breakout, PE for a bearish one - the same leg
    /// OptionTradeSimulator would sell for that direction's opposite leg) has to be both NET RISING
    /// over the last <paramref name="lookbackBars"/> bars and ACCELERATING - its rise over the more
    /// recent half of that window bigger than over the earlier half, not just flat or slowing down.
    /// A move that is rising but decelerating is exactly the "slowing" case the user described as
    /// the sign of a fakeout, so it is deliberately NOT enough on its own here.</summary>
    private static (bool Accelerating, string Summary) IsAccelerating(
        BacktestStrategyContext context, DateTimeOffset at, bool bullish, int lookbackBars, decimal flowMode)
    {
        var half = lookbackBars / 2;
        var step = TimeSpan.FromMinutes(Math.Max(1, context.TimeframeMinutes));

        bool? SideAccelerating(IReadOnlyList<ObvPoint> series)
        {
            var samples = new List<decimal>();
            for (var k = lookbackBars; k >= 0; k--)
            {
                var v = BacktestUtil.LastValueAtOrBefore(series, at - step * k);
                if (v is null) return null; // not enough history yet
                samples.Add(v.Value);
            }
            var firstHalfRise = samples[half] - samples[0];
            var secondHalfRise = samples[^1] - samples[^(half + 1)];
            return secondHalfRise > 0 && secondHalfRise > firstHalfRise;
        }

        var series = bullish ? context.ObvCeSeries : context.ObvPeSeries;
        var cdvSeries = bullish ? context.CdvCeSeries : context.CdvPeSeries;
        var obv = SideAccelerating(series);
        var cdv = SideAccelerating(cdvSeries);

        var confirmed = flowMode switch
        {
            ModeObvOnly => obv ?? false,
            ModeCdvOnly => cdv ?? false,
            ModeBoth => (obv ?? false) && (cdv ?? false),
            _ => (obv ?? false) || (cdv ?? false),
        };

        var leg = bullish ? "CE" : "PE";
        var modeLabel = flowMode switch { ModeObvOnly => "OBV", ModeCdvOnly => "CDV", ModeBoth => "OBV and CDV", _ => "OBV or CDV" };
        var summary = confirmed
            ? $"{leg}'s {modeLabel} is rising and accelerating over the last {lookbackBars} bar(s)"
            : $"{leg}'s {modeLabel} is not both rising and accelerating over the last {lookbackBars} bar(s) (OBV {(obv is true ? "confirms" : obv is false ? "does not" : "n/a")}, CDV {(cdv is true ? "confirms" : cdv is false ? "does not" : "n/a")})";
        return (confirmed, summary);
    }
}
