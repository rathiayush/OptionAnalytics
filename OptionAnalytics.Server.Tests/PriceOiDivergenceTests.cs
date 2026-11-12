using Microsoft.Extensions.Configuration;
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

    // ---- The 15-minute read (asked for - "only send signal for 15 min divergence") ----

    private static List<Candle> Minutes(DateTimeOffset first, params decimal[] closes) =>
        closes.Select((c, i) => new Candle(first.AddMinutes(i), c, c + 1, c - 1, c)).ToList();

    [Fact]
    public void SessionCandles_AreTheCompletedFifteenMinuteCandlesOfTheDay()
    {
        // Yesterday's last minute, then 10:00 - 10:45 today: 10:00, 10:15 and 10:30 are complete; 10:45 is forming.
        var bars = new List<Candle> { new(At(15, 29).AddDays(-1), 1, 1, 1, 1) };
        bars.AddRange(Minutes(At(10, 0), Enumerable.Range(0, 46).Select(i => 24500m + i).ToArray()));
        var candles = PriceOiDivergenceDetector.SessionCandles(bars, 15);
        Assert.Equal(new[] { At(10, 0), At(10, 15), At(10, 30) }, candles.Select(c => c.Time));
        Assert.Equal((24500m, 24515m, 24499m, 24514m), (candles[0].Open, candles[0].High, candles[0].Low, candles[0].Close));
        Assert.Equal(24544m, candles[2].Close);
        // A minute missing inside a candle still makes it; its last minute missing does not.
        var gap = bars.Where(b => b.Time != At(10, 7) && b.Time != At(10, 29)).ToList();
        Assert.Equal(new[] { At(10, 0), At(10, 30) }, PriceOiDivergenceDetector.SessionCandles(gap, 15).Select(c => c.Time));
    }

    [Fact]
    public void TheFifteenMinuteRead_TakesTheOiAtEachCandlesEnd()
    {
        var o = DivergenceOptions.FifteenMinuteDefaults();
        // 10:00 candle closes 24560, the 10:15 one 24500: down 0.24%.
        var candles = new List<Candle> { new(At(10, 0), 24570, 24575, 24550, 24560), new(At(10, 15), 24560, 24565, 24495, 24500) };
        var before = Minute(At(10, 14));
        var end = Minute(At(10, 29));
        // OI only at the two candles' last minutes - read anywhere else and there is no alert.
        var oi = new Dictionary<(string, decimal), (long, long)>
        {
            [("PE", 24500)] = (4_000_000, 4_060_000), [("PE", 24450)] = (3_000_000, 3_010_000), [("PE", 24550)] = (2_000_000, 2_020_000),
            [("CE", 24500)] = (3_500_000, 3_520_000), [("CE", 24550)] = (3_000_000, 3_005_000),
        };
        long? Reader(string side, decimal strike, long minute) =>
            oi.TryGetValue((side, strike), out var v) ? minute == before ? v.Item1 : minute == end ? v.Item2 : null : null;
        var found = PriceOiDivergenceDetector.Evaluate("NIFTY", candles, 50, oi.Keys.Select(k => k.Item2).Distinct(), Reader, o);
        Assert.NotNull(found);
        Assert.Equal(("Discount", "PE", 24500m, 4_000_000L, 4_060_000L, 15), (found!.Zone, found.Side, found.Strike, found.OiBefore, found.OiNow, found.Minutes));
        Assert.Contains("in 15 min to 24500", found.Message);
        // Not on 1-minute bars with these settings; not on a move under its 0.10%.
        Assert.Null(PriceOiDivergenceDetector.Evaluate("NIFTY", [new(At(10, 0), 1, 1, 1, 24520), new(At(10, 15), 1, 1, 1, 24500)], 50, oi.Keys.Select(k => k.Item2).Distinct(), Reader, o));
        Assert.Null(PriceOiDivergenceDetector.Evaluate("NIFTY", [new(At(10, 0), 1, 1, 1, 24560), new(At(10, 1), 1, 1, 1, 24500)], 50, oi.Keys.Select(k => k.Item2).Distinct(), Reader, o));
    }

    [Fact]
    public void OnlyTheFifteenMinuteReadGoesToTelegram()
    {
        Assert.False(new DivergenceOptions().Telegram);                          // the 1-minute read: the app's popup only
        var defaults = OiDivergenceMonitor.FifteenMinuteOptions(null);
        Assert.Equal((15, 1, 0.10m, true, 30), (defaults.BarMinutes, defaults.Minutes, defaults.MinMovePct, defaults.Telegram, defaults.CooldownMinutes));
        // The "OiDivergence15m" section binds over the defaults - what it leaves out stays.
        var config = new Microsoft.Extensions.Configuration.ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["OiDivergence15m:MinMovePct"] = "0.2", ["OiDivergence15m:Telegram"] = "false" }).Build();
        var bound = OiDivergenceMonitor.FifteenMinuteOptions(config);
        Assert.Equal((15, 0.2m, false), (bound.BarMinutes, bound.MinMovePct, bound.Telegram));
        // As deployed: appsettings.json keeps the 1-minute read off Telegram and the 15-minute one on.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "OptionAnalytics.Server", "appsettings.json"))) dir = dir.Parent;
        var settings = new Microsoft.Extensions.Configuration.ConfigurationBuilder().AddJsonFile(Path.Combine(dir!.FullName, "OptionAnalytics.Server", "appsettings.json")).Build();
        Assert.False(settings.GetSection("OiDivergence").Get<DivergenceOptions>()!.Telegram);
        var deployed = OiDivergenceMonitor.FifteenMinuteOptions(settings);
        Assert.Equal((15, 1, true), (deployed.BarMinutes, deployed.Minutes, deployed.Telegram));
        // The text names its candles; a 15-minute candle completes at its last minute.
        var found = new PriceOiDivergence("NIFTY", At(10, 15), "Discount", "PE", 24500, 1, 2, 1, 24560, 24500, -0.24m, 15, "NIFTY spot fell 60 pts");
        Assert.Equal("[OI divergence 15m] <b>NIFTY</b> DISCOUNT zone\nNIFTY spot fell 60 pts", OiDivergenceMonitor.TelegramText(found, 15));
        Assert.True(OiDivergenceMonitor.CompletesCandle(At(10, 14), 15));
        Assert.True(OiDivergenceMonitor.CompletesCandle(At(9, 29), 15));
        Assert.False(OiDivergenceMonitor.CompletesCandle(At(10, 15), 15));
        Assert.False(OiDivergenceMonitor.CompletesCandle(At(9, 14), 15));
    }
}
