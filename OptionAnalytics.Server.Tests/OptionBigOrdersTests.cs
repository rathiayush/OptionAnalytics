using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.TrueData;

namespace OptionAnalytics.Server.Tests;

/// <summary>Big option orders from TrueData's live ticks: the chain CSV, one option's ticks (side from the quote before, bundled trades, the touch it
/// hit, OI, its own usual), the ATM from the options themselves, and the feed keeping ATM +- N subscribed within the symbol cap. No network.</summary>
public sealed class OptionBigOrdersTests
{
    private static readonly TimeSpan Ist = TimeSpan.FromMinutes(330);
    private static readonly DateTimeOffset T0 = new(2026, 11, 24, 10, 0, 0, Ist);
    private static readonly DateOnly Expiry = new(2026, 12, 1);
    private const int Lot = 65;

    private static OptionContract Ce(decimal strike) => new($"{(long)strike}1", $"NIFTY261201{strike}CE", strike, true, Expiry, Lot);
    private static OptionContract Pe(decimal strike) => new($"{(long)strike}2", $"NIFTY261201{strike}PE", strike, false, Expiry, Lot);

    private static TrueDataTrade Tick(OptionContract c, int sec, decimal price, long qty, long ttq, decimal bid, long bidQty, decimal ask, long askQty, long oi = 0, long seq = 0) =>
        new(c.SymbolId, T0.AddSeconds(sec), price, qty, price, ttq, 0, 0, 0, 0, oi, "", seq, bid, bidQty, ask, askQty);

    /// <summary>Six quiet ticks of one lot each, the quote 100 x 100.5, so the option has its own usual.</summary>
    private static (OptionBigOrderWatch w, OptionContract c, long ttq) Warm()
    {
        var w = new OptionBigOrderWatch { FloorLots = 10, FloorRatio = 2, Atm = 25000, Step = 50 };
        var c = Ce(25000);
        w.Track(c);
        long ttq = 0;
        for (var i = 0; i < 6; i++) { ttq += Lot; w.OnTrade(Tick(c, i, 100.25m, Lot, ttq, 100m, 500, 100.5m, 500, 1000), T0.AddSeconds(i)); }
        return (w, c, ttq);
    }

    [Fact]
    public void TheChainCsvIsParsed_AndAnAnswerWithNoRowsIsEmpty()
    {
        var csv = "symbolid,symbol,series,isin,exchange,lotsize,strike,expiry,metastocksymbol,symbolalias\r\n"
            + "303048142,NIFTY26120117350CE,CE,,NSE,65,17350,01-12-2026,NIFTY26L617350,NIFTY26120117350CE\r\n"
            + "303048143,NIFTY26120117350PE,PE,,NSE,65,17350,01-12-2026,NIFTY26X617350,NIFTY26120117350PE\r\n"
            + "303049999,NIFTY26NOVFUT,XX,,NSE,65,0,23-11-2026,X,Y\r\n";
        var rows = TrueDataOptionChainSource.ParseCsv(csv);
        Assert.Equal(2, rows.Count);                                   // the futures row (series XX) is not an option
        Assert.Equal(new OptionContract("303048142", "NIFTY26120117350CE", 17350m, true, new DateOnly(2026, 12, 1), 65), rows[0]);
        Assert.False(rows[1].Call);
        // What getOptionChain really answers: no header row at all (as the trial account sent it).
        var headerless = TrueDataOptionChainSource.ParseCsv("303048142,NIFTY26120117350CE,CE,,NSE,65,17350,01-12-2026,NIFTY26L617350,NIFTY26120117350CE\r\n303048143,NIFTY26120117350PE,PE,,NSE,65,17350,01-12-2026,NIFTY26X617350,NIFTY26120117350PE\r\n");
        Assert.Equal(rows, headerless);
        Assert.Empty(TrueDataOptionChainSource.ParseCsv("{\"status\":\"No Record found\",\"Records\":\"\"}"));
        Assert.Empty(TrueDataOptionChainSource.ParseCsv(""));
    }

    [Fact]
    public void ABigBuyAtTheAskIsOneOrder_WithItsSideTouchAndMultiple()
    {
        var (w, c, ttq) = Warm();
        // 40 lots at the ask 100.5 after a 500-unit touch: bought, ate the whole touch (and more), 40x its usual one lot.
        var e = w.OnTrade(Tick(c, 10, 100.5m, 40 * Lot, ttq + 40 * Lot, 100m, 500, 100.5m, 300, 1500), T0.AddSeconds(10))!;
        Assert.True(e.Buy);
        Assert.Equal(40m, e.Lots);
        Assert.Equal(2600, e.Qty);
        Assert.Equal(40m, e.Ratio);
        Assert.Equal(2600m / 500, e.TouchRatio);        // the 500 shown at the ask BEFORE the tick
        Assert.False(e.Through);                         // at the ask, not past it
        Assert.Equal(500, e.OiChange);                   // OI 1000 -> 1500
        Assert.Equal("CE", e.Type);
        Assert.Equal(0, e.AtmDistance);
        Assert.Equal(100.5m * 2600, e.Value);
    }

    [Fact]
    public void ASellAtTheBidAndASweepThroughTheTouch()
    {
        var (w, c, ttq) = Warm();
        var sell = w.OnTrade(Tick(c, 10, 100m, 30 * Lot, ttq + 30 * Lot, 100m, 500, 100.5m, 500), T0.AddSeconds(10))!;
        Assert.False(sell.Buy);
        Assert.False(sell.Through);
        // The packet's own quote is the one after the trade; the next tick is sided by it. A buy PAST the ask is a sweep.
        var sweep = w.OnTrade(Tick(c, 11, 101m, 25 * Lot, ttq + 55 * Lot, 100.5m, 400, 101.5m, 400), T0.AddSeconds(11))!;
        Assert.True(sweep.Buy);
        Assert.True(sweep.Through);                      // 101 against the ask 100.5 of the quote before
        Assert.True(sweep.MovePct > 0);
    }

    [Fact]
    public void TradesBundledInOneSnapshotAreTakenAsTheRiseOfTheDaysVolume()
    {
        var (w, c, ttq) = Warm();
        // The tick's own last trade is one lot, but the day's volume rose 30 lots since the tick before: 30 lots traded in that second.
        var e = w.OnTrade(Tick(c, 10, 100.5m, Lot, ttq + 30 * Lot, 100m, 500, 100.5m, 500), T0.AddSeconds(10))!;
        Assert.True(e.Bundled);
        Assert.Equal(30m, e.Lots);
        // A tick whose volume rise is just its own last trade is not bundled.
        var plain = w.OnTrade(Tick(c, 11, 100.5m, 20 * Lot, ttq + 50 * Lot, 100m, 500, 100.5m, 500), T0.AddSeconds(11))!;
        Assert.False(plain.Bundled);
    }

    [Fact]
    public void SmallOrdersAreNotKept_ANoDataQuantityOneIsNoTrade_AndTheFloorFollowsTheOptionsOwnUsual()
    {
        var (w, c, ttq) = Warm();
        Assert.Null(w.OnTrade(Tick(c, 10, 100.5m, 5 * Lot, ttq + 5 * Lot, 100m, 500, 100.5m, 500), T0.AddSeconds(10)));   // 5 lots < the 10-lot floor
        Assert.Null(w.OnTrade(Tick(c, 11, 120m, 1, ttq + 5 * Lot + 1, 100m, 500, 100.5m, 500), T0.AddSeconds(11)));      // TrueData's day-high update
        // A busy option: its usual is 30 lots, so 40 lots is only 1.3x - under the 2x floor, not big.
        var busy = new OptionBigOrderWatch { FloorLots = 10, FloorRatio = 2 };
        var b = Ce(25050);
        busy.Track(b);
        long t = 0;
        for (var i = 0; i < 8; i++) { t += 30 * Lot; busy.OnTrade(Tick(b, i, 50m, 30 * Lot, t, 49.9m, 100, 50.1m, 100), T0.AddSeconds(i)); }
        Assert.Null(busy.OnTrade(Tick(b, 9, 50.1m, 40 * Lot, t + 40 * Lot, 49.9m, 100, 50.1m, 100), T0.AddSeconds(9)));
        Assert.NotNull(busy.OnTrade(Tick(b, 10, 50.1m, 90 * Lot, t + 130 * Lot, 49.9m, 100, 50.1m, 100), T0.AddSeconds(10)));   // 3x
        // An option with no history yet: the lot floor alone (the first minutes of the day).
        var fresh = new OptionBigOrderWatch { FloorLots = 10 };
        var f = Ce(25100);
        fresh.Track(f);
        Assert.NotNull(fresh.OnTrade(Tick(f, 0, 10m, 50 * Lot, 50 * Lot, 9.9m, 100, 10.1m, 100), T0));
    }

    [Fact]
    public void EventsComeBackAfterASequence_AndANewDayStartsEmpty()
    {
        var (w, c, ttq) = Warm();
        var a = w.OnTrade(Tick(c, 10, 100.5m, 30 * Lot, ttq + 30 * Lot, 100m, 500, 100.5m, 500), T0.AddSeconds(10))!;
        var b = w.OnTrade(Tick(c, 11, 100m, 40 * Lot, ttq + 70 * Lot, 100m, 500, 100.5m, 500), T0.AddSeconds(11))!;
        Assert.Equal(new[] { a.Seq, b.Seq }, w.Since(0).Select(e => e.Seq));
        Assert.Equal(new[] { b.Seq }, w.Since(a.Seq).Select(e => e.Seq));
        Assert.Empty(w.Since(b.Seq));
        // The next IST day: yesterday's orders and usual are gone.
        var next = Tick(c, 0, 100.5m, 40 * Lot, 40 * Lot, 100m, 500, 100.5m, 500);
        var n = w.OnTrade(next with { Time = T0.AddDays(1) }, T0.AddDays(1));
        Assert.NotNull(n);
        Assert.Single(w.Since(0));
    }

    [Fact]
    public void TheAtmIsTheStrikeWhereTheCallAndThePutCostTheSame_WithTheForwardItImplies()
    {
        var w = new OptionBigOrderWatch();
        foreach (var k in new[] { 24950m, 25000m, 25050m }) { w.Track(Ce(k)); w.Track(Pe(k)); }
        void Tick1(OptionContract c, decimal p) => w.OnTrade(Tick(c, 0, p, Lot, Lot, p - 0.1m, 100, p + 0.1m, 100), T0);
        Tick1(Ce(24950), 140); Tick1(Pe(24950), 60);
        Tick1(Ce(25000), 112); Tick1(Pe(25000), 108);
        Tick1(Ce(25050), 80); Tick1(Pe(25050), 135);
        var atm = w.ImpliedAtm(T0.AddSeconds(30))!.Value;
        Assert.Equal(25000m, atm.Strike);
        Assert.Equal(25004m, atm.Forward);                // 25000 + 112 - 108
        Assert.Null(w.ImpliedAtm(T0.AddMinutes(5)));      // nothing ticked lately
    }

    // ---- the feed keeping ATM +- N subscribed ----

    private sealed class FakeChain : IOptionChainSource
    {
        public int Calls;
        public Task<IReadOnlyList<OptionContract>> GetAsync(string underlying, DateOnly expiry, CancellationToken token)
        {
            Calls++;
            var rows = new List<OptionContract>();
            for (var k = 24000m; k <= 26000m; k += 50) { rows.Add(Ce(k)); rows.Add(Pe(k)); }
            return Task.FromResult<IReadOnlyList<OptionContract>>(rows);
        }
    }

    private static (TrueDataLiveFeed feed, List<string> sent) Feed(int maxSymbols = 50, string? statePath = null)
    {
        var feed = new TrueDataLiveFeed(Options.Create(new TrueDataOptions
        {
            Enabled = true, UserId = "u", Password = "p",
            Live = new TrueDataLiveOptions
            {
                Enabled = true, MaxSymbols = maxSymbols, OptionsUnderlying = "NIFTY", OptionStrikes = 10, StatePath = statePath ?? "",
                Instruments = new() { new() { Underlying = "NIFTY", Symbol = "NIFTY-I", LotSize = 65, TickSize = 0.05m } },
            },
        }), NullLogger<TrueDataLiveFeed>.Instance) { Clock = () => T0, ChainSource = new FakeChain() };
        var sent = new List<string>();
        feed.UseConnection(json => { sent.Add(json); return Task.CompletedTask; });
        return (feed, sent);
    }

    private static void FuturesAt(TrueDataLiveFeed feed, decimal price) =>
        feed.BookFor("NIFTY")!.OnTrade(T0, 1, price, 65, price - 0.05m, 100, price, 100);

    [Fact]
    public async Task WithTheOptionTicksFlagOff_NoOptionIsSubscribed_AndThePickIsRefused()
    {
        var feed = new TrueDataLiveFeed(Options.Create(new TrueDataOptions
        {
            Enabled = true, UserId = "u", Password = "p",
            Live = new TrueDataLiveOptions
            {
                Enabled = true, OptionTicks = false, OptionsUnderlying = "NIFTY",
                Instruments = new() { new() { Underlying = "NIFTY", Symbol = "NIFTY-I", LotSize = 65, TickSize = 0.05m } },
            },
        }), NullLogger<TrueDataLiveFeed>.Instance) { Clock = () => T0, ChainSource = new FakeChain() };
        var sent = new List<string>();
        feed.UseConnection(json => { sent.Add(json); return Task.CompletedTask; });
        FuturesAt(feed, 25000m);
        await feed.SyncOptionsAsync(T0, CancellationToken.None);
        Assert.Empty(sent);
        Assert.False(feed.OptionTicksOn);
        Assert.Equal("", feed.OptionsSnapshot().Underlying);
        Assert.False(feed.SetOptions("NIFTY", 10));
    }

    [Fact]
    public async Task TheFeedSubscribesAtmPlusMinusTenOfTheIndexPicked_AndFollowsTheAtmWithinTheCap()
    {
        var (feed, sent) = Feed();
        await feed.SyncOptionsAsync(T0, CancellationToken.None);
        Assert.Empty(sent);                                  // no futures price yet: nothing to centre on
        FuturesAt(feed, 25004m);
        await feed.SyncOptionsAsync(T0, CancellationToken.None);

        var first = Assert.Single(sent);
        Assert.Contains("addsymbol", first);
        Assert.Equal(42, feed.OptionsSnapshot().Subscribed);   // 21 strikes x CE / PE
        Assert.Equal(25000m, feed.OptionsSnapshot().Atm);
        Assert.Equal("2026-12-01", feed.OptionsSnapshot().Expiry);   // the contracts' own expiry (the fake answers the first day asked, a Tuesday, with the 1 Dec chain)
        Assert.Contains("NIFTY26120124500CE", first);   // ATM - 10 steps
        Assert.DoesNotContain("NIFTY26120124450CE", first);

        // Spot moves 4 steps up: the new edge is added, strikes more than 12 steps back are dropped.
        sent.Clear();
        FuturesAt(feed, 25204m);
        await feed.SyncOptionsAsync(T0, CancellationToken.None);
        Assert.Contains(sent, j => j.Contains("removesymbol"));
        Assert.Contains(sent, j => j.Contains("addsymbol") && j.Contains("NIFTY26120125700CE"));
        Assert.Equal(25200m, feed.OptionsSnapshot().Atm);
        // Nothing changes while spot sits: no more messages.
        sent.Clear();
        await feed.SyncOptionsAsync(T0, CancellationToken.None);
        Assert.Empty(sent);
    }

    [Fact]
    public async Task ANewConnectionSubscribesEverythingAgain_TheCapIsHeld_AndNoIndexMeansNone()
    {
        var (feed, sent) = Feed(maxSymbols: 20);              // 1 futures + 19 options
        FuturesAt(feed, 25000m);
        await feed.SyncOptionsAsync(T0, CancellationToken.None);
        Assert.Equal(19, feed.OptionsSnapshot().Subscribed);   // nearest the ATM first
        Assert.Equal(19, feed.OptionsSnapshot().Cap);

        var again = new List<string>();
        feed.UseConnection(json => { again.Add(json); return Task.CompletedTask; });
        await feed.SyncOptionsAsync(T0, CancellationToken.None);
        Assert.Contains(again, j => j.Contains("addsymbol"));  // a fresh login has only the futures

        // None picked: what was subscribed is removed.
        Assert.True(feed.SetOptions("", 10));
        again.Clear();
        await feed.SyncOptionsAsync(T0, CancellationToken.None);
        Assert.Contains(again, j => j.Contains("removesymbol"));
        Assert.Equal(0, feed.OptionsSnapshot().Subscribed);
        Assert.False(feed.SetOptions("SENSEX", 10));
    }

    [Fact]
    public async Task AnOptionsTickGoesToTheWatch_NotTheFuturesBook()
    {
        var (feed, _) = Feed();
        FuturesAt(feed, 25000m);
        await feed.SyncOptionsAsync(T0, CancellationToken.None);
        var c = Ce(25000);
        long ttq = 0;
        for (var i = 0; i < 6; i++) { ttq += Lot; feed.OnTrade(Tick(c, i, 100.25m, Lot, ttq, 100m, 500, 100.5m, 500, 1000)); }
        feed.OnTrade(Tick(c, 10, 100.5m, 40 * Lot, ttq + 40 * Lot, 100m, 500, 100.5m, 300, 1200));
        var e = Assert.Single(feed.Watch.Since(0));
        Assert.Equal(40m, e.Lots);
        Assert.Equal(1, feed.BookFor("NIFTY")!.Meta().Prints);   // only the futures' own print is in the futures book
    }

    [Fact]
    public void TheOptionChoiceIsKeptAcrossARestart()
    {
        var folder = Path.Combine(Path.GetTempPath(), "tick-flow-options-" + Guid.NewGuid().ToString("N"));
        try
        {
            var (feed, _) = Feed(statePath: folder);
            Assert.True(feed.SetOptions("", 7));
            var (restarted, _) = Feed(statePath: folder);
            Assert.Equal("", restarted.OptionsSnapshot().Underlying);   // the page's choice (none), not the configured NIFTY
            Assert.Equal(7, restarted.OptionsSnapshot().Strikes);
        }
        finally { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
    }

    [Fact]
    public void WithNoChoiceMadeItIsNiftyAlone_BothIndicesOptionsDoNotFitUnderFiftySymbols()
    {
        var options = new TrueDataLiveOptions();
        Assert.Equal("NIFTY", options.OptionsUnderlying);
        // The two futures + 42 options of one index = 44 under 50; both indices' options would be 2 + 84.
        Assert.True(2 + 42 <= options.MaxSymbols);
        Assert.True(2 + 84 > options.MaxSymbols);
        var feed = new TrueDataLiveFeed(Options.Create(new TrueDataOptions
        {
            Enabled = true, UserId = "u", Password = "p",
            Live = new TrueDataLiveOptions
            {
                Enabled = true,
                Instruments = new() { new() { Underlying = "NIFTY", Symbol = "NIFTY-I", LotSize = 65 }, new() { Underlying = "BANKNIFTY", Symbol = "BANKNIFTY-I", LotSize = 30 } },
            },
        }), NullLogger<TrueDataLiveFeed>.Instance);
        Assert.Equal("NIFTY", feed.OptionsSnapshot().Underlying);
    }
}
