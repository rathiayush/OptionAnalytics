using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.TrueData;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// TrueData history (TrueData:Enabled): the tick CSV TrueData returns, and an Order Flow day rebuilt from
/// it through OrderFlowEngine - trades classified against the bid / ask BEFORE them. No network: the
/// SDK sits behind ITrueDataHistoryApi.
/// </summary>
public sealed class TrueDataTests
{
    private static readonly DateOnly Day = new(2026, 10, 1);
    private static readonly DhanFuturesInstrument Contract = new(52175, "NIFTY-Oct2026-FUT", "NIFTY", new DateOnly(2026, 10, 27), "NSE_FNO", 75, 0.10m);

    private const string Header = "timestamp,ltp,volume,oi,bid,bid_qty,ask,ask_qty";

    [Fact]
    public void ParsesTicksWithBidAsk_AndKeepsACumulativeVolumeAsIs()
    {
        var csv = $"{Header}\n2026-10-01T09:15:01,25100,750,1000000,25099.9,150,25100,75\n2026-10-01T09:15:02,25100.1,825,1000000,25100,75,25100.1,150\n";

        var r = TrueDataTickCsv.Parse(csv);

        Assert.Null(r.Error);
        Assert.False(r.VolumeWasPerTick);
        Assert.Equal(2, r.Ticks.Count);
        Assert.Equal(825, r.Ticks[1].Volume);
        Assert.Equal(25100m, r.Ticks[1].Bid);
        Assert.Equal(25100.1m, r.Ticks[1].Ask);
        Assert.Equal(new DateTimeOffset(2026, 10, 1, 9, 15, 2, TimeSpan.FromMinutes(330)), r.Ticks[1].Time);
    }

    [Fact]
    public void APerTickVolumeColumn_IsTurnedIntoTheDaysRunningTotal()
    {
        // The volume going down between ticks = each row's own quantity, not a running total.
        var csv = $"{Header}\n2026-10-01T09:15:01,25100,150,0,25099.9,1,25100,1\n2026-10-01T09:15:02,25100.1,75,0,25100,1,25100.1,1\n2026-10-01T09:15:03,25100.1,0,0,25100,1,25100.2,1\n";

        var r = TrueDataTickCsv.Parse(csv);

        Assert.True(r.VolumeWasPerTick);
        Assert.Equal(new long[] { 150, 225, 225 }, r.Ticks.Select(t => t.Volume).ToArray());
    }

    [Theory]
    [InlineData("No data exists for this symbol")]
    [InlineData("Symbol does not exist")]
    [InlineData("")]
    public void ANonCsvReply_IsAnError_WithNoTicks(string reply)
    {
        var r = TrueDataTickCsv.Parse(reply);
        Assert.Empty(r.Ticks);
        Assert.NotNull(r.Error);
    }

    [Fact]
    public void TicksWithoutBidAskColumns_StillParse_WithNoQuote()
    {
        var r = TrueDataTickCsv.Parse("timestamp,ltp,volume,oi\n2026-10-01 09:15:01,25100,75,0\n");
        Assert.Single(r.Ticks);
        Assert.Equal(0m, r.Ticks[0].Bid);
    }

    [Fact]
    public void AContractsSymbol_IsUnderlyingYearMonthFut()
    {
        Assert.Equal("NIFTY26OCTFUT", TrueDataOrderFlowSource.ContractSymbol(Contract, new TrueDataOptions().FuturesSymbolFormat));
    }

    [Fact]
    public void ARebuiltDay_ClassifiesEachTradeAgainstTheQuoteBeforeIt()
    {
        var t0 = new DateTimeOffset(2026, 10, 1, 10, 0, 0, TimeSpan.FromMinutes(330));
        var ticks = new List<TrueDataTick>
        {
            new(t0, 25100.0m, 1000, 0, 25099.9m, 150, 25100.0m, 150),
            // 75 traded at the ask that was showing -> a buy (the quote moved up after it).
            new(t0.AddSeconds(1), 25100.0m, 1075, 0, 25100.0m, 75, 25100.1m, 150),
            // 150 traded at the bid that was showing -> a sell.
            new(t0.AddSeconds(2), 25100.0m, 1225, 0, 25099.9m, 75, 25100.1m, 75),
            // A quote change only - no trade.
            new(t0.AddSeconds(3), 25100.0m, 1225, 0, 25100.0m, 75, 25100.1m, 75),
        };

        var engine = TrueDataOrderFlowSource.Build(Contract, ticks);
        var snap = engine.Snapshot(1m, 1, 10);

        var bar = Assert.Single(snap.Bars);
        Assert.Equal(75, bar.Buy);
        Assert.Equal(150, bar.Sell);
        Assert.Equal(2, snap.Trades.Count);
        Assert.True(snap.Trades[0].Buy);
        Assert.False(snap.Trades[1].Buy);
    }

    [Fact]
    public async Task ADay_IsFetchedOnce_AndTheContinuousSymbolIsTriedWhenTheContractHasNoData()
    {
        var api = new FakeApi();
        api.Replies["NIFTY26OCTFUT"] = "No data exists for NIFTY26OCTFUT";
        api.Replies["NIFTY-I"] = $"{Header}\n2026-10-01T09:15:01,25100,0,0,25099.9,1,25100,1\n2026-10-01T09:15:02,25100,75,0,25099.9,1,25100,1\n2026-10-01T09:15:03,25100.1,150,0,25100,1,25100.1,1\n";
        var source = Source(api);

        var first = await source.DayAsync(Contract, Day, frontMonth: true, CancellationToken.None);
        var second = await source.DayAsync(Contract, Day, frontMonth: true, CancellationToken.None);

        Assert.NotNull(first.Engine);
        Assert.Equal("NIFTY-I", first.Symbol);
        Assert.Same(first.Engine, second.Engine);
        Assert.Equal(new[] { "NIFTY26OCTFUT", "NIFTY-I" }, api.Calls); // the second load came from memory
        Assert.Same(first.Engine, source.Cached(Contract.SecurityId, Day));
    }

    [Fact]
    public async Task ANonFrontMonthContract_IsNotSwappedForTheContinuousSymbol()
    {
        var api = new FakeApi();
        api.Replies["NIFTY26OCTFUT"] = "No data exists for NIFTY26OCTFUT";
        var source = Source(api);

        var result = await source.DayAsync(Contract, Day, frontMonth: false, CancellationToken.None);

        Assert.Null(result.Engine);
        Assert.Contains("No data exists", result.Error);
        Assert.Equal(new[] { "NIFTY26OCTFUT" }, api.Calls);
    }

    [Fact]
    public void Disabled_OrWithoutCredentials_OrTooOld_CoversNothing()
    {
        var today = new DateOnly(2026, 10, 5);
        Assert.False(Source(new FakeApi(), enabled: false).Covers(today.AddDays(-1), today));
        Assert.False(new TrueDataOrderFlowSource(new FakeApi(), Options.Create(new TrueDataOptions { Enabled = true }), NullLogger<TrueDataOrderFlowSource>.Instance).Covers(today, today));
        var on = Source(new FakeApi());
        Assert.True(on.Covers(today.AddDays(-3), today));
        Assert.False(on.Covers(today.AddDays(-30), today));
        Assert.False(on.Covers(today.AddDays(1), today));
    }

    private static TrueDataOrderFlowSource Source(ITrueDataHistoryApi api, bool enabled = true) =>
        new(api, Options.Create(new TrueDataOptions { Enabled = enabled, UserId = "u", Password = "p" }), NullLogger<TrueDataOrderFlowSource>.Instance);

    private sealed class FakeApi : ITrueDataHistoryApi
    {
        public Dictionary<string, string> Replies { get; } = new();
        public List<string> Calls { get; } = new();

        public Task<string> GetTicksWithBidAskAsync(string symbol, DateTime fromIst, DateTime toIst, CancellationToken cancellationToken)
        {
            Calls.Add(symbol);
            return Task.FromResult(Replies.TryGetValue(symbol, out var reply) ? reply : "Symbol does not exist");
        }
    }
}

/// <summary>TrueData:Enabled false (the default) registers nothing TrueData - the rest of the app cannot
/// reach it; true registers the SDK client and the day builder.</summary>
public sealed class TrueDataRegistrationTests
{
    private static IServiceProvider Build(Dictionary<string, string?> settings)
    {
        var configuration = new Microsoft.Extensions.Configuration.ConfigurationBuilder().AddInMemoryCollection(settings).Build();
        var services = new Microsoft.Extensions.DependencyInjection.ServiceCollection();
        services.AddLogging();
        services.AddTrueDataIfEnabled(configuration);
        return Microsoft.Extensions.DependencyInjection.ServiceCollectionContainerBuilderExtensions.BuildServiceProvider(services);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("false")]
    public void Disabled_RegistersNothing(string? enabled)
    {
        var settings = new Dictionary<string, string?> { ["TrueData:UserId"] = "u", ["TrueData:Password"] = "p" };
        if (enabled is not null) settings["TrueData:Enabled"] = enabled;
        var provider = Build(settings);

        Assert.Null(provider.GetService(typeof(TrueDataOrderFlowSource)));
        Assert.Null(provider.GetService(typeof(ITrueDataHistoryApi)));
    }

    [Fact]
    public void Enabled_RegistersTheSdkClientAndTheDayBuilder()
    {
        var provider = Build(new Dictionary<string, string?> { ["TrueData:Enabled"] = "true", ["TrueData:UserId"] = "u", ["TrueData:Password"] = "p" });

        Assert.IsType<TrueDataSdkHistoryApi>(provider.GetService(typeof(ITrueDataHistoryApi)));
        Assert.NotNull(provider.GetService(typeof(TrueDataOrderFlowSource)));
    }
}
