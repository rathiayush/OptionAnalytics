using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>PriceOiDivergenceDetector: price falls (rises) for three minutes while the nearest strike's OI
/// does not give way - and every condition that keeps a false alert from going out.</summary>
public sealed class PriceOiDivergenceTests
{
    private static readonly TimeSpan Ist = TimeSpan.FromHours(5.5);
    private static DateTimeOffset At(int hour, int minute) => new(2026, 10, 7, hour, minute, 0, Ist);
    private static readonly DivergenceOptions Options = new();

    // Closes oldest first, one per minute, the last bar being the minute starting at (hour, minute).
    private static List<Candle> Bars(int hour, int minute, params decimal[] closes) =>
        closes.Select((c, i) => new Candle(At(hour, minute).AddMinutes(i - (closes.Length - 1)), c, c, c, c)).ToList();

    private static long Minute(DateTimeOffset t) => t.ToUnixTimeSeconds() / 60;

    // OI per (side, strike): value at the start minute and at the end minute; every other minute carries the start.
    private sealed class Book
    {
        private readonly Dictionary<(string, decimal), (long Start, long End)> _oi = new();
        public Book Set(string side, decimal strike, long start, long end) { _oi[(side, strike)] = (start, end); return this; }
        public IEnumerable<decimal> Strikes => _oi.Keys.Select(k => k.Item2).Distinct();
        public Func<string, decimal, long, long?> Reader(DateTimeOffset endBar)
        {
            var end = Minute(endBar);
            return (side, strike, minute) => _oi.TryGetValue((side, strike), out var v) ? (minute >= end ? v.End : v.Start) : null;
        }
    }

    // Spot 24,520 -> 24,500 over three minutes; PE 24,500 holds and a few strikes around it move.
    private static Book LiveBook() => new Book()
        .Set("PE", 24500, 4_000_000, 4_060_000)   // +1.5%
        .Set("PE", 24450, 3_000_000, 3_010_000)
        .Set("PE", 24550, 2_000_000, 2_020_000)
        .Set("CE", 24500, 3_500_000, 3_520_000)
        .Set("CE", 24550, 3_000_000, 3_005_000);

    private static PriceOiDivergence? Run(List<Candle> bars, Book book, DivergenceOptions? options = null) =>
        PriceOiDivergenceDetector.Evaluate("NIFTY", bars, 50, book.Strikes, book.Reader(bars[^1].Time), options ?? Options);

    [Fact]
    public void FallingPriceWithHoldingPutOi_IsADiscountZone()
    {
        var bars = Bars(11, 30, 24520, 24514, 24507, 24500);
        var result = Run(bars, LiveBook());

        Assert.NotNull(result);
        Assert.Equal("Discount", result!.Zone);
        Assert.Equal("PE", result.Side);
        Assert.Equal(24500m, result.Strike);
        Assert.Equal(4_000_000, result.OiBefore);
        Assert.Equal(4_060_000, result.OiNow);
        Assert.InRange(result.OiChangePct, 1.49m, 1.51m);
        Assert.Contains("support being defended", result.Message);
    }

    [Fact]
    public void RisingPriceWithHoldingCallOi_IsAPremiumZone()
    {
        var bars = Bars(11, 30, 24480, 24486, 24493, 24500);
        var result = Run(bars, LiveBook());

        Assert.NotNull(result);
        Assert.Equal("Premium", result!.Zone);
        Assert.Equal("CE", result.Side);
        Assert.Equal(24500m, result.Strike);
    }

    [Fact]
    public void OiThatBarelyMoved_StillCountsAsHolding()
    {
        var book = LiveBook().Set("PE", 24500, 4_000_000, 3_990_000); // -0.25%, inside the tolerance
        Assert.NotNull(Run(Bars(11, 30, 24520, 24514, 24507, 24500), book));
    }

    [Fact]
    public void OiThatUnwound_IsNotADivergence()
    {
        var book = LiveBook().Set("PE", 24500, 4_000_000, 3_900_000); // -2.5%: the support gave way
        Assert.Null(Run(Bars(11, 30, 24520, 24514, 24507, 24500), book));
    }

    [Fact]
    public void OneUpMinuteInTheMiddle_IsNotAThreeMinuteFall()
    {
        Assert.Null(Run(Bars(11, 30, 24520, 24510, 24512, 24500), LiveBook()));
    }

    [Fact]
    public void ASmallMove_IsNotEnough()
    {
        // 24,505 -> 24,500 is 0.02%
        Assert.Null(Run(Bars(11, 30, 24505, 24504, 24502, 24500), LiveBook()));
    }

    [Fact]
    public void FlatOiEverywhere_MeansTheFeedWasQuiet_NotThatOiHeld()
    {
        var book = new Book()
            .Set("PE", 24500, 4_000_000, 4_000_000)
            .Set("PE", 24450, 3_000_000, 3_000_000)
            .Set("CE", 24500, 3_500_000, 3_500_000);
        Assert.Null(Run(Bars(11, 30, 24520, 24514, 24507, 24500), book));
    }

    [Fact]
    public void AThinStrike_IsNotAWall()
    {
        var book = LiveBook().Set("PE", 24500, 300_000, 310_000).Set("PE", 24450, 4_000_000, 4_040_000); // 24,500 is under 25% of the side's biggest
        Assert.Null(Run(Bars(11, 30, 24520, 24514, 24507, 24500), book));
    }

    [Fact]
    public void NothingAtTheOpenOrTheClose()
    {
        Assert.Null(Run(Bars(9, 20, 24520, 24514, 24507, 24500), LiveBook()));
        Assert.Null(Run(Bars(15, 20, 24520, 24514, 24507, 24500), LiveBook()));
    }

    [Fact]
    public void AMissingMinute_StopsIt()
    {
        var bars = Bars(11, 30, 24520, 24514, 24507, 24500);
        bars.RemoveAt(2); // a gap in the feed
        Assert.Null(Run(bars, LiveBook()));
    }

    [Fact]
    public void WithoutAnOiReadingAtTheStart_NothingIsSaid()
    {
        var bars = Bars(11, 30, 24520, 24514, 24507, 24500);
        var reader = LiveBook().Reader(bars[^1].Time);
        long? Missing(string side, decimal strike, long minute) => minute < Minute(bars[^1].Time) ? null : reader(side, strike, minute);
        Assert.Null(PriceOiDivergenceDetector.Evaluate("NIFTY", bars, 50, LiveBook().Strikes, Missing, Options));
    }

    // ---- Confirmation: a zone is only sent once the 5 minutes after it confirm it ----

    // The discount zone found at 11:30 (spot 24,520 -> 24,500, PE 24,500 holding), and the minutes after it.
    private static readonly List<Candle> Fall = Bars(11, 30, 24520, 24514, 24507, 24500);
    private static PriceOiDivergence Zone(List<Candle>? bars = null) => Run(bars ?? Fall, LiveBook())!;

    // The minutes after 11:30, one close each (11:31, 11:32, ...); low / high = the close unless given.
    private static List<Candle> After(List<Candle> move, params decimal[] closes) =>
        move.Concat(closes.Select((c, i) => new Candle(move[^1].Time.AddMinutes(i + 1), c, c, c, c))).ToList();

    // PE / CE OI at 24,500: the start value before the move ends, `later` from the minute after it.
    private static Func<string, decimal, long, long?> OiLater(long later)
    {
        var end = Minute(Fall[^1].Time);
        var reader = LiveBook().Reader(Fall[^1].Time);
        return (side, strike, minute) => strike == 24500 && minute > end ? later : reader(side, strike, minute);
    }

    private static DivergenceConfirmation Confirm(PriceOiDivergence zone, List<Candle> bars, long oiLater = 4_080_000, DivergenceOptions? o = null) =>
        PriceOiDivergenceDetector.Confirm(zone, bars, OiLater(oiLater), o ?? Options);

    [Fact]
    public void ADiscountZone_IsConfirmed_WhenTheNextFiveMinutesHoldTheLowAndTurnUp()
    {
        var zone = Zone();
        Assert.Equal(24500m, zone.Extreme);
        var result = Confirm(zone, After(Fall, 24503, 24501, 24506, 24510, 24512));

        Assert.Equal(DivergenceConfirmState.Confirmed, result.State);
        var alert = result.Alert!;
        Assert.Equal(5, alert.ConfirmMinutes);
        Assert.Equal(Fall[^1].Time.AddMinutes(5), alert.ConfirmedBarTime);
        Assert.Equal(24512m, alert.ConfirmPrice);
        Assert.Equal(4_080_000, alert.OiConfirm);
        Assert.InRange(alert.OiConfirmChangePct!.Value, 1.99m, 2.01m);
        Assert.Equal(zone.BarTime, alert.BarTime);
        Assert.Contains("CONFIRMED after 5 min", alert.Message);
        Assert.Contains("no close below the low of 24500", alert.Message);
    }

    [Fact]
    public void BeforeTheFiveMinutesHavePassed_ItWaits()
    {
        Assert.Equal(DivergenceConfirmState.Waiting, Confirm(Zone(), Fall).State);
        Assert.Equal(DivergenceConfirmState.Waiting, Confirm(Zone(), After(Fall, 24503, 24501, 24506, 24510)).State);
    }

    [Fact]
    public void ACloseBelowTheLow_FailsItAtOnce()
    {
        var result = Confirm(Zone(), After(Fall, 24503, 24495));
        Assert.Equal(DivergenceConfirmState.Failed, result.State);
        Assert.Contains("below the low", result.Reason);
    }

    [Fact]
    public void AWickBelowTheLow_ThatClosesBackAbove_StillHolds()
    {
        var bars = After(Fall, 24503, 24501, 24506, 24510, 24512);
        bars[^4] = new Candle(bars[^4].Time, 24503, 24504, 24490, 24501); // 11:32 dipped to 24,490, closed 24,501
        Assert.Equal(DivergenceConfirmState.Confirmed, Confirm(Zone(), bars).State);
    }

    [Fact]
    public void PriceThatDidNotTurnBack_IsNotConfirmed()
    {
        var result = Confirm(Zone(), After(Fall, 24503, 24501, 24502, 24501, 24500)); // still at the 24,500 it fell to
        Assert.Equal(DivergenceConfirmState.Failed, result.State);
        Assert.Contains("not back above", result.Reason);
    }

    [Fact]
    public void OiThatUnwoundWhileWaiting_IsNotConfirmed()
    {
        var result = Confirm(Zone(), After(Fall, 24503, 24501, 24506, 24510, 24512), oiLater: 3_900_000); // -2.5% vs the start
        Assert.Equal(DivergenceConfirmState.Failed, result.State);
        Assert.Contains("unwound", result.Reason);
    }

    [Fact]
    public void AMissingMinuteWhileWaiting_IsNotConfirmed()
    {
        var bars = After(Fall, 24503, 24501, 24506, 24510, 24512, 24513);
        bars.RemoveAt(Fall.Count + 1); // 11:32 never arrived
        var result = Confirm(Zone(), bars);
        Assert.Equal(DivergenceConfirmState.Failed, result.State);
        Assert.Contains("missing", result.Reason);
    }

    [Fact]
    public void APremiumZone_IsConfirmed_WhenTheHighHoldsAndPriceTurnsDown()
    {
        var rise = Bars(11, 30, 24480, 24486, 24493, 24500);
        var zone = Run(rise, LiveBook())!;
        Assert.Equal("Premium", zone.Zone);
        Assert.Equal(24500m, zone.Extreme);
        var ce = LiveBook().Reader(rise[^1].Time);
        var ok = PriceOiDivergenceDetector.Confirm(zone, After(rise, 24497, 24499, 24494, 24490, 24488), ce, Options);
        Assert.Equal(DivergenceConfirmState.Confirmed, ok.State);
        Assert.Contains("no close above the high of 24500", ok.Alert!.Message);

        var broke = PriceOiDivergenceDetector.Confirm(zone, After(rise, 24497, 24505), ce, Options);
        Assert.Equal(DivergenceConfirmState.Failed, broke.State);
        Assert.Contains("above the high", broke.Reason);
    }

    [Fact]
    public void TheGate_SendsAZoneOnlyAfterItsFiveMinutes_ThenCoolsDown()
    {
        var gate = new DivergenceGate(Options);
        var oi = OiLater(4_080_000);
        var zone = Zone();
        var bars = After(Fall, 24503, 24501, 24506, 24510, 24512);

        // 11:30 closes: found, not sent.
        var (alerts, dropped) = gate.OnBar("NIFTY", Fall, oi, zone);
        Assert.Empty(alerts);
        Assert.Empty(dropped);
        Assert.Single(gate.Pending);

        // 11:31 - 11:34: still waiting; the same zone found again meanwhile is not started twice.
        for (var k = 1; k <= 4; k++)
        {
            (alerts, _) = gate.OnBar("NIFTY", bars.Take(Fall.Count + k).ToList(), oi, k == 2 ? zone with { BarTime = zone.BarTime.AddMinutes(2) } : null);
            Assert.Empty(alerts);
        }
        Assert.Single(gate.Pending);

        // 11:35 closes: confirmed and sent.
        (alerts, _) = gate.OnBar("NIFTY", bars, oi, null);
        Assert.Single(alerts);
        Assert.Equal(5, alerts[0].ConfirmMinutes);
        Assert.Empty(gate.Pending);

        // The same zone found again inside the cool-down is not even started.
        (alerts, _) = gate.OnBar("NIFTY", bars, oi, zone with { BarTime = zone.BarTime.AddMinutes(6) });
        Assert.Empty(alerts);
        Assert.Empty(gate.Pending);
    }

    [Fact]
    public void TheGate_DropsAZoneThatFails_AndLetsTheNextOneStart()
    {
        var gate = new DivergenceGate(Options);
        var oi = OiLater(4_080_000);
        gate.OnBar("NIFTY", Fall, oi, Zone());
        var broken = After(Fall, 24495);
        var next = Zone() with { BarTime = broken[^1].Time, Extreme = 24495 };
        var (alerts, dropped) = gate.OnBar("NIFTY", broken, oi, next);
        Assert.Empty(alerts);
        Assert.Single(dropped);
        Assert.Contains("below the low", dropped[0].Reason);
        Assert.Equal(next.BarTime, Assert.Single(gate.Pending).BarTime); // the new one waits now
    }

    [Fact]
    public void WithConfirmMinutesZero_AZoneIsSentTheMomentItIsFound()
    {
        var gate = new DivergenceGate(new DivergenceOptions { ConfirmMinutes = 0 });
        var (alerts, _) = gate.OnBar("NIFTY", Fall, OiLater(4_080_000), Zone());
        Assert.Single(alerts);
        Assert.Equal(0, alerts[0].ConfirmMinutes);
    }

    private static readonly DateTimeOffset Base = new(2026, 10, 7, 11, 30, 0, TimeSpan.FromHours(5.5));

    [Fact]
    public void TheMinuteBook_ReadsTheLastReadingAtOrBeforeAMinute()
    {
        var book = new OiMinuteBook();
        book.Record("NIFTY", "PE", 24500, Base, 100);
        book.Record("NIFTY", "PE", 24500, Base.AddSeconds(30), 110); // same minute: the later one stands
        book.Record("NIFTY", "PE", 24500, Base.AddMinutes(2), 130);
        var m = Minute(Base);

        Assert.Equal(110, book.At("NIFTY", "PE", 24500, m, 5));
        Assert.Equal(110, book.At("NIFTY", "PE", 24500, m + 1, 5));   // carried over a quiet minute
        Assert.Equal(130, book.At("NIFTY", "PE", 24500, m + 2, 5));
        Assert.Null(book.At("NIFTY", "PE", 24500, m - 1, 5));          // nothing before the first reading
        Assert.Null(book.At("NIFTY", "CE", 24500, m, 5));
        Assert.Equal(new[] { 24500m }, book.Strikes("NIFTY"));
    }

    [Fact]
    public void TheMinuteBook_DoesNotCarryAnOldReadingForward()
    {
        var book = new OiMinuteBook();
        book.Record("NIFTY", "PE", 24500, Base, 100);
        Assert.Equal(100, book.At("NIFTY", "PE", 24500, Minute(Base) + 5, 5));
        Assert.Null(book.At("NIFTY", "PE", 24500, Minute(Base) + 6, 5)); // too old to be "the OI now"
    }
}
