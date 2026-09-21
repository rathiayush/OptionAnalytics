namespace NiftyDataCollector;

/// <summary>India Standard Time is a fixed UTC+5:30 offset with no daylight saving - same
/// single-constant approach as OptionAnalytics.Server's own IstClock, copied rather than shared
/// (see this project's README for why).</summary>
public static class IstClock
{
    public static readonly TimeSpan Offset = TimeSpan.FromHours(5.5);

    public static DateOnly Today() => DateOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(Offset).DateTime);
}
