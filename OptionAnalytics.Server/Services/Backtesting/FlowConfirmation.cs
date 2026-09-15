using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// Shared "does order flow favor this direction" check - originally EmaCrossAtmFlowStrategy's own
/// private FlowFavors/FlowConfirms, pulled out here once a second strategy (FiveEmaStrategy, as an
/// OPTIONAL opt-in filter) needed the exact same test rather than a second hand-kept-in-sync copy.
///
/// Favors(...) is TWO conditions, both required:
///   1. ORDERING: CE's own running total (OBV or CDV) strictly above PE's for a bullish direction,
///      PE above CE for a bearish one - the same "green over red" (CE) / "red over green" (PE)
///      reading the CDV/OBV chart itself is looked at for, at THIS bar's own moment.
///   2. RISING: that same winning side's own total higher now than it was one lookback window
///      earlier - being ahead right now is not enough on its own if that lead is actually shrinking.
///
/// minRisePercent (0 = off, any rise counts) optionally tightens condition 2 further to "risen by at
/// least this %" - see Favors' own doc comment for the sign/zero-base guard this requires.
/// </summary>
public static class FlowConfirmation
{
    public const decimal ModeObvOnly = 0;
    public const decimal ModeCdvOnly = 1;
    public const decimal ModeEither = 2;
    public const decimal ModeBoth = 3;

    /// <summary>Which flow measure has to favor the direction. OBV and CDV answer different
    /// questions - OBV is a running signed-volume total across the session, CDV a delta-weighted one
    /// that restarts each day (see BacktestStrategyContext) - so "either" is a genuinely looser
    /// filter than either alone and "both" a genuinely stricter one, rather than two spellings of the
    /// same test.</summary>
    public static BacktestParameterSpec ModeParameter(string label = "Flow must favor + rise toward the signal's direction on") =>
        new("flowMode", label, Default: ModeEither, Min: ModeObvOnly, Max: ModeBoth, Step: 1, Options: new[]
        {
            new BacktestParameterOption(ModeObvOnly, "OBV only"),
            new BacktestParameterOption(ModeCdvOnly, "CDV only"),
            new BacktestParameterOption(ModeEither, "Either OBV or CDV"),
            new BacktestParameterOption(ModeBoth, "Both OBV and CDV"),
        });

    public static BacktestParameterSpec LookbackParameter() =>
        new("flowLookbackBars", "Flow must be rising over (bars)", Default: 5, Min: 1, Max: 200, Step: 1);

    /// <summary>0 = off (the default) - any rise at all counts. See Favors' own doc comment for what
    /// setting this actually changes and why a sign-flipped or zero base can never meet it.</summary>
    public static BacktestParameterSpec MinRisePercentParameter() =>
        new("minFlowRisePercent", "Flow rise must be at least (%, 0 = off - any rise counts)", Default: 0, Min: 0, Max: 500, Step: 5);

    /// <summary>Whether a flow measure both sits on the side <paramref name="bullish"/> calls for
    /// AND is still gaining that way - see this class's own doc comment for the two conditions.
    /// Every series is read as "the last point at or before this time" so the comparison works even
    /// when CE/PE's own bars do not land on exactly the same timestamps as spot's; false when any
    /// reading needed is missing, since "no data" can neither favor a direction nor confirm a slope.
    ///
    /// <paramref name="minRisePercent"/> optionally tightens condition 2 from "any rise at all" to
    /// "risen by at least this %" (0, the default, keeps the plain "any rise" reading) - e.g. 30 to
    /// only count a move that is at least 30% bigger than it was a lookback ago. The percentage is
    /// only computed when the base (the earlier reading) is meaningful to divide by: a base of
    /// exactly zero, or one that sits on the OPPOSITE side of zero from the current reading (OBV/CDV
    /// are signed totals that can cross zero), makes a percentage technically computable but
    /// meaningless - e.g. a move from -5 to +50 is not "a 1100% rise" in any sense a threshold should
    /// accept - so either case is treated as not having met the threshold, rather than divide by a
    /// near-zero base into a huge, misleading number.</summary>
    public static bool Favors(IReadOnlyList<ObvPoint> ceSeries, IReadOnlyList<ObvPoint> peSeries, DateTimeOffset at, bool bullish, TimeSpan window, decimal minRisePercent = 0)
    {
        if (LastAtOrBefore(ceSeries, at) is not { } ceNow || LastAtOrBefore(peSeries, at) is not { } peNow) return false;

        var onRightSide = bullish ? ceNow > peNow : peNow > ceNow;
        if (!onRightSide) return false;

        var winningSeries = bullish ? ceSeries : peSeries;
        var winningNow = bullish ? ceNow : peNow;
        if (LastAtOrBefore(winningSeries, at - window) is not { } winningEarlier) return false;

        if (winningNow <= winningEarlier) return false;
        if (minRisePercent <= 0) return true;

        if (winningEarlier == 0 || Math.Sign(winningNow) != Math.Sign(winningEarlier)) return false;
        var risePercent = (winningNow - winningEarlier) / Math.Abs(winningEarlier) * 100m;
        return risePercent >= minRisePercent;
    }

    private static decimal? LastAtOrBefore(IReadOnlyList<ObvPoint> series, DateTimeOffset at)
    {
        decimal? value = null;
        foreach (var point in series)
        {
            if (point.Time > at) break; // series is time-ascending
            value = point.Obv;
        }
        return value;
    }

    public static bool Confirms(decimal flowMode, bool obvFavors, bool cdvFavors) => flowMode switch
    {
        ModeObvOnly => obvFavors,
        ModeCdvOnly => cdvFavors,
        ModeBoth => obvFavors && cdvFavors,
        _ => obvFavors || cdvFavors,
    };

    public static string ModeLabel(decimal flowMode) => flowMode switch
    {
        ModeObvOnly => "OBV",
        ModeCdvOnly => "CDV",
        ModeBoth => "OBV and CDV",
        _ => "OBV or CDV",
    };
}
