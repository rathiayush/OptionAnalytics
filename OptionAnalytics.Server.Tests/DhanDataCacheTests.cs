using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// DhanDataCache: every past day of a Dhan Data API series (intraday spot / futures / option candles, the rolling /
/// expired-option chain) is kept on disk, one file per day, and any later window holding that day reads it from there -
/// across restarts, and with no Dhan session; only the days not kept go to Dhan, in one call. Only what can never change
/// is kept: a closed day with a full session (or one Dhan has answered past). Today, an empty answer, a half last day, a
/// failed call are asked of Dhan again. The folder is held to its cap (10 GB), the files read least recently going first.
/// </summary>
public sealed class DhanDataCacheTests : IDisposable
{
    private static readonly DateOnly PastDay = new(2025, 9, 15);
    private readonly string _dir = Path.Combine(Path.GetTempPath(), $"dhan-cache-{Guid.NewGuid():N}");

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    private DhanDataCache Cache(DateOnly? today = null) => new(_dir, NullLogger<DhanDataCache>.Instance, () => today ?? new DateOnly(2026, 10, 12));

    [Fact]
    public void AForceFetch_SkipsWhatIsKept_AndWritesTheFreshAnswerOverIt()
    {
        var cache = Cache();
        var key = new { securityId = "13" };
        cache.PutDay("/charts/intraday", key, PastDay, w => w.WriteRawValue("""{"close":[1],"timestamp":[1]}"""));
        Assert.True(cache.HasDay("/charts/intraday", key, PastDay));

        using (DhanDataCache.ForceRefreshScope())
        {
            Assert.True(DhanDataCache.ForceRefresh);
            Assert.False(cache.HasDay("/charts/intraday", key, PastDay));          // asked of Dhan again
            Assert.Null(cache.TryGetDay("/charts/intraday", key, PastDay));
            cache.PutDay("/charts/intraday", key, PastDay, w => w.WriteRawValue("""{"close":[9],"timestamp":[9]}"""));   // and updated
        }
        Assert.False(DhanDataCache.ForceRefresh);
        using var back = cache.TryGetDay("/charts/intraday", key, PastDay);
        Assert.Contains("[9]", back!.RootElement.GetRawText());
    }

    [Fact]
    public void AClosedWindowWithData_IsKept_AndReadBack_ByItsRequest()
    {
        var cache = Cache();
        var payload = new { securityId = "13", fromDate = "2025-09-15 09:15:00", toDate = "2025-09-15 15:30:00" };
        using var doc = JsonDocument.Parse("""{"close":[1,2],"timestamp":[1,2]}""");
        cache.Put("/charts/intraday", payload, PastDay, doc.RootElement, hasData: true);

        using var back = cache.TryGet("/charts/intraday", payload, PastDay);
        Assert.NotNull(back);
        Assert.Equal(doc.RootElement.GetRawText(), back!.RootElement.GetRawText());
        Assert.Equal((1, 1), (cache.Writes, cache.Hits));
        Assert.Null(cache.TryGet("/charts/intraday", new { securityId = "14", fromDate = "2025-09-15 09:15:00", toDate = "2025-09-15 15:30:00" }, PastDay));
        Assert.Null(cache.TryGet("/charts/rollingoption", payload, PastDay));
        // On disk as gzip JSON with the request beside the response - readable on the Data files page.
        var file = cache.FileOf("/charts/intraday", payload, PastDay);
        Assert.Contains(Path.Combine("v1", "charts-intraday", "2025-09"), file);
        Assert.EndsWith(".json.gz", file);
    }

    [Fact]
    public void Today_AnEmptyAnswer_AndABrokenFile_AreNeverServed()
    {
        var today = new DateOnly(2026, 10, 12);
        var cache = Cache(today);
        var payload = new { securityId = "13" };
        using var doc = JsonDocument.Parse("""{"timestamp":[1]}""");
        cache.Put("/charts/intraday", payload, today, doc.RootElement, hasData: true);
        Assert.Null(cache.TryGet("/charts/intraday", payload, today));
        Assert.False(Directory.Exists(_dir), "today is still forming - nothing written");

        cache.Put("/charts/intraday", payload, PastDay, doc.RootElement, hasData: false);
        Assert.Null(cache.TryGet("/charts/intraday", payload, PastDay));

        cache.Put("/charts/intraday", payload, PastDay, doc.RootElement, hasData: true);
        var file = cache.FileOf("/charts/intraday", payload, PastDay);
        File.WriteAllText(file, "not gzip");
        Assert.Null(cache.TryGet("/charts/intraday", payload, PastDay));
        Assert.False(File.Exists(file), "a broken file is deleted, so the day is fetched again");
    }

    [Fact]
    public async Task APastDaysSpotCandles_AreAskedOfDhanOnce_ThenServedFromDisk_EvenWithNoSession()
    {
        var requests = new List<string>();
        var service = Historical(requests, Cache(), session: true);
        var (first, error) = await service.GetIntradayCandlesAsync(13, "IDX_I", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Null(error);
        Assert.Equal(375, first.Count);
        var (again, _) = await service.GetIntradayCandlesAsync(13, "IDX_I", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Single(requests);
        Assert.Equal(first.Select(c => (c.Time, c.Close)), again.Select(c => (c.Time, c.Close)));

        // A restart, and Dhan not logged in: the closed day still comes from disk.
        var offline = Historical(requests, Cache(), session: false);
        var (fromDisk, offlineError) = await offline.GetIntradayCandlesAsync(13, "IDX_I", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Null(offlineError);
        Assert.Equal(375, fromDisk.Count);
        Assert.Single(requests);
        // A day never fetched, with no session: the usual error.
        var (_, notThere) = await offline.GetIntradayCandlesAsync(13, "IDX_I", PastDay.AddDays(-3), PastDay.AddDays(-3), 1, CancellationToken.None);
        Assert.Equal("Dhan is not authenticated", notThere);
    }

    [Fact]
    public async Task FuturesCandles_AreKeptToo_WithTheirOi()
    {
        var requests = new List<string>();
        var service = Historical(requests, Cache(), session: true);
        var (bars, oiPresent, _) = await service.GetIntradayFuturesCandlesAsync(55, "NSE_FNO", PastDay, PastDay, 1, CancellationToken.None);
        var (again, oiAgain, _) = await service.GetIntradayFuturesCandlesAsync(55, "NSE_FNO", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Single(requests);
        Assert.True(oiPresent && oiAgain);
        Assert.Equal(bars.Select(b => b.OpenInterest), again.Select(b => b.OpenInterest));
    }

    [Fact]
    public async Task Today_AHalfDay_AndAnEmptyDay_AreAskedAgain()
    {
        var requests = new List<string>();
        var today = new DateOnly(2026, 10, 12);
        var service = Historical(requests, Cache(today), session: true);
        await service.GetIntradayCandlesAsync(13, "IDX_I", today, today, 1, CancellationToken.None);
        await service.GetIntradayCandlesAsync(13, "IDX_I", today, today, 1, CancellationToken.None);
        Assert.Equal(2, requests.Count);

        requests.Clear();
        var half = Historical(requests, Cache(today), session: true, bars: 120);
        await half.GetIntradayCandlesAsync(13, "IDX_I", PastDay, PastDay, 1, CancellationToken.None);
        await half.GetIntradayCandlesAsync(13, "IDX_I", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Equal(2, requests.Count);

        requests.Clear();
        var empty = Historical(requests, Cache(today), session: true, bars: 0);
        await empty.GetIntradayCandlesAsync(14, "IDX_I", PastDay, PastDay, 1, CancellationToken.None);
        await empty.GetIntradayCandlesAsync(14, "IDX_I", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Equal(2, requests.Count);
    }

    [Fact]
    public async Task TheExpiredOptionChain_IsKept()
    {
        var requests = new List<string>();
        var service = Rolling(requests, Cache(), session: true);
        var (bars, error) = await service.GetRollingOptionCandlesAsync("NIFTY", 13, "WEEK", 1, "ATM", "CALL", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Null(error);
        Assert.NotEmpty(bars);
        var (again, _) = await Rolling(requests, Cache(), session: false).GetRollingOptionCandlesAsync("NIFTY", 13, "WEEK", 1, "ATM", "CALL", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Single(requests);
        Assert.Equal(bars.Select(b => (b.Bar.Close, b.OpenInterest)), again.Select(b => (b.Bar.Close, b.OpenInterest)));
        // The other side, or another strike, is its own request.
        await service.GetRollingOptionCandlesAsync("NIFTY", 13, "WEEK", 1, "ATM", "PUT", PastDay, PastDay, 1, CancellationToken.None);
        await service.GetRollingOptionCandlesAsync("NIFTY", 13, "WEEK", 1, "ATM+1", "CALL", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Equal(3, requests.Count);
        // A day Dhan sent only part of is asked again.
        requests.Clear();
        var api = Api(requests, session: true, bars: 90);
        var half = new DhanRollingOptionDataService(api, NullLogger<DhanRollingOptionDataService>.Instance, Cache());
        await half.GetRollingOptionCandlesAsync("NIFTY", 13, "WEEK", 1, "ATM-2", "CALL", PastDay, PastDay, 1, CancellationToken.None);
        await half.GetRollingOptionCandlesAsync("NIFTY", 13, "WEEK", 1, "ATM-2", "CALL", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Equal(2, requests.Count);
    }

    [Fact]
    public async Task AThinOptionStrike_WhoseUntradedMinutesComeAtZero_IsKeptLikeAnyOther()
    {
        // BANKNIFTY's monthly options away from the money: Dhan sends every minute of the session, the ones the strike did
        // not trade at a 0 price - which the parser drops as implausible. The session is whole all the same: kept, and
        // the next load is answered from disk (it used to go to Dhan again on every load, forever).
        var requests = new List<string>();
        var (bars, error) = await Rolling(requests, Cache(), session: true, thin: true).GetRollingOptionCandlesAsync("BANKNIFTY", 25, "MONTH", 1, "ATM+8", "CALL", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Null(error);
        Assert.True(bars.Count < 300, $"the parser keeps only the traded minutes ({bars.Count})");
        var (again, _) = await Rolling(requests, Cache(), session: false, thin: true).GetRollingOptionCandlesAsync("BANKNIFTY", 25, "MONTH", 1, "ATM+8", "CALL", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Single(requests);
        Assert.Equal(bars.Select(b => b.Bar.Close), again.Select(b => b.Bar.Close));

        // An option contract's own intraday candles the same.
        requests.Clear();
        var (candles, _) = await Historical(requests, Cache(), session: true, thin: true).GetIntradayOptionCandlesAsync(51234, "NSE_FNO", PastDay, PastDay, 1, CancellationToken.None);
        Assert.True(candles.Count is > 0 and < 300);
        var (fromDisk, _) = await Historical(requests, Cache(), session: false, thin: true).GetIntradayOptionCandlesAsync(51234, "NSE_FNO", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Single(requests);
        Assert.Equal(candles.Count, fromDisk.Count);

        // A day Dhan sent only part of is still asked again - thin or not.
        requests.Clear();
        var api = Api(requests, session: true, bars: 90, thin: true);
        var half = new DhanRollingOptionDataService(api, NullLogger<DhanRollingOptionDataService>.Instance, Cache());
        await half.GetRollingOptionCandlesAsync("BANKNIFTY", 25, "MONTH", 1, "ATM+9", "CALL", PastDay, PastDay, 1, CancellationToken.None);
        await half.GetRollingOptionCandlesAsync("BANKNIFTY", 25, "MONTH", 1, "ATM+9", "CALL", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Equal(2, requests.Count);
    }

    [Fact]
    public void DayRanges_AreEachDaysMinutesAsDhanSentThem_ZeroPricedOnesIncluded()
    {
        // 15-09 09:15, 09:16 (a 0-priced minute of a thin strike), then 16-09 09:15.
        using var doc = JsonDocument.Parse("{\"close\":[0,10.5,11],\"timestamp\":[1757908500,1757908560,1757994900]}");
        var ranges = DhanDayWindow.DayRanges(doc.RootElement)!;
        Assert.Equal((0, 2), ranges[new DateOnly(2025, 9, 15)]);
        Assert.Equal((2, 3), ranges[new DateOnly(2025, 9, 16)]);
        using var none = JsonDocument.Parse("{\"data\":{}}");
        Assert.Empty(DhanDayWindow.DayRanges(DhanRollingOptionDataService.SideOf(none.RootElement, "PUT"))!);
        using var unordered = JsonDocument.Parse("{\"timestamp\":[1757994900,1757908500]}");
        Assert.Null(DhanDayWindow.DayRanges(unordered.RootElement));
        using var rolling = JsonDocument.Parse("{\"data\":{\"pe\":{\"timestamp\":[1757908500]}}}");
        Assert.Single(DhanDayWindow.DayRanges(DhanRollingOptionDataService.SideOf(rolling.RootElement, "PUT"))!);
        Assert.Empty(DhanDayWindow.DayRanges(DhanRollingOptionDataService.SideOf(rolling.RootElement, "CALL"))!);
    }

    [Theory]
    [InlineData(13u, "IDX_I")]     // NIFTY spot
    [InlineData(25u, "IDX_I")]     // BANKNIFTY spot
    [InlineData(51u, "IDX_I")]     // SENSEX spot
    public async Task AWindowRunningIntoToday_KeepsItsPastDays_SoTheNextOneAsksDhanForTodayOnly(uint securityId, string segment)
    {
        // The chart backfills ask "the last N days up to today" on every start - today is never kept, and the past days of
        // that window used to go with it, so every start asked Dhan for all of them again.
        var today = new DateOnly(2026, 10, 14); // a Wednesday
        var requests = new List<string>();
        var service = Historical(requests, Cache(today), session: true);
        var (first, error) = await service.GetIntradayCandlesAsync(securityId, segment, today.AddDays(-9), today, 1, CancellationToken.None);
        Assert.Null(error);
        Assert.Equal(8 * 375, first.Count); // 7 past weekdays + today
        var (again, _) = await Historical(requests, Cache(today), session: true).GetIntradayCandlesAsync(securityId, segment, today.AddDays(-9), today, 1, CancellationToken.None);
        Assert.Equal(2, requests.Count);
        Assert.Equal((today, today), Asked(requests[1]));
        Assert.Equal(first.Select(c => (c.Time, c.Close)), again.Select(c => (c.Time, c.Close)));

        // With no Dhan session the kept days still come back, with the reason today does not.
        var (offline, offlineError) = await Historical(requests, Cache(today), session: false).GetIntradayCandlesAsync(securityId, segment, today.AddDays(-9), today, 1, CancellationToken.None);
        Assert.Equal("Dhan is not authenticated", offlineError);
        Assert.Equal(7 * 375, offline.Count);
    }

    [Fact]
    public async Task AnotherWindow_ReadsTheDaysAlreadyKept_AndAsksDhanOnlyForTheRest()
    {
        // Mon 15-09 .. Fri 19-09 once; then any window inside it is answered from disk, and one reaching past it asks Dhan
        // only for the days not kept - the weekend before the next Monday kept empty, as Dhan answered past it.
        var requests = new List<string>();
        var service = Historical(requests, Cache(), session: true);
        await service.GetIntradayCandlesAsync(13, "IDX_I", PastDay, PastDay.AddDays(4), 1, CancellationToken.None);
        var (wednesday, _) = await service.GetIntradayCandlesAsync(13, "IDX_I", PastDay.AddDays(2), PastDay.AddDays(2), 1, CancellationToken.None);
        Assert.Single(requests);
        Assert.Equal(375, wednesday.Count);
        Assert.All(wednesday, c => Assert.Equal(PastDay.AddDays(2), IstClock.IstDate(c.Time)));

        var (longer, _) = await service.GetIntradayCandlesAsync(13, "IDX_I", PastDay.AddDays(3), PastDay.AddDays(8), 1, CancellationToken.None);
        Assert.Equal(2, requests.Count);
        Assert.Equal((PastDay.AddDays(5), PastDay.AddDays(8)), Asked(requests[1]));
        Assert.Equal(4 * 375, longer.Count); // Thu, Fri from disk + Mon, Tue from Dhan
        Assert.Equal(longer.OrderBy(c => c.Time).Select(c => c.Time), longer.Select(c => c.Time));
        await service.GetIntradayCandlesAsync(13, "IDX_I", PastDay, PastDay.AddDays(8), 1, CancellationToken.None);
        await service.GetIntradayCandlesAsync(13, "IDX_I", PastDay.AddDays(6), PastDay.AddDays(6), 1, CancellationToken.None); // a Sunday
        Assert.Equal(2, requests.Count);
    }

    [Fact]
    public async Task AHoliday_IsKeptEmptyOnceDhanAnsweredPastIt_AndAShortSessionStaysShort()
    {
        // Wed 17-09 a holiday, Thu 18-09 a short session (60 minutes) - both final once Dhan sent the Friday.
        var holiday = PastDay.AddDays(2);
        var shortDay = PastDay.AddDays(3);
        int BarsOn(DateOnly d) => d == holiday || d.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday ? 0 : d == shortDay ? 60 : 375;
        var requests = new List<string>();
        var service = Historical(requests, Cache(), session: true, barsOn: BarsOn);
        await service.GetIntradayCandlesAsync(13, "IDX_I", PastDay, PastDay.AddDays(4), 1, CancellationToken.None);
        var (none, error) = await service.GetIntradayCandlesAsync(13, "IDX_I", holiday, holiday, 1, CancellationToken.None);
        var (shortSession, _) = await service.GetIntradayCandlesAsync(13, "IDX_I", shortDay, shortDay, 1, CancellationToken.None);
        Assert.Single(requests);
        Assert.Null(error);
        Assert.Empty(none);
        Assert.Equal(60, shortSession.Count);

        // A holiday or a short day that is the LAST one Dhan sent is asked again - it may still be coming.
        requests.Clear();
        var fresh = Historical(requests, Cache(), session: true, barsOn: BarsOn);
        await fresh.GetIntradayCandlesAsync(14, "IDX_I", PastDay, holiday, 1, CancellationToken.None);
        await fresh.GetIntradayCandlesAsync(14, "IDX_I", holiday, holiday, 1, CancellationToken.None);
        await fresh.GetIntradayCandlesAsync(15, "IDX_I", shortDay, shortDay, 1, CancellationToken.None);
        await fresh.GetIntradayCandlesAsync(15, "IDX_I", shortDay, shortDay, 1, CancellationToken.None);
        Assert.Equal(4, requests.Count);
    }

    [Theory]
    [InlineData("NIFTY", "WEEK", "NSE_FNO")]
    [InlineData("BANKNIFTY", "MONTH", "NSE_FNO")]
    [InlineData("SENSEX", "WEEK", "BSE_FNO")]
    public async Task TheOptionChain_IsKeptPerDay_ForEveryIndex(string underlying, string expiryFlag, string segment)
    {
        var requests = new List<string>();
        var service = Rolling(requests, Cache(), session: true);
        var (week, error) = await service.GetRollingOptionCandlesAsync(underlying, 7, expiryFlag, 1, "ATM+2", "PUT", PastDay, PastDay.AddDays(4), 1, CancellationToken.None);
        Assert.Null(error);
        Assert.Equal(5 * 375, week.Count);
        Assert.Contains($"\"exchangeSegment\":\"{segment}\"", requests[0]);
        var (day, _) = await Rolling(requests, Cache(), session: false).GetRollingOptionCandlesAsync(underlying, 7, expiryFlag, 1, "ATM+2", "PUT", PastDay.AddDays(3), PastDay.AddDays(3), 1, CancellationToken.None);
        Assert.Single(requests);
        Assert.Equal(week.Where(b => IstClock.IstDate(b.Bar.Time) == PastDay.AddDays(3)).Select(b => (b.Bar.Close, b.OpenInterest, b.Strike)), day.Select(b => (b.Bar.Close, b.OpenInterest, b.Strike)));
        // Past the kept days: only the new ones are asked (Dhan's toDate is the day after).
        await service.GetRollingOptionCandlesAsync(underlying, 7, expiryFlag, 1, "ATM+2", "PUT", PastDay.AddDays(4), PastDay.AddDays(7), 1, CancellationToken.None);
        Assert.Equal(2, requests.Count);
        Assert.Equal((PastDay.AddDays(5), PastDay.AddDays(8)), Asked(requests[1]));
    }

    [Fact]
    public async Task AnOlderWholeWindowFile_IsStillRead_AndSplitIntoDays()
    {
        // What the cache kept before it kept days: the very same request is answered from it, and its days now serve any
        // window - nothing already on the server is asked of Dhan again.
        var requests = new List<string>();
        var service = Historical(requests, Cache(), session: true);
        var (week, _, _) = await service.GetIntradayFuturesCandlesAsync(55, "NSE_FNO", PastDay, PastDay.AddDays(4), 1, CancellationToken.None);
        Assert.Single(requests);
        var payload = JsonNode.Parse(requests[0][(requests[0].IndexOf(' ') + 1)..])!.AsObject();
        payload.Remove("dhanClientId");
        var legacyDir = Path.Combine(_dir, "legacy");
        var legacy = new DhanDataCache(legacyDir, NullLogger<DhanDataCache>.Instance, () => new DateOnly(2026, 10, 12));
        using (var whole = JsonDocument.Parse(WholeWindowJson(week)))
            legacy.Put("/charts/intraday", new
            {
                securityId = "55", exchangeSegment = "NSE_FNO", instrument = "FUTIDX", interval = "1",
                fromDate = $"{PastDay:yyyy-MM-dd} 09:15:00", toDate = $"{PastDay.AddDays(4):yyyy-MM-dd} 15:30:00", oi = true,
            }, PastDay.AddDays(4), whole.RootElement, hasData: true);
        Assert.Equal(payload.ToJsonString(), JsonSerializer.Serialize(new
        {
            securityId = "55", exchangeSegment = "NSE_FNO", instrument = "FUTIDX", interval = "1",
            fromDate = $"{PastDay:yyyy-MM-dd} 09:15:00", toDate = $"{PastDay.AddDays(4):yyyy-MM-dd} 15:30:00", oi = true,
        }));

        requests.Clear();
        var readerCache = new DhanDataCache(legacyDir, NullLogger<DhanDataCache>.Instance, () => new DateOnly(2026, 10, 12));
        var reader = Historical(requests, readerCache, session: false);
        var (fromOld, oiPresent, error) = await reader.GetIntradayFuturesCandlesAsync(55, "NSE_FNO", PastDay, PastDay.AddDays(4), 1, CancellationToken.None);
        Assert.Null(error);
        Assert.True(oiPresent);
        Assert.Equal(week.Select(b => (b.Bar.Time, b.OpenInterest)), fromOld.Select(b => (b.Bar.Time, b.OpenInterest)));
        Assert.Equal(5, readerCache.Writes); // its five days
        // Read again: its days now come from their own files - nothing written again.
        var (again, _, _) = await reader.GetIntradayFuturesCandlesAsync(55, "NSE_FNO", PastDay, PastDay.AddDays(4), 1, CancellationToken.None);
        Assert.Equal(fromOld.Select(b => (b.Bar.Time, b.OpenInterest)), again.Select(b => (b.Bar.Time, b.OpenInterest)));
        Assert.Equal(5, readerCache.Writes);
        var (tuesday, _, dayError) = await reader.GetIntradayFuturesCandlesAsync(55, "NSE_FNO", PastDay.AddDays(1), PastDay.AddDays(1), 1, CancellationToken.None);
        Assert.Null(dayError);
        Assert.Equal(375, tuesday.Count);
        Assert.Empty(requests);
    }

    [Fact]
    public void TheFolder_IsHeldToItsCap_TheFilesReadLeastRecentlyGoingFirst()
    {
        var cache = new DhanDataCache(_dir, NullLogger<DhanDataCache>.Instance, () => new DateOnly(2026, 10, 12), maxBytes: long.MaxValue);
        var noise = string.Join(",", Enumerable.Range(0, 4000).Select(i => (i * 7919 % 10007).ToString()));
        using var doc = JsonDocument.Parse($"{{\"close\":[{noise}]}}");
        var days = Enumerable.Range(0, 10).Select(i => PastDay.AddDays(i)).ToList();
        foreach (var d in days) cache.Put("/charts/intraday", new { d }, d, doc.RootElement, hasData: true);
        var files = days.Select(d => cache.FileOf("/charts/intraday", new { d }, d)).ToList();
        var each = new FileInfo(files[0]).Length;
        // Read long ago, in day order - except the first day, read just now.
        for (var i = 0; i < files.Count; i++) File.SetLastAccessTimeUtc(files[i], DateTime.UtcNow.AddDays(-30 + i));
        for (var i = 0; i < files.Count; i++) File.SetLastWriteTimeUtc(files[i], DateTime.UtcNow.AddDays(-40));
        using (cache.TryGet("/charts/intraday", new { d = days[0] }, days[0])) { }

        var capped = new DhanDataCache(_dir, NullLogger<DhanDataCache>.Instance, () => new DateOnly(2026, 10, 12), maxBytes: each * 6);
        var deleted = capped.TrimNow();
        var left = files.Where(File.Exists).ToList();
        Assert.True(left.Sum(f => new FileInfo(f).Length) <= each * 6 * DhanDataCache.TrimTo, $"{left.Count} files left");
        Assert.True(deleted > 0);
        Assert.Contains(files[0], left);                   // read just now
        Assert.Contains(files[^1], left);                  // read most recently of the rest
        Assert.False(File.Exists(files[1]), "the one read longest ago goes first");

        // Under the cap: nothing goes.
        Assert.Equal(0, new DhanDataCache(_dir, NullLogger<DhanDataCache>.Instance, () => new DateOnly(2026, 10, 12), maxBytes: each * 100).TrimNow());
    }

    [Fact]
    public async Task AWriteOverTheCap_TrimsTheFolderByItself()
    {
        var cache = new DhanDataCache(_dir, NullLogger<DhanDataCache>.Instance, () => new DateOnly(2026, 10, 12), maxBytes: 4_000);
        var noise = string.Join(",", Enumerable.Range(0, 2000).Select(i => (i * 7919 % 10007).ToString()));
        using var doc = JsonDocument.Parse($"{{\"close\":[{noise}]}}");
        for (var i = 0; i < 8; i++)
        {
            cache.Put("/charts/intraday", new { i }, PastDay, doc.RootElement, hasData: true);
            await Task.Delay(20);
        }
        long Size() => Directory.EnumerateFiles(_dir, "*.json.gz", SearchOption.AllDirectories).Sum(f => new FileInfo(f).Length);
        for (var waited = 0; Size() > 4_000 && waited < 3000; waited += 20) await Task.Delay(20);
        Assert.True(Size() <= 4_000, $"{Size()} bytes kept");
    }

    [Fact]
    public void TheCap_Is10Gb_UnlessSet()
    {
        Assert.Equal(10L * 1024 * 1024 * 1024, DhanDataCache.MaxBytesOf(new ConfigurationBuilder().Build()));
        var set = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Storage:DhanCacheMaxGb"] = "2.5" }).Build();
        Assert.Equal((long)(2.5 * 1024 * 1024 * 1024), DhanDataCache.MaxBytesOf(set));
        Assert.Contains(Path.Combine("v1", "charts-rollingoption", "days", "2025-09", "15"), Cache().FileOfDay("/charts/rollingoption", new { s = 1 }, PastDay));
    }

    // ---- Gzip JSON only, and whether the cache works ----

    [Fact]
    public async Task APastDay_IsKeptAsGzipJson_Only_AndReadBackWithNoDhanCall()
    {
        var requests = new List<string>();
        var load = new OptionAnalytics.Server.Services.LoadProgress("t");
        IReadOnlyList<(CandleWithVolume Bar, decimal? Strike, decimal? Spot, long? OpenInterest, decimal? ImpliedVolatility)> bars;
        using (OptionAnalytics.Server.Services.LoadProgress.Use(load))
            (bars, _) = await Rolling(requests, Cache(), session: true).GetRollingOptionCandlesAsync("NIFTY", 13, "WEEK", 1, "ATM+3", "PUT", PastDay, PastDay, 1, CancellationToken.None);

        var file = Assert.Single(Directory.GetFiles(_dir, "*", SearchOption.AllDirectories));
        Assert.EndsWith(".json.gz", file);
        Assert.Contains(Path.Combine("v1", "charts-rollingoption", "days", "2025-09", "15"), file);
        Assert.Equal(1, JsonDocument.Parse(JsonSerializer.Serialize(load.Snapshot(0))).RootElement.GetProperty("savedToDisk").GetInt32());

        var (again, error) = await Rolling(requests, Cache(), session: false).GetRollingOptionCandlesAsync("NIFTY", 13, "WEEK", 1, "ATM+3", "PUT", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Null(error);
        Assert.Single(requests);
        Assert.Equal(bars, again);
    }

    [Fact]
    public void AFolderThatCannotBeWritten_IsSaid_AtStartAndOnEveryLoad()
    {
        var notADir = Path.Combine(Path.GetTempPath(), $"not-a-dir-{Guid.NewGuid():N}");
        File.WriteAllText(notADir, "x");
        try
        {
            var broken = new DhanDataCache(notADir, NullLogger<DhanDataCache>.Instance, () => new DateOnly(2026, 10, 12));
            Assert.False(broken.CheckFolder().Writable);
            var load = new OptionAnalytics.Server.Services.LoadProgress("t");
            using (OptionAnalytics.Server.Services.LoadProgress.Use(load))
                broken.PutDay("/charts/intraday", new { s = 1 }, PastDay, w => w.WriteRawValue("""{"close":[1],"timestamp":[1]}"""));
            Assert.Equal(1, broken.WriteErrors);
            var snapshot = JsonDocument.Parse(JsonSerializer.Serialize(load.Snapshot(0))).RootElement;
            Assert.Equal((1, 0), (snapshot.GetProperty("diskErrors").GetInt32(), snapshot.GetProperty("savedToDisk").GetInt32()));

            var good = Cache();
            Assert.True(good.CheckFolder().Writable);
            var ok = new OptionAnalytics.Server.Services.LoadProgress("u");
            using (OptionAnalytics.Server.Services.LoadProgress.Use(ok))
                good.PutDay("/charts/intraday", new { s = 1 }, PastDay, w => w.WriteRawValue("""{"close":[1],"timestamp":[1]}"""));
            Assert.Equal(1, JsonDocument.Parse(JsonSerializer.Serialize(ok.Snapshot(0))).RootElement.GetProperty("savedToDisk").GetInt32());
        }
        finally { File.Delete(notADir); }
    }

    private const string Overlay = "1061 1004 0:51 / / rw,relatime master:540 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/ABC\n" +
                                   "1062 1061 0:54 / /proc rw,nosuid - proc proc rw\n";
    private const string NamedVolume = "1080 1061 8:1 /var/lib/docker/volumes/optionanalytics_optionanalytics-data/_data /app/data rw,relatime - ext4 /dev/sda1 rw\n";

    [Fact]
    public void TheCacheFolder_IsKeptAcrossADeploy_OnlyOnAMountedVolume()
    {
        Assert.False(StorageVolume.IsPersistent("/app/data/dhan-cache", Overlay), "the container's own file system - gone at a deploy");
        Assert.True(StorageVolume.IsPersistent("/app/data/dhan-cache", Overlay + NamedVolume), "a named volume at /app/data");
        Assert.False(StorageVolume.IsPersistent("/app/database/dhan-cache", Overlay + NamedVolume), "beside the volume, not on it");
        Assert.False(StorageVolume.IsPersistent("/app/data/x", Overlay + NamedVolume + "1090 1080 0:60 / /app/data/x rw - tmpfs tmpfs rw\n"), "memory");
        Assert.True(StorageVolume.IsPersistent("/srv/my data/cache", "1 0 8:1 / / rw - overlay o rw\n2 1 8:2 / /srv/my\\040data rw - xfs /dev/sdb rw\n"));
        Assert.Null(StorageVolume.IsPersistent("/app/data", ""));
    }

    /// <summary>The (from, to) days a recorded request asked Dhan for.</summary>
    private static (DateOnly From, DateOnly To) Asked(string request)
    {
        var body = JsonNode.Parse(request[(request.IndexOf(' ') + 1)..])!;
        return (DateOnly.Parse(body["fromDate"]!.ToString()[..10]), DateOnly.Parse(body["toDate"]!.ToString()[..10]));
    }

    /// <summary>Futures bars back as Dhan's /charts/intraday answer.</summary>
    private static string WholeWindowJson(IReadOnlyList<(CandleWithVolume Bar, long? OpenInterest)> bars) => new JsonObject
    {
        ["open"] = new JsonArray(bars.Select(b => (JsonNode)JsonValue.Create(b.Bar.Open)!).ToArray()),
        ["high"] = new JsonArray(bars.Select(b => (JsonNode)JsonValue.Create(b.Bar.High)!).ToArray()),
        ["low"] = new JsonArray(bars.Select(b => (JsonNode)JsonValue.Create(b.Bar.Low)!).ToArray()),
        ["close"] = new JsonArray(bars.Select(b => (JsonNode)JsonValue.Create(b.Bar.Close)!).ToArray()),
        ["volume"] = new JsonArray(bars.Select(b => (JsonNode)JsonValue.Create(b.Bar.Volume)!).ToArray()),
        ["timestamp"] = new JsonArray(bars.Select(b => (JsonNode)JsonValue.Create(b.Bar.Time.ToUnixTimeSeconds())!).ToArray()),
        ["open_interest"] = new JsonArray(bars.Select(b => (JsonNode)JsonValue.Create(b.OpenInterest ?? 0)!).ToArray()),
    }.ToJsonString();

    private static DhanApiClient Api(List<string> requests, bool session, int bars, bool thin = false, Func<DateOnly, int>? barsOn = null)
    {
        var options = Options.Create(new DhanOptions { RestBaseUrl = "https://dhan.test", AccessToken = session ? "t" : "", ClientId = "c", DataApiRequestsPerSecond = 200 });
        var dhan = new FakeDhan(requests, barsOn ?? (d => d.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday ? 0 : bars), thin);
        return new DhanApiClient(new HttpClient(dhan), options, new DhanSession(options), NullLogger<DhanApiClient>.Instance);
    }

    private static DhanHistoricalDataService Historical(List<string> requests, DhanDataCache cache, bool session, int bars = 375, bool thin = false, Func<DateOnly, int>? barsOn = null)
    {
        var api = Api(requests, session, bars, thin, barsOn);
        return new DhanHistoricalDataService(api, NullLogger<DhanHistoricalDataService>.Instance, cache);
    }

    private static DhanRollingOptionDataService Rolling(List<string> requests, DhanDataCache cache, bool session, bool thin = false)
    {
        var api = Api(requests, session, 375, thin);
        return new DhanRollingOptionDataService(api, NullLogger<DhanRollingOptionDataService>.Instance, cache);
    }

    /// <summary>Dhan's answer for the request's window: each day's 1-minute bars from 09:15 IST (`barsOn` of them - none
    /// on a weekend), as Dhan sends them: intraday as parallel arrays (with open_interest), the rolling option chain under
    /// data.ce / data.pe (its toDate the day after). `thin`: a strike that did not trade every other minute - those
    /// minutes sent at a 0 price, as Dhan does.</summary>
    private sealed class FakeDhan(List<string> requests, Func<DateOnly, int> barsOn, bool thin = false) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!;
            lock (requests) requests.Add($"{request.RequestUri!.AbsolutePath} {body.ToJsonString()}");
            var rolling = request.RequestUri.AbsolutePath.EndsWith("rollingoption");
            var from = DateOnly.Parse(body["fromDate"]!.ToString()[..10]);
            var to = DateOnly.Parse(body["toDate"]!.ToString()[..10]).AddDays(rolling ? -1 : 0);
            var minutes = new List<(long Time, int I)>();
            for (var d = from; d <= to; d = d.AddDays(1))
            {
                var open = new DateTimeOffset(d.Year, d.Month, d.Day, 9, 15, 0, TimeSpan.FromMinutes(330)).ToUnixTimeSeconds();
                for (var i = 0; i < barsOn(d); i++) minutes.Add((open + 60 * i, i));
            }
            JsonArray Arr(Func<int, double> f) => new(minutes.Select(m => (JsonNode)JsonValue.Create(f(m.I))!).ToArray());
            // A price array of a thin strike: 0 in the minutes it did not trade.
            JsonArray Px(Func<int, double> f) => Arr(i => thin && i % 2 == 0 ? 0 : f(i));
            JsonArray Stamps() => new(minutes.Select(m => (JsonNode)JsonValue.Create(m.Time)!).ToArray());
            var series = new JsonObject
            {
                ["open"] = Px(i => 100 + i), ["high"] = Px(i => 101 + i), ["low"] = Px(i => 99 + i), ["close"] = Px(i => 100.5 + i),
                ["volume"] = Arr(_ => 10), ["timestamp"] = Stamps(), ["open_interest"] = Arr(i => 1000 + i),
            };
            JsonNode json = rolling
                ? new JsonObject
                {
                    ["data"] = new JsonObject
                    {
                        [body["drvOptionType"]!.ToString() == "PUT" ? "pe" : "ce"] = new JsonObject
                        {
                            ["open"] = Px(i => 50 + i * 0.1), ["high"] = Px(i => 51 + i * 0.1), ["low"] = Px(i => 49 + i * 0.1), ["close"] = Px(i => 50.5 + i * 0.1),
                            ["volume"] = Arr(_ => 5), ["timestamp"] = Stamps(), ["oi"] = Arr(i => 2000 + i), ["iv"] = Arr(_ => 12),
                            ["strike"] = Arr(_ => 25000), ["spot"] = Arr(_ => 25010),
                        },
                    },
                }
                : series;
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json.ToJsonString(), Encoding.UTF8, "application/json") };
        }
    }
}
