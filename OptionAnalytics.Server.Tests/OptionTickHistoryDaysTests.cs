using System.Globalization;
using System.Text;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.TrueData;

namespace OptionAnalytics.Server.Tests;

/// <summary>The big option orders of a PAST day, rebuilt from TrueData's tick history of the option contracts: only the contracts in the day's futures range
/// +- N strikes are asked, the same watch as the live stream reads their ticks in time order, only orders within ATM +- N of the ATM at their time are kept, a
/// failed call is tried once more, and a built day is asked of TrueData once. No network.</summary>
public sealed class OptionTickHistoryDaysTests
{
    private static readonly DateOnly Day = new(2026, 11, 23);
    private static readonly DateOnly Expiry = new(2026, 12, 1);
    private const int Lot = 65;

    private sealed class FakeHistory : ITrueDataHistoryApi
    {
        public readonly List<string> Asked = new();
        public readonly HashSet<string> FlakyOnce = new();
        public readonly HashSet<string> NoData = new();
        private readonly HashSet<string> _failedOnce = new();

        public Task<string> GetTicksWithBidAskAsync(string symbol, DateTime fromIst, DateTime toIst, CancellationToken token)
        {
            lock (Asked) Asked.Add(symbol);
            if (symbol == "NIFTY26NOVFUT") return Task.FromResult(Futures());
            if (NoData.Contains(symbol)) return Task.FromResult("No data exists for the requested symbol");
            if (FlakyOnce.Contains(symbol) && _failedOnce.Add(symbol)) throw new InvalidOperationException("server error");
            return Task.FromResult(Option(symbol));
        }

        private static string Futures()
        {
            var sb = new StringBuilder("timestamp,ltp,volume,oi,bid,bidqty,ask,askqty\n");
            for (var i = 0; i < 30; i++)
                sb.Append(CultureInfo.InvariantCulture, $"2026-11-23T09:{15 + i / 2:00}:{(i % 2) * 30:00},{25950 + i},{65 * (1 + i % 3)},100,{25949.9 + i},100,{25950.1 + i},100\n");
            return sb.ToString();
        }

        /// <summary>Six quiet ticks of one lot, then - on 25950 and 26050 calls - one 40-lot buy at the ask. The call falls and the put rises with the strike, so they
        /// cost the same at 25950: the options' own ATM.</summary>
        private static string Option(string symbol)
        {
            var call = symbol.EndsWith("CE");
            var strike = int.Parse(symbol.Substring("NIFTY261201".Length, 5));
            var price = call ? 100m - (strike - 25950) / 10m : 100m + (strike - 25950) / 10m;
            var sb = new StringBuilder("timestamp,ltp,volume,oi,bid,bidqty,ask,askqty\n");
            for (var i = 0; i < 6; i++)
                sb.Append(CultureInfo.InvariantCulture, $"2026-11-23T09:{20 + i:00}:00,{price},{Lot * (1 + i % 2)},1000,{price - 0.1m},500,{price + 0.1m},500\n");   // 1 and 2 lots: a per-tick quantity (it goes down as well as up)
            if (call && strike is 25950 or 26050)
                sb.Append(CultureInfo.InvariantCulture, $"2026-11-23T09:30:00,{price + 0.1m},{40 * Lot},1400,{price - 0.1m},500,{price + 0.1m},300\n");
            return sb.ToString();
        }
    }

    private sealed class FakeChain : IOptionChainSource
    {
        public int Calls;
        public Task<IReadOnlyList<OptionContract>> GetAsync(string underlying, DateOnly expiry, CancellationToken token)
        {
            Calls++;
            var rows = new List<OptionContract>();
            for (var k = 25000; k <= 27000; k += 50)
            {
                rows.Add(new OptionContract($"{k}1", $"NIFTY261201{k}CE", k, true, Expiry, Lot));
                rows.Add(new OptionContract($"{k}2", $"NIFTY261201{k}PE", k, false, Expiry, Lot));
            }
            return Task.FromResult<IReadOnlyList<OptionContract>>(rows);
        }
    }

    private static (OptionTickHistoryDays days, FakeHistory api, FakeChain chain) Make()
    {
        var api = new FakeHistory();
        var services = new ServiceCollection().AddSingleton<ITrueDataHistoryApi>(api).BuildServiceProvider();
        var futures = new TickHistoryDays(services, NullLogger<TickHistoryDays>.Instance);
        var chain = new FakeChain();
        var days = new OptionTickHistoryDays(services, futures, Options.Create(new TrueDataOptions { UserId = "u", Password = "p" }), NullLogger<OptionTickHistoryDays>.Instance)
        { ChainSource = chain, CallGap = TimeSpan.Zero, RetryGap = TimeSpan.Zero };
        return (days, api, chain);
    }

    private static readonly TrueDataLiveInstrument Nifty = new() { Underlying = "NIFTY", Symbol = "NIFTY-I", LotSize = Lot, TickSize = 0.05m };

    private static async Task<OptionTickHistoryDays.Status> Ready(OptionTickHistoryDays days, int strikes)
    {
        for (var i = 0; i < 400; i++)
        {
            var s = days.Request(Nifty, Day, strikes);
            if (s.State != "loading") return s;
            await Task.Delay(10);
        }
        throw new TimeoutException("the day did not build");
    }

    [Fact]
    public async Task AskedContractsAreTheDaysFuturesRangePlusMinusNStrikes_AndOnlyOrdersWithinTheAtmWindowAtTheirTimeAreKept()
    {
        var (days, api, _) = Make();
        var first = days.Request(Nifty, Day, 1);
        Assert.Equal("loading", first.State);                   // started in the background
        var s = await Ready(days, 1);

        Assert.Equal("ready", s.State);
        Assert.Equal("2026-12-01", s.Expiry);
        Assert.Equal(50m, s.Step);
        // Futures 25950 - 25979: strikes 25900 - 26050 are asked (ATM - 1 below the low, + 1 above the high), calls and puts.
        var options = api.Asked.Where(x => x != "NIFTY26NOVFUT").Distinct().OrderBy(x => x).ToList();
        Assert.Equal(8, s.Total);
        Assert.Equal(8, options.Count);
        Assert.Contains("NIFTY26120125900CE", options);
        Assert.Contains("NIFTY26120126050PE", options);
        Assert.DoesNotContain("NIFTY26120125850CE", options);
        Assert.DoesNotContain("NIFTY26120126100CE", options);
        // The ATM-strike 40-lot buy is kept; the one at 26050 is 2 strikes from the ATM (25950): outside ATM +- 1, left out.
        var e = Assert.Single(s.Events);
        Assert.Equal(25950m, e.Strike);
        Assert.Equal("CE", e.Type);
        Assert.True(e.Buy);
        Assert.Equal(40m, e.Lots);
        Assert.Equal(0, e.AtmDistance);
        Assert.Equal(400, e.OiChange);                          // OI 1000 -> 1400
        Assert.Equal(new DateTimeOffset(2026, 11, 23, 9, 30, 0, TimeSpan.FromMinutes(330)), e.Time);
        // With a wider window both are kept.
        var wide = await Ready(days, 3);
        Assert.Equal(new[] { 25950m, 26050m }, wide.Events.Select(x => x.Strike).OrderBy(x => x));
    }

    [Fact]
    public async Task ABuiltDayIsAskedOfTrueDataOnce_AFailedCallIsTriedAgain_AndAContractWithNoDataIsCounted()
    {
        var (days, api, chain) = Make();
        api.FlakyOnce.Add("NIFTY26120125950CE");                // a server error that works the second time
        api.NoData.Add("NIFTY26120126050PE");                   // nothing for this contract
        var s = await Ready(days, 1);
        Assert.Equal("ready", s.State);
        Assert.Equal(1, s.Failed);
        Assert.Single(s.Events);                                // the flaky contract's order is there
        Assert.Equal(2, api.Asked.Count(x => x == "NIFTY26120125950CE"));

        var calls = api.Asked.Count;
        var chainCalls = chain.Calls;
        var again = days.Request(Nifty, Day, 1);
        Assert.Equal("ready", again.State);
        Assert.Equal(calls, api.Asked.Count);                   // nothing asked again
        Assert.Equal(chainCalls, chain.Calls);
    }

    [Fact]
    public async Task ADayTrueDataCannotAnswerFails_WithWhy_AndWithoutTheHistorySourceItSaysSo()
    {
        var (days, api, _) = Make();
        // The futures day has no ticks: nothing to centre the strikes on.
        var broken = new ServiceCollection().AddSingleton<ITrueDataHistoryApi>(new EmptyHistory()).BuildServiceProvider();
        var d = new OptionTickHistoryDays(broken, new TickHistoryDays(broken, NullLogger<TickHistoryDays>.Instance) { RetryGap = TimeSpan.Zero },
            Options.Create(new TrueDataOptions()), NullLogger<OptionTickHistoryDays>.Instance) { ChainSource = new FakeChain(), CallGap = TimeSpan.Zero, RetryGap = TimeSpan.Zero };
        for (var i = 0; i < 400; i++) { var s = d.Request(Nifty, Day, 5); if (s.State == "failed") { Assert.False(string.IsNullOrWhiteSpace(s.Error)); break; } await Task.Delay(10); }
        Assert.Equal("failed", d.Request(Nifty, Day, 5).State);

        var none = new OptionTickHistoryDays(new ServiceCollection().BuildServiceProvider(), new TickHistoryDays(new ServiceCollection().BuildServiceProvider(), NullLogger<TickHistoryDays>.Instance),
            Options.Create(new TrueDataOptions()), NullLogger<OptionTickHistoryDays>.Instance);
        Assert.False(none.Available);
        Assert.Contains("TrueData:Enabled", none.Request(Nifty, Day, 5).Error);
        Assert.Empty(api.Asked);
    }

    [Fact]
    public async Task APastNiftyDayBuiltOnceIsKeptOnDisk_AndReadBackWithNoTrueDataCall_NeverToday_NeverBankNifty()
    {
        var root = Path.Combine(Path.GetTempPath(), "tickdays-" + Guid.NewGuid().ToString("N"));
        try
        {
            var disk = new TickDayDiskCache(root, NullLogger<TickDayDiskCache>.Instance);
            var api = new FakeHistory();
            var services = new ServiceCollection().AddSingleton<ITrueDataHistoryApi>(api).AddSingleton(disk).BuildServiceProvider();
            var futures = new TickHistoryDays(services, NullLogger<TickHistoryDays>.Instance);
            var opts = Options.Create(new TrueDataOptions { UserId = "u", Password = "p" });
            var first = new OptionTickHistoryDays(services, futures, opts, NullLogger<OptionTickHistoryDays>.Instance) { ChainSource = new FakeChain(), CallGap = TimeSpan.Zero, RetryGap = TimeSpan.Zero };
            var built = await Ready(first, 1);
            Assert.Equal("ready", built.State);
            Assert.True(File.Exists(disk.FileOf("options", "NIFTY", Day)));

            // A fresh service (a restart) with a history that answers nothing: the day comes from the disk.
            var offline = new ServiceCollection().AddSingleton<ITrueDataHistoryApi>(new EmptyHistory()).AddSingleton(disk).BuildServiceProvider();
            var second = new OptionTickHistoryDays(offline, new TickHistoryDays(offline, NullLogger<TickHistoryDays>.Instance), opts, NullLogger<OptionTickHistoryDays>.Instance);
            var again = second.Request(Nifty, Day, 1);
            Assert.Equal("ready", again.State);
            Assert.Equal(built.Events.Count, again.Events.Count);

            Assert.False(disk.Write("options", "NIFTY", IstClock.Today(), new OptionTickHistoryDays.Saved(1, null, 50, new())));
            Assert.False(disk.Write("options", "BANKNIFTY", Day, new OptionTickHistoryDays.Saved(1, null, 100, new())));
        }
        finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
    }

    private sealed class EmptyHistory : ITrueDataHistoryApi
    {
        public Task<string> GetTicksWithBidAskAsync(string symbol, DateTime fromIst, DateTime toIst, CancellationToken token) => Task.FromResult("No data exists for the requested symbol");
    }
}
