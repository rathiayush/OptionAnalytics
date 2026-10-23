using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;
using Xunit;

namespace OptionAnalytics.Server.Tests;

/// <summary>TODAY's OI Replay option series: the rolling (expired-options) endpoint takes whole days with a non-inclusive
/// toDate, so today needed toDate = tomorrow - a future date Dhan refused with DH-905 Input_Exception (seen on the Dhan
/// calls page). Today's series is each contract's own /charts/intraday candles with OI, toDate capped at now.</summary>
public class TodayOptionSeriesTests
{
    private sealed class RecordingDhan : HttpMessageHandler
    {
        public List<(string Path, JsonObject Body)> Requests { get; } = new();
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add((request.RequestUri!.AbsolutePath, JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!.AsObject()));
            var t = DateTimeOffset.UtcNow.AddMinutes(-5).ToUnixTimeSeconds() / 60 * 60;
            var body = $"{{\"open\":[100],\"high\":[101],\"low\":[99],\"close\":[100.5],\"volume\":[1200],\"timestamp\":[{t}],\"open_interest\":[45000]}}";
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        }
    }

    [Fact]
    public async Task Today_s_option_contract_is_asked_of_the_intraday_endpoint_with_OI_and_never_a_future_toDate()
    {
        var options = Options.Create(new DhanOptions { RestBaseUrl = "https://dhan.test", AccessToken = "t", ClientId = "c", DataApiRequestsPerSecond = 200 });
        var dhan = new RecordingDhan();
        var api = new DhanApiClient(new HttpClient(dhan), options, new DhanSession(options), NullLogger<DhanApiClient>.Instance);
        var history = new DhanHistoricalDataService(api, NullLogger<DhanHistoricalDataService>.Instance);
        var today = IstClock.Today();

        var (bars, oiPresent, error) = await history.GetIntradayOptionCandlesWithOiAsync(52175, "NSE_FNO", today, today, 1, CancellationToken.None);

        Assert.Null(error);
        Assert.True(oiPresent);
        Assert.Equal(45000, Assert.Single(bars).OpenInterest);
        var (path, body) = Assert.Single(dhan.Requests);
        Assert.Equal("/charts/intraday", path);
        Assert.Equal(("52175", "NSE_FNO", "OPTIDX", true), (body["securityId"]!.GetValue<string>(), body["exchangeSegment"]!.GetValue<string>(),
            body["instrument"]!.GetValue<string>(), body["oi"]!.GetValue<bool>()));
        var toDate = DateTime.Parse(body["toDate"]!.GetValue<string>(), System.Globalization.CultureInfo.InvariantCulture);
        Assert.True(toDate <= DateTimeOffset.UtcNow.ToOffset(IstClock.Offset).DateTime.AddMinutes(1), $"toDate {toDate} is in the future");
        Assert.Equal(today, DateOnly.FromDateTime(toDate));
    }

    [Theory]
    [InlineData("ATM", 0)]
    [InlineData("ATM+3", 3)]
    [InlineData("ATM-10", -10)]
    [InlineData("ATM+10", 10)]
    public void A_strike_token_is_its_steps_from_the_money(string token, int steps) =>
        Assert.Equal(steps, OiReplayService.TokenSteps(token));
}
