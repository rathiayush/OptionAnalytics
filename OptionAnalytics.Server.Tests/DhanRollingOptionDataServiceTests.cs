using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers DhanRollingOptionDataService.ClipToRange - the guarantee that a caller asking
/// for [fromDay,toDay] never gets a bar from outside it, regardless of whatever Dhan's own toDate
/// boundary actually does in practice (see that method's own doc comment: a real run showed a bar
/// dated one day PAST an inclusive toDay even after compensating for Dhan's documented
/// "non-inclusive" toDate, so this app now enforces its own contract in code instead of trusting
/// either interpretation of Dhan's behavior).</summary>
public sealed class DhanRollingOptionDataServiceTests
{
    private static (CandleWithVolume Bar, decimal? Strike) Bar(DateTimeOffset time) =>
        (new CandleWithVolume(time, 10m, 11m, 9m, 10m, 0), 100m);

    private static DateTimeOffset At(int year, int month, int day, int hour = 9, int minute = 15) =>
        new(year, month, day, hour, minute, 0, TimeSpan.FromHours(5.5));

    [Fact]
    public void DropsABarFromTheDayAfterToDay()
    {
        // The exact real-world case this was added for: a rolling-option response came back with
        // an extra bar dated one day past the caller's own requested end date.
        var bars = new List<(CandleWithVolume, decimal?)> { Bar(At(2026, 8, 25)), Bar(At(2026, 8, 26)) };

        var clipped = DhanRollingOptionDataService.ClipToRange(bars, new DateOnly(2026, 8, 1), new DateOnly(2026, 8, 25));

        Assert.Single(clipped);
        Assert.Equal(new DateOnly(2026, 8, 25), IstClock.IstDate(clipped[0].Bar.Time));
    }

    [Fact]
    public void DropsABarFromBeforeFromDay()
    {
        var bars = new List<(CandleWithVolume, decimal?)> { Bar(At(2026, 7, 31)), Bar(At(2026, 8, 1)) };

        var clipped = DhanRollingOptionDataService.ClipToRange(bars, new DateOnly(2026, 8, 1), new DateOnly(2026, 8, 25));

        Assert.Single(clipped);
        Assert.Equal(new DateOnly(2026, 8, 1), IstClock.IstDate(clipped[0].Bar.Time));
    }

    [Fact]
    public void KeepsEveryBarStrictlyInsideTheRangeUntouched()
    {
        var bars = new List<(CandleWithVolume, decimal?)>
        {
            Bar(At(2026, 8, 1)), Bar(At(2026, 8, 15)), Bar(At(2026, 8, 25)),
        };

        var clipped = DhanRollingOptionDataService.ClipToRange(bars, new DateOnly(2026, 8, 1), new DateOnly(2026, 8, 25));

        Assert.Equal(3, clipped.Count);
    }

    [Fact]
    public void EmptyInput_ReturnsEmpty()
    {
        var clipped = DhanRollingOptionDataService.ClipToRange(new List<(CandleWithVolume, decimal?)>(), new DateOnly(2026, 8, 1), new DateOnly(2026, 8, 25));

        Assert.Empty(clipped);
    }
}
