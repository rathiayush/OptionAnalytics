using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// OI Replay's live "Σ 3 expiries" (OiReplayService.ExpiryBandAsync): the next expiry's and the monthly's option band, through
/// the REAL service on a fake Dhan - LIVE ONLY: a past day is refused with no Dhan call. Today the live feed's own N2 / MONTH
/// bars are used from the first minute it holds; Dhan only for the minutes before it (none when the feed holds the day from the
/// open) - ATM±3 for the next expiry (all its rolling options give for an expiry that is not the nearest), ATM±10 for the
/// monthly - once a day.
/// </summary>
public sealed class OiReplayExpiryBandTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), $"expiry-band-{Guid.NewGuid():N}");

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    private static DateOnly PastWeekday(int back)
    {
        var d = IstClock.Today().AddDays(-back);
        while (d.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) d = d.AddDays(-1);
        return d;
    }

    [Theory]
    [InlineData("NIFTY", "WEEK", 2)]
    [InlineData("NIFTY", "MONTH", 1)]
    [InlineData("BANKNIFTY", "MONTH", 2)]
    public async Task APastDay_IsRefused_LiveOnly_AskingDhanNothing(string underlying, string expiryFlag, int code)
    {
        var dhan = new FakeDhan(50, anyDay: true);
        var band = await Service(dhan).ExpiryBandAsync(underlying, PastWeekday(10), expiryFlag, code, CancellationToken.None);
        Assert.False(band.Success);
        Assert.Contains("live only", band.Error);
        Assert.Equal(0, dhan.Calls);
    }

    [Theory]
    [InlineData("NIFTY", "WEEK", 50)]
    [InlineData("BANKNIFTY", "MONTH", 100)]
    [InlineData("SENSEX", "WEEK", 100)]
    public async Task Today_TheNextExpiry_BeforeTheLiveFeed_IsDhansAtmPlusMinus3_OfCode2_AskedOnce(string underlying, string expiryFlag, int step)
    {
        var today = IstClock.Today();
        var dhan = new FakeDhan(step, anyDay: true);
        var service = Service(dhan, new LiveOptionLegStore());
        var next = await service.ExpiryBandAsync(underlying, today, expiryFlag, 2, CancellationToken.None, forceLive: true);
        Assert.True(next.Success, next.Error);
        Assert.Equal("N2", next.LiveFlag);
        Assert.Equal(OiReplayService.OtherExpiryBandSteps, next.DhanBandSteps);
        Assert.Null(next.Note);
        // ATM-3 .. ATM+3, CE and PE - nothing wider (Dhan refuses it for any expiry but the nearest), all with code 2.
        Assert.Equal(14, dhan.Rolling.Count);
        Assert.All(dhan.Rolling, r => Assert.Equal(2, r.Code));
        Assert.All(dhan.Rolling, r => Assert.Equal(expiryFlag, r.Flag));
        Assert.Equal(new[] { "ATM", "ATM+1", "ATM+2", "ATM+3", "ATM-1", "ATM-2", "ATM-3" },
            dhan.Rolling.Select(r => r.Strike).Distinct().OrderBy(s => s, StringComparer.Ordinal));
        var nine15 = new DateTimeOffset(today.ToDateTime(new TimeOnly(9, 15)), IstClock.Offset);
        Assert.Contains(next.CePoints, p => p.Strike == 25000 + 3 * step && p.Time == nine15 && p.OpenInterest == 2000 + 3000);

        // Asked again the same day: Dhan's answer is held for the day (TodayFetchShare) - nothing asked.
        dhan.Reset();
        var again = await service.ExpiryBandAsync(underlying, today, expiryFlag, 2, CancellationToken.None, forceLive: true);
        Assert.True(again.Success, again.Error);
        Assert.Empty(dhan.Rolling);
    }

    [Fact]
    public async Task Today_TheMonthly_BeforeTheLiveFeed_IsDhansAtmPlusMinus10_OfTheMonthSeries()
    {
        var dhan = new FakeDhan(50, anyDay: true);
        var band = await Service(dhan, new LiveOptionLegStore()).ExpiryBandAsync("NIFTY", IstClock.Today(), "MONTH", 1, CancellationToken.None, forceLive: true);
        Assert.True(band.Success, band.Error);
        Assert.Equal("MONTH", band.LiveFlag);
        Assert.Equal(10, band.DhanBandSteps);
        Assert.Equal(42, dhan.Rolling.Count);                      // the nearest monthly: ATM±10, as a Monthly run asks
        Assert.All(dhan.Rolling, r => Assert.Equal(("MONTH", 1), (r.Flag, r.Code)));
        Assert.Equal(21, band.CePoints.Select(p => p.Strike).Distinct().Count());
    }

    [Theory]
    [InlineData("NIFTY", "WEEK", 1)]
    [InlineData("NIFTY", "WEEK", 3)]
    [InlineData("NIFTY", "MONTH", 3)]
    [InlineData("BANKNIFTY", "WEEK", 2)]
    [InlineData("NIFTY", "N2", 2)]
    [InlineData("FINNIFTY", "WEEK", 2)]
    public async Task WhatIsNotTheNextOrTheMonthlyExpiry_IsRefused_AskingDhanNothing(string underlying, string expiryFlag, int code)
    {
        var dhan = new FakeDhan(50, anyDay: true);
        var band = await Service(dhan).ExpiryBandAsync(underlying, IstClock.Today(), expiryFlag, code, CancellationToken.None, forceLive: true);
        Assert.False(band.Success);
        Assert.NotNull(band.Error);
        Assert.Equal(0, dhan.Calls);
    }

    [Fact]
    public async Task Today_TheLiveFeedHoldingTheDayFromTheOpen_IsUsedWhole_WithNoOptionCall()
    {
        var today = IstClock.Today();
        var legs = new LiveOptionLegStore();
        var open = new DateTimeOffset(today.ToDateTime(new TimeOnly(9, 15)), IstClock.Offset);
        // The feed's N2 chain, ATM±10 (wider than Dhan would give), from 09:15 for 30 minutes - and the N1 chain, not read.
        for (var i = 0; i < 30; i++)
            for (var k = -10; k <= 10; k++)
            {
                legs.Record(Tick("N2", 25000 + k * 50, "CE", open.AddMinutes(i), 5000 + i));
                legs.Record(Tick("N2", 25000 + k * 50, "PE", open.AddMinutes(i), 6000 + i));
                legs.Record(Tick("N1", 25000 + k * 50, "CE", open.AddMinutes(i), 1));
            }
        var dhan = new FakeDhan(50, anyDay: true);
        var band = await Service(dhan, legs).ExpiryBandAsync("NIFTY", today, "WEEK", 2, CancellationToken.None, forceLive: true);

        Assert.True(band.Success, band.Error);
        Assert.Empty(dhan.Rolling);                       // no option series asked of Dhan
        Assert.Null(band.DhanBandSteps);
        Assert.Equal(open, band.LiveFrom);
        Assert.Equal(21, band.CePoints.Select(p => p.Strike).Distinct().Count());   // the feed's ATM±10
        Assert.All(band.CePoints.Where(p => p.Time < open.AddMinutes(30)), p => Assert.Equal(5000 + (int)(p.Time - open).TotalMinutes, p.OpenInterest));
        Assert.DoesNotContain(band.CePoints, p => p.OpenInterest == 1);              // never another chain's
    }

    [Fact]
    public async Task Today_TheMonthlyLiveFeedFromPartWay_IsUsedFromItsFirstMinute_DhansBefore()
    {
        var today = IstClock.Today();
        var legs = new LiveOptionLegStore();
        var eleven = new DateTimeOffset(today.ToDateTime(new TimeOnly(11, 0)), IstClock.Offset);
        for (var i = 0; i < 10; i++)
            for (var k = -10; k <= 10; k++)
                legs.Record(Tick("MONTH", 25000 + k * 50, "CE", eleven.AddMinutes(i), 9000 + i));
        var dhan = new FakeDhan(50, anyDay: true);
        var band = await Service(dhan, legs).ExpiryBandAsync("NIFTY", today, "MONTH", 1, CancellationToken.None, forceLive: true);

        Assert.True(band.Success, band.Error);
        Assert.Equal(42, dhan.Rolling.Count);
        Assert.All(dhan.Rolling, r => Assert.Equal(1, r.Code));
        Assert.Equal(10, band.DhanBandSteps);
        Assert.Equal(eleven, band.LiveFrom);
        // Before 11:00 Dhan's (OI 1000 + minute at the ATM), from 11:00 the feed's (9000 + minute).
        var tenThirty = new DateTimeOffset(today.ToDateTime(new TimeOnly(10, 30)), IstClock.Offset);
        Assert.Contains(band.CePoints, p => p.Time == tenThirty && p.Strike == 25000 && p.OpenInterest == 1000 + 75);
        Assert.Contains(band.CePoints, p => p.Time == eleven.AddMinutes(5) && p.OpenInterest == 9005);
        Assert.DoesNotContain(band.CePoints, p => p.Time == eleven.AddMinutes(5) && p.Strike == 25000 && p.OpenInterest == 1000 + 110);
    }

    [Fact]
    public void TheLiveFeed_KeepsBars_ForTheChainsTodaysRunAndTheSumRead()
    {
        Assert.True(OiReplayLiveFeedService.KeepsBars("WEEK"));
        Assert.True(OiReplayLiveFeedService.KeepsBars("MONTH"));
        Assert.True(OiReplayLiveFeedService.KeepsBars("N2"));
        Assert.False(OiReplayLiveFeedService.KeepsBars("N1"));   // = WEEK / MONTH's own contract
        Assert.False(OiReplayLiveFeedService.KeepsBars("N3"));
        Assert.Equal(new[] { "N2", "MONTH" }, OiReplayService.SummedLiveFlags);
    }

    [Fact]
    public void TheLegStore_SaysWhenItBeganRecordingAChain()
    {
        var legs = new LiveOptionLegStore();
        var today = IstClock.Today();
        var t = new DateTimeOffset(today.ToDateTime(new TimeOnly(10, 7, 31)), IstClock.Offset);
        Assert.Null(legs.FirstOptionMinute("NIFTY", "N2", today));
        legs.Record(Tick("N2", 25000, "CE", t.AddMinutes(3), 1));
        legs.Record(Tick("N2", 25050, "PE", t, 1));
        legs.Record(Tick("N3", 25050, "PE", t.AddMinutes(-30), 1));
        Assert.Equal(new DateTimeOffset(today.ToDateTime(new TimeOnly(10, 7)), IstClock.Offset), legs.FirstOptionMinute("nifty", "n2", today));
        Assert.Null(legs.FirstOptionMinute("NIFTY", "N2", today.AddDays(-1)));
    }

    private static LiveOptionTick Tick(string flag, decimal strike, string side, DateTimeOffset time, long oi) =>
        new("NIFTY", flag, strike, side, 100, 100, 100, 100, oi, time);

    private OiReplayService Service(FakeDhan dhan, LiveOptionLegStore? legs = null)
    {
        var options = Options.Create(new DhanOptions
        {
            RestBaseUrl = "https://dhan.test", ScripMasterUrl = "https://dhan.test/scrip.csv", AccessToken = "t", ClientId = "c", DataApiRequestsPerSecond = 1000,
        });
        var http = new HttpClient(dhan);
        var api = new DhanApiClient(http, options, new DhanSession(options), NullLogger<DhanApiClient>.Instance);
        var cache = new DhanDataCache(_dir, NullLogger<DhanDataCache>.Instance, IstClock.Today);
        var none = new ConfigurationBuilder().Build();
        return new OiReplayService(
            new StoredSpotDataService(none, NullLogger<StoredSpotDataService>.Instance),
            new StoredRollingOptionDataService(none, NullLogger<StoredRollingOptionDataService>.Instance),
            new DhanSpotInstrumentMaster(http, options, NullLogger<DhanSpotInstrumentMaster>.Instance),
            new DhanFuturesInstrumentMaster(http, options, NullLogger<DhanFuturesInstrumentMaster>.Instance),
            new DhanHistoricalDataService(api, NullLogger<DhanHistoricalDataService>.Instance, cache),
            new DhanRollingOptionDataService(api, NullLogger<DhanRollingOptionDataService>.Instance, cache),
            new AppEnvironment(null!, Options.Create(new AppEnvironmentOptions { IsLocal = false })),
            liveBars: legs);
    }

    /// <summary>Dhan for the test: the scrip master and the chart calls - a full session of 1-minute bars a weekday (any day
    /// with `anyDay` - today may be a weekend), spot at 25,010; a rolling-option series at the strike its ATM offset names
    /// (25,000 + offset x step), OI = 1000 x expiryCode + 1000 x |offset| + the minute. Each rolling call is recorded.</summary>
    private sealed class FakeDhan(int step, bool anyDay = false) : HttpMessageHandler
    {
        private int _calls;
        public int Calls => _calls;
        public List<(string Flag, int Code, string Strike)> Rolling { get; } = new();
        public void Reset() { _calls = 0; lock (Rolling) Rolling.Clear(); }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("scrip.csv"))
            {
                var csv = "SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME\n" +
                          "NSE,I,13,INDEX,0,NIFTY,1.0,Nifty 50,,,,,,,,NIFTY\n" +
                          "NSE,I,25,INDEX,0,BANKNIFTY,1.0,Nifty Bank,,,,,,,,NIFTY BANK\n" +
                          "BSE,I,51,INDEX,0,SENSEX,1.0,Sensex,,,,,,,,SENSEX\n";
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(csv) };
            }

            Interlocked.Increment(ref _calls);
            var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!;
            var rolling = path.EndsWith("rollingoption");
            var code = rolling ? (int)body["expiryCode"]! : 0;
            var token = rolling ? body["strike"]!.ToString() : "";
            if (rolling) lock (Rolling) Rolling.Add((body["expiryFlag"]!.ToString(), code, token));
            var offset = token.Length > 3 ? int.Parse(token[3..]) : 0;
            var from = DateOnly.Parse(body["fromDate"]!.ToString()[..10]);
            var to = DateOnly.Parse(body["toDate"]!.ToString()[..10]).AddDays(rolling ? -1 : 0);
            var minutes = new List<(long Time, int I)>();
            for (var d = from; d <= to; d = d.AddDays(1))
            {
                if (!anyDay && d.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) continue;
                var open = new DateTimeOffset(d.Year, d.Month, d.Day, 9, 15, 0, TimeSpan.FromMinutes(330)).ToUnixTimeSeconds();
                for (var i = 0; i < 375; i++) minutes.Add((open + 60 * i, i));
            }
            JsonArray Arr(Func<int, double> f) => new(minutes.Select(m => (JsonNode)JsonValue.Create(f(m.I))!).ToArray());
            JsonArray Stamps() => new(minutes.Select(m => (JsonNode)JsonValue.Create(m.Time)!).ToArray());
            JsonNode json = rolling
                ? new JsonObject
                {
                    ["data"] = new JsonObject
                    {
                        [body["drvOptionType"]!.ToString() == "PUT" ? "pe" : "ce"] = new JsonObject
                        {
                            ["open"] = Arr(_ => 50), ["high"] = Arr(_ => 51), ["low"] = Arr(_ => 49), ["close"] = Arr(_ => 50.5),
                            ["volume"] = Arr(_ => 5), ["timestamp"] = Stamps(), ["oi"] = Arr(i => 1000 * code + 1000 * Math.Abs(offset) + i),
                            ["iv"] = Arr(_ => 12), ["strike"] = Arr(_ => 25000 + offset * step), ["spot"] = Arr(_ => 25010),
                        },
                    },
                }
                : new JsonObject
                {
                    ["open"] = Arr(_ => 25010), ["high"] = Arr(_ => 25012), ["low"] = Arr(_ => 25008), ["close"] = Arr(_ => 25010),
                    ["volume"] = Arr(_ => 1000), ["timestamp"] = Stamps(),
                };
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json.ToJsonString(), Encoding.UTF8, "application/json") };
        }
    }
}
