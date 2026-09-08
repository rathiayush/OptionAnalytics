using System.Globalization;
using OptionAnalytics.Server;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// IstClock consolidates a value (TimeSpan.FromHours(5.5)) and a conversion that used to be
/// independently repeated in six files (DhanTickPacketParser, BacktestUtil, SpotFeedHostedService,
/// CdvHostedService, CdvUnderlyingState, StrategyTriggerHostedService). These tests exist to lock
/// down that every caller's actual observed behavior - the exact IST calendar date a given instant
/// falls on, including right at the day boundary - is unchanged now that it all reads from one
/// place.
/// </summary>
public sealed class IstClockTests
{
    [Fact]
    public void Offset_IsThirtyMinutesPastFiveHours()
    {
        Assert.Equal(TimeSpan.FromMinutes(5 * 60 + 30), IstClock.Offset);
    }

    [Fact]
    public void IstDate_JustBeforeMidnightIst_IsStillThatDay()
    {
        // 23:59 IST on 4 Jan is 18:29 UTC on 4 Jan - one minute before the IST date rolls over.
        var utc = DateTimeOffset.Parse("2026-01-04T18:29:00Z", CultureInfo.InvariantCulture);

        Assert.Equal(new DateOnly(2026, 1, 4), IstClock.IstDate(utc));
    }

    [Fact]
    public void IstDate_JustAfterMidnightIst_HasRolledOverToTheNextDay()
    {
        // 00:00 IST on 5 Jan is 18:30 UTC on 4 Jan - exactly where the IST date rolls over, the
        // case every caller here (trading-day boundaries, on-demand cache keys) actually cares about.
        var utc = DateTimeOffset.Parse("2026-01-04T18:30:00Z", CultureInfo.InvariantCulture);

        Assert.Equal(new DateOnly(2026, 1, 5), IstClock.IstDate(utc));
    }

    [Fact]
    public void IstDate_IsIndependentOfTheInputOffsetItself()
    {
        // The same instant expressed with a DateTimeOffset already carrying IST's own +05:30 offset
        // must resolve to the identical calendar date as the UTC form of the same instant - IstDate
        // converts to a fixed offset, it does not care what offset the input arrived in.
        var asUtc = DateTimeOffset.Parse("2026-01-05T09:20:00Z", CultureInfo.InvariantCulture);
        var asIst = DateTimeOffset.Parse("2026-01-05T14:50:00+05:30", CultureInfo.InvariantCulture);

        Assert.Equal(asUtc.ToUnixTimeSeconds(), asIst.ToUnixTimeSeconds()); // same instant, sanity check
        Assert.Equal(IstClock.IstDate(asUtc), IstClock.IstDate(asIst));
    }

    [Fact]
    public void Today_MatchesIstDateOfUtcNow()
    {
        // Today() is documented as IstDate(DateTimeOffset.UtcNow) - assert that relationship holds
        // rather than the literal value, since the literal value depends on when the test runs.
        Assert.Equal(IstClock.IstDate(DateTimeOffset.UtcNow), IstClock.Today());
    }

    [Fact]
    public void AtIstTime_AfternoonMinutes_ResolvesToThatIstWallClockTime()
    {
        // 915 = 15*60+15 -> 15:15 IST, per the method's own doc comment.
        var cutoff = IstClock.AtIstTime(new DateOnly(2026, 1, 5), 915);

        Assert.Equal(DateTimeOffset.Parse("2026-01-05T15:15:00+05:30", CultureInfo.InvariantCulture), cutoff);
        // Same instant as 09:45 UTC that day - the actual absolute time this cutoff compares
        // bar-by-bar against in OptionTradeSimulator.Run/SquareOffIfDueAsync.
        Assert.Equal(DateTimeOffset.Parse("2026-01-05T09:45:00Z", CultureInfo.InvariantCulture), cutoff);
    }

    [Fact]
    public void AtIstTime_RoundTripsThroughIstDate()
    {
        // The exact pairing OptionTradeSimulator.Run/SquareOffIfDueAsync rely on: the date a
        // cutoff is built FOR must itself report back as that same date.
        var date = new DateOnly(2026, 3, 17);
        var cutoff = IstClock.AtIstTime(date, 570); // 09:30 IST

        Assert.Equal(date, IstClock.IstDate(cutoff));
    }
}
