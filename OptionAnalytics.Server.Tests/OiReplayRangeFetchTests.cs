using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// Covers the OI range fetch end to end (OiReplayService.RunRangeAsync / CheckDayAsync) against a
/// FAKE Dhan at the HttpClient level - never the real one, which is both a paid rate-limited API and
/// the source of numbers that price real trades. The fake answers /charts/rollingoption and
/// /charts/intraday for whatever window it is asked for, from one deterministic formula per
/// (day, strike, side, minute), so "the same day fetched two different ways" is a real question with
/// a checkable answer rather than a mock scripted to agree with itself.
///
/// September 2026 throughout (fixed past dates - see OiReplayRangeWindowTests): expiry Tuesdays are
/// the 1st, 8th, 15th, 22nd and 29th. Wed 2 Sep .. Mon 7 Sep is therefore one whole weekly cycle's
/// worth of days with no expiry day in it, and 8 Sep is an expiry day.
/// </summary>
public sealed class OiReplayRangeFetchTests
{
    private static DateOnly D(int day) => new(2026, 9, day);

    /// <summary>The band every one of these fetches covers - ATM+-10, CE and PE: 42 series, which is
    /// what one day costs the per-day way and what one whole WINDOW costs the range way.</summary>
    private const int BandSeries = 42;

    private const int MinutesPerDay = 3;

    // ---- The fast path, day by day --------------------------------------------------------------

    [Fact]
    public async Task OneWeeklyCycle_CostsOneCallPerStrike_AndEveryDayComesBackSliced()
    {
        var (service, dhan) = Service();

        var result = await service.RunRangeAsync("NIFTY", D(2), D(7), 1, "WEEK", CancellationToken.None);

        Assert.True(result.Success);
        // Wed/Thu/Fri + Mon: the weekend is never asked for.
        Assert.Equal(new[] { D(2), D(3), D(4), D(7) }, result.Days.Select(d => d.Date));
        Assert.All(result.Days, day => Assert.True(day.Success));
        Assert.All(result.Days, day => Assert.Equal("range", day.FetchSource));
        Assert.Empty(result.FallbackDays);

        // ONE Dhan window call per strike/side for the whole cycle, instead of 42 per day.
        Assert.Equal(BandSeries, OptionCalls(dhan).Count);
        Assert.Equal(BandSeries, result.OptionSeriesCalls);
        var window = Assert.Single(result.Windows);
        Assert.Equal((D(2), D(7), D(8), 1, BandSeries), (window.From, window.To, window.Expiry, window.ExpiryCode, window.Strikes));
        Assert.Null(window.Error);

        // Every call asked for the whole window, inside one contract's cycle, with expiryCode 1.
        Assert.All(OptionCalls(dhan), call =>
        {
            Assert.Equal(D(2), call.From);
            // Dhan's toDate is non-inclusive, so the window's last day is sent as the day after it.
            Assert.Equal(D(8), call.ToExclusive);
            Assert.Equal(1, call.ExpiryCode);
            Assert.Equal("WEEK", call.ExpiryFlag);
        });

        // One spot call for the whole span, not one per day.
        Assert.Single(IntradayCalls(dhan));

        // The data itself landed on the right days, with the right values.
        foreach (var day in result.Days)
        {
            Assert.Equal(21 * MinutesPerDay, day.CePoints.Count);
            Assert.Equal(21 * MinutesPerDay, day.PePoints.Count);
            Assert.All(day.CePoints, p => Assert.Equal(day.Date, IstClock.IstDate(p.Time)));
            var atm = day.CePoints.Single(p => p.Strike == FakeDhan.StrikeOf(0) && IstClock.MinutesOfDay(p.Time) == 9 * 60 + 15);
            Assert.Equal(FakeDhan.OiOf(day.Date, 0, "CALL", 0), atm.OpenInterest);
            Assert.Equal(FakeDhan.CloseOf(day.Date, 0, "CALL", 0), atm.Price);
            Assert.Equal(MinutesPerDay, day.SpotCandlesOneMinute.Count);
        }
    }

    [Fact]
    public async Task ADayFromAWindow_IsIdenticalToTheSameDayFetchedThePerDayWay()
    {
        // The whole claim of the range path, checked point for point with the app's own runtime
        // self-check (OiReplayDayComparer - the same code the range-check endpoint runs).
        var (service, _) = Service();

        var range = await service.RunRangeAsync("NIFTY", D(2), D(7), 1, "WEEK", CancellationToken.None);
        var perDay = await service.RunAsync("NIFTY", D(3), 1, "WEEK", CancellationToken.None);
        var fromWindow = range.Days.Single(d => d.Date == D(3));

        var comparison = OiReplayDayComparer.Compare(D(3), fromWindow, perDay);

        Assert.True(comparison.Match, string.Join(" | ", comparison.Differences));
        // Same sequence, not merely the same set - a caller reading the lists in order sees no change.
        Assert.Equal(perDay.CePoints, fromWindow.CePoints);
        Assert.Equal(perDay.PePoints, fromWindow.PePoints);
        Assert.Equal(perDay.SpotCandlesOneMinute, fromWindow.SpotCandlesOneMinute);
        Assert.Equal(perDay.SpotCandles, fromWindow.SpotCandles);
        Assert.Equal(perDay.Step, fromWindow.Step);
        Assert.Equal(perDay.ExpiryCode, fromWindow.ExpiryCode);
    }

    [Fact]
    public async Task AMarketHoliday_ComesBackAsAnEmptyDay_WithoutBeingFetchedAgain()
    {
        var (service, dhan) = Service();
        dhan.Holidays.Add(D(3));

        var result = await service.RunRangeAsync("NIFTY", D(2), D(7), 1, "WEEK", CancellationToken.None);

        var holiday = result.Days.Single(d => d.Date == D(3));
        Assert.False(holiday.Success);
        Assert.Contains("holiday", holiday.Error);
        Assert.Equal("range", holiday.FetchSource);
        // Present, not missing - and not worth 42 more calls, since the window's own spot call
        // already covered the day and found nothing.
        Assert.Equal(4, result.Days.Count);
        Assert.Empty(result.FallbackDays);
        Assert.Equal(BandSeries, OptionCalls(dhan).Count);
        Assert.All(result.Days.Where(d => d.Date != D(3)), day => Assert.True(day.Success));
    }

    // ---- Falling back: never a day with holes ---------------------------------------------------

    [Fact]
    public async Task AWindowWhoseStrikeCallsFail_FallsBackToThePerDayPathForEveryDayInIt()
    {
        // Dhan refuses the multi-day window (whatever the reason - this endpoint is the one this app
        // has the least confirmed behavior for) but still serves single days, exactly as today.
        var (service, dhan) = Service();
        dhan.RefuseMultiDayOptionWindows = true;

        var result = await service.RunRangeAsync("NIFTY", D(2), D(7), 1, "WEEK", CancellationToken.None);

        Assert.True(result.Success);
        Assert.Equal(4, result.Days.Count);
        Assert.All(result.Days, day => Assert.True(day.Success));
        Assert.All(result.Days, day => Assert.Equal("day", day.FetchSource));
        Assert.Equal(new[] { D(2), D(3), D(4), D(7) }, result.FallbackDays);
        // The failure is reported on the window, never swallowed.
        var window = Assert.Single(result.Windows);
        Assert.NotNull(window.Error);
        Assert.Contains("window not available", window.Error);
        // The days themselves are complete, from the proven path.
        Assert.All(result.Days, day => Assert.Equal(21 * MinutesPerDay, day.CePoints.Count));
        Assert.All(result.Days, day => Assert.Empty(day.OptionErrors));
        Assert.Equal(BandSeries + 4 * BandSeries, result.OptionSeriesCalls);
    }

    [Fact]
    public async Task ADayTheWindowOnlyHalfAnswersFor_IsFetchedAgainThePerDayWay()
    {
        // The dangerous case: the window comes back for the day, but with a hole in TIME (one minute
        // of OI where spot has three). Never returned as a complete day.
        var (service, dhan) = Service();
        dhan.ShortOiWindowDays.Add(D(4));

        var result = await service.RunRangeAsync("NIFTY", D(2), D(7), 1, "WEEK", CancellationToken.None);

        Assert.Equal(new[] { D(4) }, result.FallbackDays);
        var refetched = result.Days.Single(d => d.Date == D(4));
        Assert.Equal("day", refetched.FetchSource);
        Assert.Equal(21 * MinutesPerDay, refetched.CePoints.Count);
        Assert.All(result.Days.Where(d => d.Date != D(4)), day => Assert.Equal("range", day.FetchSource));
    }

    [Fact]
    public async Task ADayTheWindowReturnsNoOptionsFor_IsFetchedAgainThePerDayWay()
    {
        var (service, dhan) = Service();
        dhan.NoOptionWindowDays.Add(D(7));

        var result = await service.RunRangeAsync("NIFTY", D(2), D(7), 1, "WEEK", CancellationToken.None);

        Assert.Equal(new[] { D(7) }, result.FallbackDays);
        Assert.Equal("day", result.Days.Single(d => d.Date == D(7)).FetchSource);
        Assert.Equal(21 * MinutesPerDay, result.Days.Single(d => d.Date == D(7)).CePoints.Count);
    }

    [Fact]
    public async Task AStrikeMissingForOneDayOfAWindow_IsReportedOnThatDay()
    {
        // The strike has data on other days of the same window, so its absence here is a gap worth
        // saying out loud - through the same OptionErrors a failed per-day strike has always used,
        // which is what makes a caller that rejects incomplete days keep rejecting this one.
        var (service, dhan) = Service();
        dhan.SkipSeriesOnDay[(D(3), "ATM+2", "CALL")] = true;

        var result = await service.RunRangeAsync("NIFTY", D(2), D(7), 1, "WEEK", CancellationToken.None);

        var day = result.Days.Single(d => d.Date == D(3));
        Assert.Equal("range", day.FetchSource);
        var reported = Assert.Single(day.OptionErrors);
        Assert.Contains("ATM+2 CALL", reported);
        Assert.Contains("no bars", reported);
        Assert.All(result.Days.Where(d => d.Date != D(3)), other => Assert.Empty(other.OptionErrors));
    }

    [Fact]
    public async Task AnExpiryDayInsideTheRange_IsAlwaysFetchedThePerDayWay()
    {
        // 8 Sep is an expiry Tuesday: no window ever covers it (see OiReplayRangeWindows), so it
        // keeps whatever Dhan's own "1st expiry from fromDate" does on the boundary - this app's
        // established behavior - rather than this endpoint guessing.
        var (service, _) = Service();

        var result = await service.RunRangeAsync("NIFTY", D(7), D(8), 1, "WEEK", CancellationToken.None);

        Assert.Equal(new[] { D(7), D(8) }, result.Days.Select(d => d.Date));
        Assert.Equal("range", result.Days[0].FetchSource);
        Assert.Equal("day", result.Days[1].FetchSource);
        Assert.Equal(new[] { D(8) }, result.FallbackDays);
    }

    // ---- The switches: nothing fast happens unless it is allowed to ------------------------------

    [Fact]
    public async Task WithFastOiRangeOff_EveryDayIsFetchedThePerDayWay()
    {
        var (service, dhan) = Service(fastOiRange: false);

        var result = await service.RunRangeAsync("NIFTY", D(2), D(3), 1, "WEEK", CancellationToken.None);

        Assert.True(result.Success);
        Assert.NotNull(result.FastPathDisabled);
        Assert.Contains("FastOiRange is off", result.FastPathDisabled);
        Assert.Equal(new[] { D(2), D(3) }, result.FallbackDays);
        Assert.All(result.Days, day => Assert.Equal("day", day.FetchSource));
        Assert.Empty(result.Windows);
        // Not one multi-day option call was made - the fast path is genuinely off, not just unused.
        Assert.All(OptionCalls(dhan), call => Assert.Equal(call.From.AddDays(1), call.ToExclusive));
    }

    [Fact]
    public async Task Sensex_NeverUsesAWindow_BecauseThisAppCannotSayWhereItsCycleEnds()
    {
        // ExpiryCalendar is an NSE (Tuesday) calendar; SENSEX is a BSE contract. Rather than guess a
        // cut point and risk splicing two contracts, every SENSEX day stays on the per-day path.
        var (service, dhan) = Service();

        var result = await service.RunRangeAsync("SENSEX", D(2), D(2), 1, "WEEK", CancellationToken.None);

        Assert.True(result.Success);
        Assert.NotNull(result.FastPathDisabled);
        Assert.Contains("expiry calendar", result.FastPathDisabled);
        Assert.Equal(new[] { D(2) }, result.FallbackDays);
        Assert.All(OptionCalls(dhan), call => Assert.Equal(call.From.AddDays(1), call.ToExclusive));
    }

    [Fact]
    public async Task BankniftyWeekly_IsRefusedExactlyAsThePerDayPathRefusesIt()
    {
        var (service, dhan) = Service();

        var result = await service.RunRangeAsync("BANKNIFTY", D(2), D(7), 1, "WEEK", CancellationToken.None);

        Assert.False(result.Success);
        Assert.Contains("BANKNIFTY has no weekly expiry", result.Error);
        Assert.Empty(OptionCalls(dhan));
    }

    [Fact]
    public async Task ARangeWiderThanTheCap_IsRefusedWithoutFetchingAnything()
    {
        var (service, dhan) = Service();

        var result = await service.RunRangeAsync("NIFTY", new DateOnly(2026, 8, 1), D(5), 1, "WEEK", CancellationToken.None);

        Assert.False(result.Success);
        Assert.Contains("too wide", result.Error);
        Assert.Empty(OptionCalls(dhan));
        Assert.Empty(IntradayCalls(dhan));
    }

    // ---- The per-day endpoint must not have changed ----------------------------------------------

    [Fact]
    public async Task ThePerDayFetchStillSendsExactlyWhatItAlwaysSent()
    {
        // The guard on "nothing existing changed": one day, 42 single-day rolling-option calls at
        // expiryCode 1, plus one intraday spot call for that day alone.
        var (service, dhan) = Service();

        var result = await service.RunAsync("NIFTY", D(3), 1, "WEEK", CancellationToken.None);

        Assert.True(result.Success);
        Assert.Null(result.FetchSource);
        Assert.Equal(BandSeries, OptionCalls(dhan).Count);
        Assert.All(OptionCalls(dhan), call =>
        {
            Assert.Equal(D(3), call.From);
            Assert.Equal(D(4), call.ToExclusive);
            Assert.Equal(1, call.ExpiryCode);
        });
        var spot = Assert.Single(IntradayCalls(dhan));
        Assert.Equal((D(3), D(3)), (spot.From, spot.To));
    }

    // ---- The runtime self-check -------------------------------------------------------------------

    [Fact]
    public async Task TheSelfCheck_ComparesARealMultiDayWindowAgainstThePerDayFetch_AndPasses()
    {
        var (service, _) = Service();

        var (comparison, windowFrom, windowTo, error) = await service.CheckDayAsync("NIFTY", D(3), 1, "WEEK", CancellationToken.None);

        Assert.Null(error);
        Assert.NotNull(comparison);
        Assert.True(comparison!.Match, string.Join(" | ", comparison.Differences));
        // A genuinely multi-day window, or the check would prove nothing about slicing one.
        Assert.True(windowTo.DayNumber - windowFrom.DayNumber >= 1, $"window {windowFrom}..{windowTo} was not multi-day");
        Assert.True(windowFrom <= D(3) && D(3) <= windowTo);
        Assert.Equal(21 * MinutesPerDay, comparison.RangeCePoints);
    }

    [Fact]
    public async Task TheSelfCheck_FailsLoudly_WhenTheWindowFetchDisagreesWithThePerDayFetch()
    {
        // The one thing this check exists for: a window answering with different numbers than the
        // per-day call for the same day. The fake shifts every windowed OI by one.
        var (service, dhan) = Service();
        dhan.ShiftWindowOiBy = 1;

        var (comparison, _, _, error) = await service.CheckDayAsync("NIFTY", D(3), 1, "WEEK", CancellationToken.None);

        Assert.Null(error);
        Assert.NotNull(comparison);
        Assert.False(comparison!.Match);
        Assert.Contains(comparison.Differences, d => d.Contains("open interest"));
    }

    [Fact]
    public async Task TheSelfCheck_SaysSo_ForAnExpiryDayItCannotCompare()
    {
        var (service, _) = Service();

        var (comparison, _, _, error) = await service.CheckDayAsync("NIFTY", D(8), 1, "WEEK", CancellationToken.None);

        Assert.Null(comparison);
        Assert.NotNull(error);
        Assert.Contains("expiry day", error);
    }

    // ---- Futures stay per day ---------------------------------------------------------------------

    [Fact]
    public async Task EachDayKeepsItsOwnFuturesErrorAndOiFlag()
    {
        // No futures contract is resolvable from the fake scrip master (no FUTIDX rows), which is
        // the same "nothing to show, and here is why" shape the per-day path reports - per day,
        // not once for the range.
        var (service, _) = Service();

        var result = await service.RunRangeAsync("NIFTY", D(2), D(3), 1, "WEEK", CancellationToken.None);

        Assert.All(result.Days, day =>
        {
            Assert.Empty(day.FuturesBars);
            Assert.False(day.FuturesOiAvailable);
            Assert.NotNull(day.FuturesError);
        });
    }

    // ---- Plumbing ---------------------------------------------------------------------------------

    private sealed record OptionCall(DateOnly From, DateOnly ToExclusive, string Strike, string Side, int ExpiryCode, string ExpiryFlag);

    private static List<OptionCall> OptionCalls(FakeDhan dhan) =>
        dhan.Snapshot()
            .Where(r => r.Path.EndsWith("/charts/rollingoption", StringComparison.Ordinal) && r.Body is not null)
            .Select(r => new OptionCall(
                DateOnly.Parse(r.Body!["fromDate"]!.GetValue<string>(), CultureInfo.InvariantCulture),
                DateOnly.Parse(r.Body["toDate"]!.GetValue<string>(), CultureInfo.InvariantCulture),
                r.Body["strike"]!.GetValue<string>(),
                r.Body["drvOptionType"]!.GetValue<string>(),
                r.Body["expiryCode"]!.GetValue<int>(),
                r.Body["expiryFlag"]!.GetValue<string>()))
            .ToList();

    private static List<(DateOnly From, DateOnly To, string Instrument)> IntradayCalls(FakeDhan dhan) =>
        dhan.Snapshot()
            .Where(r => r.Path.EndsWith("/charts/intraday", StringComparison.Ordinal) && r.Body is not null)
            .Select(r => (
                DateOnly.Parse(r.Body!["fromDate"]!.GetValue<string>()[..10], CultureInfo.InvariantCulture),
                DateOnly.Parse(r.Body["toDate"]!.GetValue<string>()[..10], CultureInfo.InvariantCulture),
                r.Body["instrument"]!.GetValue<string>()))
            .ToList();

    private static (OiReplayService Service, FakeDhan Dhan) Service(bool fastOiRange = true)
    {
        var dhan = new FakeDhan();
        var options = Options.Create(new DhanOptions
        {
            RestBaseUrl = "https://dhan.test",
            ScripMasterUrl = "https://dhan.test/scrip.csv",
            AccessToken = "t",
            ClientId = "c",
            // Deliberately far above Dhan's real 5/s: these tests exercise the fetch logic, not the
            // rate limiter (DhanRateLimitTests covers that), and the real ceiling would make a
            // 42-call band take ten seconds per test.
            DataApiRequestsPerSecond = 200,
            DataApiRequestsPerDay = 100_000,
        });
        var session = new DhanSession(options);
        var api = new DhanApiClient(new HttpClient(dhan), options, session, NullLogger<DhanApiClient>.Instance);
        var limiter = new DhanDataApiRateLimiter(options, NullLogger<DhanDataApiRateLimiter>.Instance);
        var configuration = new ConfigurationBuilder().Build(); // no NiftyDataCollector database: live Dhan for everything
        var service = new OiReplayService(
            new StoredSpotDataService(configuration, NullLogger<StoredSpotDataService>.Instance),
            new StoredRollingOptionDataService(configuration, NullLogger<StoredRollingOptionDataService>.Instance),
            new DhanSpotInstrumentMaster(new HttpClient(dhan), options, NullLogger<DhanSpotInstrumentMaster>.Instance),
            new DhanFuturesInstrumentMaster(new HttpClient(dhan), options, NullLogger<DhanFuturesInstrumentMaster>.Instance),
            new DhanHistoricalDataService(api, limiter, NullLogger<DhanHistoricalDataService>.Instance),
            new DhanRollingOptionDataService(api, limiter, NullLogger<DhanRollingOptionDataService>.Instance),
            new AppEnvironment(new FakeHostEnvironment(), Options.Create(new AppEnvironmentOptions { IsLocal = false })),
            Options.Create(new StrategyTuningOptions { FastOiRange = fastOiRange }));
        return (service, dhan);
    }

    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "OptionAnalytics.Server.Tests";
        public string ContentRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = null!;
    }

    /// <summary>A stand-in for Dhan's Data APIs: the scrip master over GET, and /charts/rollingoption
    /// and /charts/intraday over POST, both answered for ANY window from one formula per
    /// (day, strike offset, side, minute) - so the same day requested inside a 6-day window and on
    /// its own must come back with the same numbers unless a test deliberately says otherwise. Every
    /// request is recorded, since "how many calls, over what window" is half of what these tests are
    /// checking.</summary>
    private sealed class FakeDhan : HttpMessageHandler
    {
        private readonly List<(string Path, JsonObject? Body)> _requests = new();

        /// <summary>Dhan refusing a multi-day rolling-option window while still serving single days -
        /// the fallback case.</summary>
        public bool RefuseMultiDayOptionWindows { get; set; }

        /// <summary>Days the market was closed: no spot, no options, from either path.</summary>
        public HashSet<DateOnly> Holidays { get; } = new();

        /// <summary>Days a multi-day window answers for with one minute of OI instead of the full
        /// session (the per-day path still answers in full) - a hole in time.</summary>
        public HashSet<DateOnly> ShortOiWindowDays { get; } = new();

        /// <summary>Days a multi-day window returns no option bars for at all.</summary>
        public HashSet<DateOnly> NoOptionWindowDays { get; } = new();

        /// <summary>One (day, strike token, side) a window leaves out while serving the rest.</summary>
        public Dictionary<(DateOnly Day, string Strike, string Side), bool> SkipSeriesOnDay { get; } = new();

        /// <summary>Makes a multi-day window answer with DIFFERENT open interest than the per-day
        /// call for the same minute - the disagreement the runtime self-check has to catch.</summary>
        public long ShiftWindowOiBy { get; set; }

        public List<(string Path, JsonObject? Body)> Snapshot()
        {
            lock (_requests) return _requests.ToList();
        }

        internal static decimal StrikeOf(int steps) => 25_000m + steps * 50m;
        internal static long OiOf(DateOnly day, int steps, string side, int minute) =>
            day.Day * 100_000L + (steps + 10) * 1_000L + (side == "CALL" ? 0 : 500) + minute;
        internal static decimal CloseOf(DateOnly day, int steps, string side, int minute) =>
            100m + steps + minute + (side == "CALL" ? 0m : 0.5m) + day.Day * 0.01m;

        private const string ScripMaster =
            "SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_TRADING_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_LOT_UNITS,SEM_TICK_SIZE,SM_SYMBOL_NAME\n" +
            "NSE,I,13,INDEX,NIFTY 50,,,,,,NIFTY 50\n" +
            "BSE,I,51,INDEX,SENSEX,,,,,,SENSEX\n";

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (request.Method == HttpMethod.Get)
            {
                lock (_requests) _requests.Add((path, null));
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(ScripMaster, Encoding.UTF8, "text/csv") };
            }

            var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!.AsObject();
            lock (_requests) _requests.Add((path, body));

            if (path.EndsWith("/charts/rollingoption", StringComparison.Ordinal)) return RollingOption(body);
            if (path.EndsWith("/charts/intraday", StringComparison.Ordinal)) return Intraday(body);
            return new HttpResponseMessage(HttpStatusCode.NotFound) { Content = new StringContent("{\"errorMessage\":\"unexpected path\"}") };
        }

        private HttpResponseMessage RollingOption(JsonObject body)
        {
            var from = DateOnly.Parse(body["fromDate"]!.GetValue<string>(), CultureInfo.InvariantCulture);
            // Dhan's own toDate is non-inclusive - this fake honors that, so a caller that forgot to
            // add the day would visibly lose its last day here too.
            var toExclusive = DateOnly.Parse(body["toDate"]!.GetValue<string>(), CultureInfo.InvariantCulture);
            var strikeToken = body["strike"]!.GetValue<string>();
            var side = body["drvOptionType"]!.GetValue<string>();
            var isWindow = toExclusive.DayNumber - from.DayNumber > 1;

            if (isWindow && RefuseMultiDayOptionWindows)
                return new HttpResponseMessage(HttpStatusCode.BadRequest)
                {
                    Content = new StringContent("{\"errorMessage\":\"Input_Exception: window not available\"}", Encoding.UTF8, "application/json"),
                };

            var steps = ParseSteps(strikeToken);
            var timestamps = new JsonArray();
            var open = new JsonArray();
            var high = new JsonArray();
            var low = new JsonArray();
            var close = new JsonArray();
            var volume = new JsonArray();
            var strike = new JsonArray();
            var spot = new JsonArray();
            var oi = new JsonArray();
            var iv = new JsonArray();

            for (var day = from; day < toExclusive; day = day.AddDays(1))
            {
                if (day.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday || Holidays.Contains(day)) continue;
                if (isWindow && NoOptionWindowDays.Contains(day)) continue;
                if (isWindow && SkipSeriesOnDay.ContainsKey((day, strikeToken, side))) continue;
                var minutes = isWindow && ShortOiWindowDays.Contains(day) ? 1 : MinutesPerDay;
                for (var minute = 0; minute < minutes; minute++)
                {
                    var price = CloseOf(day, steps, side, minute);
                    timestamps.Add(IstClock.AtIstTime(day, 9 * 60 + 15 + minute).ToUnixTimeSeconds());
                    open.Add(price);
                    high.Add(price + 1m);
                    low.Add(price - 1m);
                    close.Add(price);
                    volume.Add(500 + minute);
                    strike.Add(StrikeOf(steps));
                    spot.Add(25_000m);
                    oi.Add(OiOf(day, steps, side, minute) + (isWindow ? ShiftWindowOiBy : 0));
                    iv.Add(11m + steps);
                }
            }

            var series = new JsonObject
            {
                ["open"] = open, ["high"] = high, ["low"] = low, ["close"] = close, ["volume"] = volume,
                ["strike"] = strike, ["spot"] = spot, ["oi"] = oi, ["iv"] = iv, ["timestamp"] = timestamps,
            };
            var data = new JsonObject { ["ce"] = side == "CALL" ? series : null, ["pe"] = side == "PUT" ? series : null };
            return Json(new JsonObject { ["data"] = data });
        }

        private HttpResponseMessage Intraday(JsonObject body)
        {
            var from = DateOnly.Parse(body["fromDate"]!.GetValue<string>()[..10], CultureInfo.InvariantCulture);
            var to = DateOnly.Parse(body["toDate"]!.GetValue<string>()[..10], CultureInfo.InvariantCulture);

            var timestamps = new JsonArray();
            var open = new JsonArray();
            var high = new JsonArray();
            var low = new JsonArray();
            var close = new JsonArray();
            var volume = new JsonArray();
            for (var day = from; day <= to; day = day.AddDays(1))
            {
                if (day.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday || Holidays.Contains(day)) continue;
                for (var minute = 0; minute < MinutesPerDay; minute++)
                {
                    var price = 25_000m + day.Day + minute;
                    timestamps.Add(IstClock.AtIstTime(day, 9 * 60 + 15 + minute).ToUnixTimeSeconds());
                    open.Add(price);
                    high.Add(price + 5m);
                    low.Add(price - 5m);
                    close.Add(price);
                    volume.Add(1_000 + minute);
                }
            }

            return Json(new JsonObject
            {
                ["open"] = open, ["high"] = high, ["low"] = low, ["close"] = close, ["volume"] = volume, ["timestamp"] = timestamps,
            });
        }

        private static int ParseSteps(string strikeToken) =>
            strikeToken == "ATM" ? 0 : int.Parse(strikeToken[3..], NumberStyles.Integer | NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);

        private static HttpResponseMessage Json(JsonNode node) =>
            new(HttpStatusCode.OK) { Content = new StringContent(node.ToJsonString(), Encoding.UTF8, "application/json") };
    }
}
