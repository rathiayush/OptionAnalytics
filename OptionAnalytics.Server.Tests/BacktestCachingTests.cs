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
/// The Signal backtest's loads, end to end through the REAL OiReplayService and the per-day disk cache (DhanDataCache), on a
/// fake Dhan: a past day is the day's run (/api/oi-replay/{u}/run - spot, the 42 option series, the futures) and its previous
/// day's volume profile. Asked once of Dhan, then - the same backtest again, or after a restart / deploy - from disk with NO
/// Dhan call at all; a holiday too, and with no futures / option call for it.
/// </summary>
public sealed class BacktestCachingTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), $"backtest-cache-{Guid.NewGuid():N}");

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    /// <summary>The latest weekday at least `back` days before today (a closed past day).</summary>
    private static DateOnly PastWeekday(int back)
    {
        var d = IstClock.Today().AddDays(-back);
        while (d.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) d = d.AddDays(-1);
        return d;
    }

    private static DateOnly NextWeekday(DateOnly d)
    {
        do d = d.AddDays(1); while (d.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday);
        return d;
    }

    [Theory]
    [InlineData("NIFTY", "WEEK")]
    [InlineData("BANKNIFTY", "MONTH")]
    [InlineData("SENSEX", "WEEK")]   // SENSEX has no stored database ("always live") - its own path, the same cache
    public async Task ABacktestDay_IsAskedOfDhanOnce_ThenTheSameBacktest_AndAfterARestart_AskDhanNothing(string underlying, string expiryFlag)
    {
        var day = PastWeekday(10);
        var dhan = new FakeDhan(_ => true);
        var service = Service(dhan);

        // Counted as the run endpoint counts a day (its X-Dhan-Calls / X-From-Disk answer headers).
        var firstLoad = new LoadProgress("first");
        OptionAnalytics.Server.Models.OiReplayResult first;
        using (LoadProgress.Use(firstLoad)) first = await service.RunAsync(underlying, day, 1, expiryFlag, CancellationToken.None);
        var firstProfile = await service.GetPreviousDayVolumeProfileAsync(underlying, day, CancellationToken.None);
        Assert.Equal(1 + 42 + 1, firstLoad.DhanCalls);
        Assert.True(first.Success, first.Error);
        Assert.True(firstProfile.Success, firstProfile.Error);
        Assert.Equal(375, first.SpotCandlesOneMinute.Count);
        Assert.NotEmpty(first.CePoints);
        Assert.NotEmpty(first.PePoints);
        Assert.Equal(375, first.FuturesBars.Count);
        // The first load asked Dhan: the spot, the 42 option series (ATM ± 10, CE and PE), the futures and the day before.
        Assert.Equal(1 + 42 + 1 + 1, dhan.ChartCalls);

        // The same backtest again: everything from disk.
        dhan.Reset();
        var againLoad = new LoadProgress("again");
        OptionAnalytics.Server.Models.OiReplayResult again;
        using (LoadProgress.Use(againLoad)) again = await service.RunAsync(underlying, day, 1, expiryFlag, CancellationToken.None);
        Assert.Equal(0, againLoad.DhanCalls);
        Assert.True(againLoad.ReadFromDisk >= 1 + 42 + 1, $"{againLoad.ReadFromDisk} read from disk");
        var againProfile = await service.GetPreviousDayVolumeProfileAsync(underlying, day, CancellationToken.None);
        Assert.Equal(0, dhan.ChartCalls);
        Assert.True(again.Success);
        Assert.Equal(first.SpotCandlesOneMinute.Select(c => (c.Time, c.Close)), again.SpotCandlesOneMinute.Select(c => (c.Time, c.Close)));
        Assert.Equal(first.CePoints.Count, again.CePoints.Count);
        Assert.Equal(first.PePoints.Count, again.PePoints.Count);
        Assert.Equal(first.FuturesBars.Count, again.FuturesBars.Count);
        Assert.Equal(firstProfile.Poc, againProfile.Poc);

        // A restart / deploy (a new service, the same cache folder): still nothing asked of Dhan.
        var restarted = Service(dhan);
        var afterRestart = await restarted.RunAsync(underlying, day, 1, expiryFlag, CancellationToken.None);
        var profileAfterRestart = await restarted.GetPreviousDayVolumeProfileAsync(underlying, day, CancellationToken.None);
        Assert.True(afterRestart.Success);
        Assert.True(profileAfterRestart.Success);
        Assert.Equal(0, dhan.ChartCalls);
    }

    [Fact]
    public async Task AHolidayInTheRange_IsProvedOnce_AndThenAskedOfDhanNeverAgain_WithNoFuturesOrOptionCall()
    {
        var holiday = PastWeekday(12);
        var after = NextWeekday(holiday);
        var dhan = new FakeDhan(d => d != holiday);
        var service = Service(dhan);

        var first = await service.RunAsync("NIFTY", holiday, 1, "WEEK", CancellationToken.None);
        Assert.False(first.Success);
        Assert.Contains("holiday", first.Error);
        Assert.Equal(2, dhan.ChartCalls);                 // the day alone, then through the days after it
        Assert.Equal(0, dhan.FuturesCalls);               // stops at the spot: no futures ...
        Assert.Equal(0, dhan.OptionCalls);                // ... and no option series

        // The day after it: its previous day's profile walks back OVER the holiday (read from disk - not asked) to the day
        // before it, a day nothing had loaded yet: that one is asked, once.
        dhan.Reset();
        var profile = await service.GetPreviousDayVolumeProfileAsync("NIFTY", after, CancellationToken.None);
        Assert.True(profile.Success, profile.Error);
        Assert.True(profile.ProfileDate < holiday);
        Assert.DoesNotContain(dhan.Asked, a => a.From <= holiday && a.To >= holiday);
        Assert.Equal(1, dhan.ChartCalls);

        dhan.Reset();
        var restarted = Service(dhan);
        var again = await restarted.RunAsync("NIFTY", holiday, 1, "WEEK", CancellationToken.None);
        await restarted.GetPreviousDayVolumeProfileAsync("NIFTY", after, CancellationToken.None);
        Assert.False(again.Success);
        Assert.Contains("holiday", again.Error);
        Assert.Equal(0, dhan.ChartCalls);
    }

    private OiReplayService Service(FakeDhan dhan)
    {
        var options = Options.Create(new DhanOptions
        {
            RestBaseUrl = "https://dhan.test", ScripMasterUrl = "https://dhan.test/scrip.csv", AccessToken = "t", ClientId = "c", DataApiRequestsPerSecond = 1000,
        });
        var http = new HttpClient(dhan);
        var api = new DhanApiClient(http, options, new DhanSession(options), NullLogger<DhanApiClient>.Instance);
        var cache = new DhanDataCache(_dir, NullLogger<DhanDataCache>.Instance, IstClock.Today);
        var none = new ConfigurationBuilder().Build();   // no stored database: every day from Dhan / the disk cache, as deployed
        return new OiReplayService(
            new StoredSpotDataService(none, NullLogger<StoredSpotDataService>.Instance),
            new StoredRollingOptionDataService(none, NullLogger<StoredRollingOptionDataService>.Instance),
            new DhanSpotInstrumentMaster(http, options, NullLogger<DhanSpotInstrumentMaster>.Instance),
            new DhanFuturesInstrumentMaster(http, options, NullLogger<DhanFuturesInstrumentMaster>.Instance),
            new DhanHistoricalDataService(api, NullLogger<DhanHistoricalDataService>.Instance, cache),
            new DhanRollingOptionDataService(api, NullLogger<DhanRollingOptionDataService>.Instance, cache),
            new AppEnvironment(null!, Options.Create(new AppEnvironmentOptions { IsLocal = false })));
    }

    /// <summary>Dhan for the test: the scrip master (the NIFTY index and a live NIFTY futures contract) and the chart calls -
    /// each day `traded` gets a full session of 1-minute bars from 09:15 IST (weekends none), intraday as parallel arrays,
    /// the rolling option chain under data.ce / data.pe (its toDate the day after). Chart calls are counted.</summary>
    private sealed class FakeDhan(Func<DateOnly, bool> traded) : HttpMessageHandler
    {
        private int _chart, _futures, _options;
        public int ChartCalls => _chart;
        public int FuturesCalls => _futures;
        public int OptionCalls => _options;
        /// <summary>The days each chart call asked for.</summary>
        public List<(DateOnly From, DateOnly To)> Asked { get; } = new();
        public void Reset() { _chart = 0; _futures = 0; _options = 0; lock (Asked) Asked.Clear(); }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("scrip.csv"))
            {
                var expiry = IstClock.Today().AddDays(20);
                var csv = "SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME\n" +
                          "NSE,I,13,INDEX,0,NIFTY,1.0,Nifty 50,,,,,,,,NIFTY\n" +
                          "NSE,I,25,INDEX,0,BANKNIFTY,1.0,Nifty Bank,,,,,,,,NIFTY BANK\n" +
                          "BSE,I,51,INDEX,0,SENSEX,1.0,Sensex,,,,,,,,SENSEX\n" +
                          $"NSE,D,52000,FUTIDX,0,NIFTY-{expiry:MMMyyyy}-FUT,75.0,NIFTY FUT,{expiry:yyyy-MM-dd} 14:30:00,-0.01000,XX,10.0000,M,FUTIDX,,NIFTY\n" +
                          $"NSE,D,52001,FUTIDX,0,BANKNIFTY-{expiry:MMMyyyy}-FUT,35.0,BANKNIFTY FUT,{expiry:yyyy-MM-dd} 14:30:00,-0.01000,XX,10.0000,M,FUTIDX,,BANKNIFTY\n" +
                          $"BSE,D,1100,FUTIDX,0,SENSEX-{expiry:MMMyyyy}-FUT,20.0,SENSEX FUT,{expiry:yyyy-MM-dd} 14:30:00,-0.01000,XX,10.0000,M,FUTIDX,,SENSEX\n";
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(csv) };
            }

            var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!;
            Interlocked.Increment(ref _chart);
            var rolling = path.EndsWith("rollingoption");
            if (rolling) Interlocked.Increment(ref _options);
            else if (body["instrument"]?.ToString() == "FUTIDX") Interlocked.Increment(ref _futures);
            var from = DateOnly.Parse(body["fromDate"]!.ToString()[..10]);
            var to = DateOnly.Parse(body["toDate"]!.ToString()[..10]).AddDays(rolling ? -1 : 0);
            lock (Asked) Asked.Add((from, to));
            var minutes = new List<(long Time, int I)>();
            for (var d = from; d <= to; d = d.AddDays(1))
            {
                if (d.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday || !traded(d)) continue;
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
                            ["open"] = Arr(i => 50 + i * 0.1), ["high"] = Arr(i => 51 + i * 0.1), ["low"] = Arr(i => 49 + i * 0.1), ["close"] = Arr(i => 50.5 + i * 0.1),
                            ["volume"] = Arr(_ => 5), ["timestamp"] = Stamps(), ["oi"] = Arr(i => 2000 + i), ["iv"] = Arr(_ => 12),
                            ["strike"] = Arr(_ => 25000), ["spot"] = Arr(_ => 25010),
                        },
                    },
                }
                : new JsonObject
                {
                    ["open"] = Arr(i => 25000 + i * 0.1), ["high"] = Arr(i => 25001 + i * 0.1), ["low"] = Arr(i => 24999 + i * 0.1), ["close"] = Arr(i => 25000.5 + i * 0.1),
                    ["volume"] = Arr(i => 1000 + (i % 7) * 100), ["timestamp"] = Stamps(), ["open_interest"] = Arr(i => 1000 + i),
                };
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json.ToJsonString(), Encoding.UTF8, "application/json") };
        }
    }
}
