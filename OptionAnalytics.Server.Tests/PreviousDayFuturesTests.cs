using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>OI Replay's futures chart draws the PREVIOUS session's volume profile: the nearest earlier trading day's bars
/// of the same contract (OiReplayService.PreviousDayFuturesBarsAsync) - weekends skipped, a holiday stepped over.</summary>
public sealed class PreviousDayFuturesTests
{
    private static readonly DhanFuturesInstrument Live = new(48699, "NIFTY-Nov2026-FUT", "NIFTY", IstClock.Today().AddDays(30), "NSE_FNO", 75, 0.1m);
    private static Task<IReadOnlyList<DhanFuturesInstrument>> NoneListed(DateOnly _) => Task.FromResult<IReadOnlyList<DhanFuturesInstrument>>(Array.Empty<DhanFuturesInstrument>());

    [Fact]
    public async Task The_day_before_is_used_when_it_traded()
    {
        var (historical, asked) = Dhan(new DateOnly(2026, 10, 19), new DateOnly(2026, 10, 16));

        var found = await OiReplayService.PreviousDayFuturesBarsAsync(historical, Live, new DateOnly(2026, 10, 20), NoneListed, null, CancellationToken.None);

        Assert.NotNull(found);
        Assert.Equal(new DateOnly(2026, 10, 19), found.Value.Day);
        Assert.Equal(48699u, found.Value.Fetched.Contract.SecurityId);
        Assert.Equal(2, found.Value.Fetched.Bars.Count);
        Assert.Equal(new[] { "2026-10-19" }, asked);
    }

    [Fact]
    public async Task A_weekend_and_a_holiday_are_stepped_over()
    {
        // Tuesday 20 Oct; Monday 19 Oct a holiday (no bars), the weekend never asked - Friday 16 Oct.
        var (historical, asked) = Dhan(new DateOnly(2026, 10, 16));

        var found = await OiReplayService.PreviousDayFuturesBarsAsync(historical, Live, new DateOnly(2026, 10, 20), NoneListed, null, CancellationToken.None);

        Assert.Equal(new DateOnly(2026, 10, 16), found?.Day);
        Assert.Equal(new[] { "2026-10-19", "2026-10-16" }, asked);
    }

    [Fact]
    public async Task Nothing_in_the_last_week_is_null()
    {
        var (historical, _) = Dhan();

        Assert.Null(await OiReplayService.PreviousDayFuturesBarsAsync(historical, Live, new DateOnly(2026, 10, 20), NoneListed, null, CancellationToken.None));
    }

    // A fake Dhan with two 1-minute bars on each of `traded` (asked dates recorded) and none on any other day.
    private static (DhanHistoricalDataService Historical, List<string> Asked) Dhan(params DateOnly[] traded)
    {
        var asked = new List<string>();
        var options = Options.Create(new DhanOptions { RestBaseUrl = "https://dhan.test", AccessToken = "t", ClientId = "c" });
        var api = new DhanApiClient(new HttpClient(new Handler(traded.ToHashSet(), asked)), options, new DhanSession(options), NullLogger<DhanApiClient>.Instance);
        return (new DhanHistoricalDataService(api, NullLogger<DhanHistoricalDataService>.Instance), asked);
    }

    private sealed class Handler(HashSet<DateOnly> traded, List<string> asked) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!;
            var day = DateOnly.ParseExact(body["fromDate"]!.ToString()[..10], "yyyy-MM-dd", CultureInfo.InvariantCulture);
            lock (asked) asked.Add($"{day:yyyy-MM-dd}");
            var ts = new DateTimeOffset(day.ToDateTime(new TimeOnly(9, 15)), IstClock.Offset).ToUnixTimeSeconds();
            JsonNode json = traded.Contains(day)
                ? new JsonObject { ["open"] = new JsonArray(100, 101), ["high"] = new JsonArray(102, 103), ["low"] = new JsonArray(99, 100), ["close"] = new JsonArray(101, 102), ["volume"] = new JsonArray(10, 20), ["timestamp"] = new JsonArray(ts, ts + 60) }
                : new JsonObject { ["open"] = new JsonArray(), ["high"] = new JsonArray(), ["low"] = new JsonArray(), ["close"] = new JsonArray(), ["volume"] = new JsonArray(), ["timestamp"] = new JsonArray() };
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json.ToJsonString(), Encoding.UTF8, "application/json") };
        }
    }
}
