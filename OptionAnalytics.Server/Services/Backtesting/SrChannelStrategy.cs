using OptionAnalytics.Server.Models;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A port of LonesomeTheBlue's "Support Resistance Channels" (Mozilla Public License 2.0) as a
/// SEPARATE strategy alongside LuxAlgoSrBreakStrategy and SrFlowSellStrategy - a genuinely different
/// definition of "the level" again (a CLUSTER of nearby pivots ranked by strength, not one held-flat
/// pivot line or a rolling single channel), the user's own explicit choice to add rather than merge.
///
/// THE LEVELS: swing-high/low pivots (ta.pivothigh/pivotlow(prd, prd), same confirmation-lag pivot
/// detection as LuxAlgoSrBreakStrategy, via Skender's GetPivots with the same forward-shift-by-prd
/// fix for its look-ahead-biased index) are grouped into up to 10 "channels" - a channel is a
/// [Bottom,Top] band no wider than <c>channelWidthPercent</c>% of the last 300 bars' own High-Low
/// range, built by greedily merging every pivot that fits within that width of a seed pivot. Each
/// channel's strength is 20 per pivot it contains, plus one point for every bar (over
/// <c>loopbackBars</c>) whose High or Low actually sits inside it - a channel price has repeatedly
/// interacted with outranks a lonelier one with the same pivot count. The <c>maxChannels</c>
/// strongest, non-overlapping channels (ties broken by pick order, which is already
/// strength-descending - the source's own trailing sort is a no-op given that, so it is not
/// reimplemented here) are what ENTRY watches; recomputed only when a new pivot confirms, held flat
/// otherwise, the same "hold until the next event" shape LuxAlgoSrBreakStrategy's own lines use.
///
/// ENTRY mirrors the source's own two alertcondition()s: a close outside every current channel that
/// was at-or-inside a channel's Top on the PREVIOUS bar and is now above it (Bullish - "Resistance
/// Broken"), or was at-or-inside a channel's Bottom and is now below it (Bearish - "Support Broken").
/// Reported against whichever qualifying channel a breakout is nearest for the signal text; the
/// source itself does not distinguish which channel produced its one alertcondition() when several
/// would independently qualify on the same bar (a rare edge case, not a bug to replicate more finely
/// than the source cares to).
///
/// OPTIONAL order-flow (CDV/OBV) confirmation, off by default - the same FlowConfirmation filter
/// LuxAlgoSrBreakStrategy/FiveEmaStrategy use, applied on top of the channel break rather than in
/// place of it.
///
/// EXIT/stop/target: the source is a pure marker/alert indicator with no taught trade management, so
/// this uses the app's standard option-premium stop/target parameters, same as every other strategy.
/// </summary>
public sealed class SrChannelStrategy : IBacktestStrategy
{
    public string Key => "sr-channel";
    public string Name => "S/R Channels (LonesomeTheBlue)";
    public string Description => "Support/resistance built from CLUSTERS of nearby confirmed swing pivots (LonesomeTheBlue's public-domain indicator), ranked by how many pivots + how much price has interacted with each band. Entry when close breaks out of every current channel: above one it was inside/below (Bullish) or below one it was inside/above (Bearish). Optionally also requires order flow (OBV/CDV) to confirm.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    private const decimal SourceHighLow = 0;
    private const decimal SourceCloseOpen = 1;

    private const decimal FlagOff = 0;
    private const decimal FlagOn = 1;

    /// <summary>Pine's own fixed "ta.highest(300)/ta.lowest(300)" range used to size a channel's
    /// maximum width - not exposed as a user input in the source indicator either.</summary>
    private const int ChannelWidthRangeBars = 300;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
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
        new BacktestParameterSpec("pivotPeriod", "Pivot period (left/right bars)", Default: 10, Min: 4, Max: 30, Step: 1),
        new BacktestParameterSpec("ppSource", "Pivot source", Default: SourceHighLow, Min: SourceHighLow, Max: SourceCloseOpen, Step: 1, Options: new[]
        {
            new BacktestParameterOption(SourceHighLow, "High/Low"),
            new BacktestParameterOption(SourceCloseOpen, "Close/Open"),
        }),
        new BacktestParameterSpec("channelWidthPercent", "Maximum channel width (% of 300-bar range)", Default: 5, Min: 1, Max: 8, Step: 1),
        new BacktestParameterSpec("minStrength", "Minimum strength (pivots a channel must contain)", Default: 1, Min: 1, Max: 10, Step: 1),
        new BacktestParameterSpec("maxChannels", "Maximum number of S/R channels", Default: 6, Min: 1, Max: 10, Step: 1),
        new BacktestParameterSpec("loopbackBars", "Loopback period (bars, for pivots + strength)", Default: 290, Min: 100, Max: 400, Step: 10),
        // Optional order-flow (CDV/OBV) confirmation - off by default, same as LuxAlgoSrBreakStrategy,
        // so the channel break's own price action is unaffected unless deliberately turned on.
        new BacktestParameterSpec("requireFlowConfirmation", "Also require order flow (OBV/CDV) to confirm", Default: FlagOff, Min: FlagOff, Max: FlagOn, Step: 1, Options: new[]
        {
            new BacktestParameterOption(FlagOff, "No - price action only"),
            new BacktestParameterOption(FlagOn, "Yes - flow must also favor + rise toward the entry"),
        }),
        FlowConfirmation.LookbackParameter(),
        FlowConfirmation.MinRisePercentParameter(),
        FlowConfirmation.ModeParameter(),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var direction = parameters["direction"];
        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);
        var pivotPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("pivotPeriod", 10));
        var useCloseOpen = parameters.GetValueOrDefault("ppSource", SourceHighLow) >= (SourceHighLow + SourceCloseOpen) / 2;
        var channelWidthPercent = parameters.GetValueOrDefault("channelWidthPercent", 5m);
        var minStrengthUnits = Math.Max(1, (int)parameters.GetValueOrDefault("minStrength", 1)) * 20m;
        var maxChannels = Math.Clamp((int)parameters.GetValueOrDefault("maxChannels", 6), 1, 10);
        var loopbackBars = Math.Max(30, (int)parameters.GetValueOrDefault("loopbackBars", 290));
        var requireFlowConfirmation = parameters.GetValueOrDefault("requireFlowConfirmation", FlagOff) >= (FlagOff + FlagOn) / 2;
        var flowLookback = (int)parameters.GetValueOrDefault("flowLookbackBars", 5);
        var minFlowRisePercent = parameters.GetValueOrDefault("minFlowRisePercent", 0m);
        var flowMode = parameters.GetValueOrDefault("flowMode", FlowConfirmation.ModeEither);
        var flowWindow = TimeSpan.FromMinutes((double)Math.Max(1, flowLookback) * Math.Max(1, context.TimeframeMinutes));

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (bars.Count < 2) return (entries, signals);

        var pivotEventsByConfirmIndex = PivotEventsByConfirmIndex(bars, pivotPeriod, useCloseOpen);

        (bool Ok, string Reason) FlowCheck(bool bullish, DateTimeOffset at)
        {
            if (!requireFlowConfirmation) return (true, "");
            var obvFavors = FlowConfirmation.Favors(context.ObvCeSeries, context.ObvPeSeries, at, bullish, flowWindow, minFlowRisePercent);
            var cdvFavors = FlowConfirmation.Favors(context.CdvCeSeries, context.CdvPeSeries, at, bullish, flowWindow, minFlowRisePercent);
            var confirmed = FlowConfirmation.Confirms(flowMode, obvFavors, cdvFavors);
            var riseRequirement = minFlowRisePercent > 0 ? $"risen at least {minFlowRisePercent:0.##}%" : "risen at all";
            var reason = confirmed
                ? $"flow favors {(bullish ? "CE over PE" : "PE over CE")} and has {riseRequirement} over the last {flowLookback} bar(s) ({FlowConfirmation.ModeLabel(flowMode)})"
                : $"flow does not favor {(bullish ? "CE over PE" : "PE over CE")} and {riseRequirement} over the last {flowLookback} bar(s) as required ({FlowConfirmation.ModeLabel(flowMode)}; OBV {(obvFavors ? "confirms it" : "does not")}, CDV {(cdvFavors ? "confirms it" : "does not")})";
            return (confirmed, reason);
        }

        var pivots = new List<(decimal Value, int ConfirmIndex)>();
        var channels = new List<(decimal Top, decimal Bottom, decimal Strength)>();

        for (var i = 1; i < bars.Count; i++)
        {
            if (pivotEventsByConfirmIndex.TryGetValue(i, out var newValues))
            {
                foreach (var value in newValues) pivots.Insert(0, (value, i));
                while (pivots.Count > 0 && i - pivots[^1].ConfirmIndex > loopbackBars) pivots.RemoveAt(pivots.Count - 1);
                channels = ComputeChannels(pivots, bars, i, channelWidthPercent, minStrengthUnits, loopbackBars, maxChannels);
            }

            if (channels.Count == 0) continue;

            var bar = bars[i];
            var prevBar = bars[i - 1];
            var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes;

            if (channels.Any(c => bar.Close <= c.Top && bar.Close >= c.Bottom)) continue; // Pine's not_in_a_channel guard

            var brokenResistance = channels.Where(c => prevBar.Close <= c.Top && bar.Close > c.Top).OrderByDescending(c => c.Strength).ToList();
            var brokenSupport = channels.Where(c => prevBar.Close >= c.Bottom && bar.Close < c.Bottom).OrderByDescending(c => c.Strength).ToList();

            if (brokenSupport.Count > 0)
            {
                var level = brokenSupport[0];
                var summary = $"Close broke below the {level.Bottom:0.##}-{level.Top:0.##} S/R channel";
                if (beforeSignalStart)
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bearish", $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
                else if (!takeShorts)
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bearish", $"{summary} - skipped, longs only"));
                else if (FlowCheck(bullish: false, bar.Time) is (false, var rejectFlowReason))
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bearish", $"{summary} - but {rejectFlowReason}"));
                else
                {
                    var flowReason = requireFlowConfirmation ? FlowCheck(false, bar.Time).Reason : null;
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", "Bearish", flowReason is { Length: > 0 } ? $"{summary}, and {flowReason}" : summary));
                    entries.Add((bar.Time, "Bearish"));
                }
            }
            else if (brokenResistance.Count > 0)
            {
                var level = brokenResistance[0];
                var summary = $"Close broke above the {level.Bottom:0.##}-{level.Top:0.##} S/R channel";
                if (beforeSignalStart)
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bullish", $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
                else if (!takeLongs)
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bullish", $"{summary} - skipped, shorts only"));
                else if (FlowCheck(bullish: true, bar.Time) is (false, var rejectFlowReason))
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bullish", $"{summary} - but {rejectFlowReason}"));
                else
                {
                    var flowReason = requireFlowConfirmation ? FlowCheck(true, bar.Time).Reason : null;
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", "Bullish", flowReason is { Length: > 0 } ? $"{summary}, and {flowReason}" : summary));
                    entries.Add((bar.Time, "Bullish"));
                }
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }

    /// <summary>Every confirmed pivot (Pine's ta.pivothigh/pivotlow(prd, prd)), keyed by the bar index
    /// it actually becomes knowable at - i + prd, the same forward shift LuxAlgoSrBreakStrategy.
    /// PivotLines uses and for the same reason (Skender's GetPivots reports the value at the ORIGINAL
    /// swing bar, not the confirmation bar). ppSource's "Close/Open" option is reproduced by handing
    /// Skender synthetic quotes whose High/Low are max(Close,Open)/min(Close,Open) instead of the
    /// bar's real High/Low - GetPivots only ever reads those two fields, so this is exactly the
    /// substitution Pine's own ppsrc switch makes. A bar that is a pivot high AND a pivot low at once
    /// still only contributes one value here (the high, ties broken the same way Pine's own
    /// `bool(ph) ? ph : pl` ternary would) - two different ORIGINAL bars that happen to shift onto the
    /// same confirmation bar remain two separate pivots, same as Pine's own bar-by-bar unshift would
    /// produce.</summary>
    private static Dictionary<int, List<decimal>> PivotEventsByConfirmIndex(IReadOnlyList<Candle> bars, int pivotPeriod, bool useCloseOpen)
    {
        var quotes = bars.Select(b =>
        {
            var (hi, lo) = useCloseOpen ? (Math.Max(b.Close, b.Open), Math.Min(b.Close, b.Open)) : (b.High, b.Low);
            return new Quote { Date = b.Time.UtcDateTime, Open = b.Open, High = hi, Low = lo, Close = b.Close, Volume = 0 };
        }).ToList();
        var results = quotes.GetPivots(pivotPeriod, pivotPeriod).ToList();

        var events = new Dictionary<int, List<decimal>>();
        for (var i = 0; i < results.Count; i++)
        {
            decimal? value = results[i].HighPoint is { } hp ? (decimal)hp : results[i].LowPoint is { } lp ? (decimal)lp : null;
            if (value is not { } v) continue;
            var confirmIndex = Math.Min(bars.Count - 1, i + pivotPeriod);
            if (!events.TryGetValue(confirmIndex, out var list)) events[confirmIndex] = list = new List<decimal>();
            list.Add(v);
        }
        return events;
    }

    /// <summary>Groups the pivots currently within the loopback window into up to 10 non-overlapping
    /// [Bottom,Top] channels and returns the <paramref name="maxChannels"/> strongest, strongest
    /// first - a direct port of the source's get_sr_vals/the strength-accumulation loop/the greedy
    /// selection loop that follows it, run fresh each time a new pivot confirms
    /// (<paramref name="pivots"/> is already pruned to the loopback window and ordered newest-first,
    /// matching Pine's own array.unshift order - the merge loop below is a single deterministic pass,
    /// not order-independent, so that order has to match for the same channels to come out).</summary>
    /// <summary>Internal (not private) purely so SrChannelStrategyTests can exercise the
    /// pivot-clustering/ranking math directly with a hand-built pivot list, rather than needing to
    /// engineer a real price fixture that happens to produce two mergeable Skender pivots.</summary>
    internal static List<(decimal Top, decimal Bottom, decimal Strength)> ComputeChannels(
        List<(decimal Value, int ConfirmIndex)> pivots, IReadOnlyList<Candle> bars, int currentIndex,
        decimal channelWidthPercent, decimal minStrengthUnits, int loopbackBars, int maxChannels)
    {
        if (pivots.Count == 0) return new List<(decimal, decimal, decimal)>();

        var rangeStart = Math.Max(0, currentIndex - ChannelWidthRangeBars + 1);
        var highest = decimal.MinValue;
        var lowest = decimal.MaxValue;
        for (var i = rangeStart; i <= currentIndex; i++)
        {
            if (bars[i].High > highest) highest = bars[i].High;
            if (bars[i].Low < lowest) lowest = bars[i].Low;
        }
        var channelWidth = (highest - lowest) * channelWidthPercent / 100m;

        var candidates = new (decimal Strength, decimal Top, decimal Bottom)[pivots.Count];
        for (var x = 0; x < pivots.Count; x++)
        {
            var lo = pivots[x].Value;
            var hi = lo;
            decimal pivotCount = 0;
            for (var y = 0; y < pivots.Count; y++)
            {
                var candidate = pivots[y].Value;
                var width = candidate <= hi ? hi - candidate : candidate - lo;
                if (width > channelWidth) continue;
                if (candidate <= hi) lo = Math.Min(lo, candidate); else hi = Math.Max(hi, candidate);
                pivotCount += 20;
            }
            candidates[x] = (pivotCount, hi, lo);
        }

        for (var x = 0; x < candidates.Length; x++)
        {
            var (strength, top, bottom) = candidates[x];
            decimal overlap = 0;
            for (var y = 0; y <= loopbackBars && currentIndex - y >= 0; y++)
            {
                var bar = bars[currentIndex - y];
                if ((bar.High <= top && bar.High >= bottom) || (bar.Low <= top && bar.Low >= bottom)) overlap++;
            }
            candidates[x] = (strength + overlap, top, bottom);
        }

        var picked = new List<(decimal Strength, decimal Top, decimal Bottom)>();
        var remaining = candidates.Select(c => c.Strength).ToArray();
        for (var pick = 0; pick < 10; pick++)
        {
            var bestIndex = -1;
            var bestStrength = minStrengthUnits - 1;
            for (var y = 0; y < candidates.Length; y++)
            {
                if (remaining[y] > bestStrength) { bestStrength = remaining[y]; bestIndex = y; }
            }
            if (bestIndex < 0) break;

            var (strength, top, bottom) = candidates[bestIndex];
            picked.Add((strength, top, bottom));

            for (var y = 0; y < candidates.Length; y++)
            {
                var (_, h, l) = candidates[y];
                if ((h <= top && h >= bottom) || (l <= top && l >= bottom)) remaining[y] = minStrengthUnits - 1;
            }
        }

        return picked
            .OrderByDescending(p => p.Strength)
            .Take(maxChannels)
            .Select(p => (p.Top, p.Bottom, p.Strength))
            .ToList();
    }
}
