using System.Net;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// Regression coverage for the restart race this session's live-debugging session found: a fresh
/// process's own silent startup seed (SeedDirection) runs synchronously, before
/// SpotFeedHostedService's ASYNC historical backfill (a real Dhan REST round trip) has necessarily
/// completed - so it frequently seeds nothing, and the first bar that closes afterward would, pre-fix,
/// be misreported as a brand new crossover even when it's really just this process re-learning a
/// direction that was already established before the restart.
///
/// SpotFeedHostedService/TelegramAlertService are constructed directly here rather than mocked -
/// both are plain classes whose constructors only assign fields (no dependency is touched until a
/// method is actually called), so a real instance with unused dependencies left null is exactly as
/// good as a mock for this test's purposes, and exercises the REAL SpotUnderlyingState.BarClosed
/// wiring rather than a hand-rolled stand-in for it.
/// </summary>
public sealed class EmaCrossoverAlertServiceTests
{
    private sealed class RecordingHandler : HttpMessageHandler
    {
        public int SendCount { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            SendCount++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
        }
    }

    private static SpotFeedHostedService CreateSpotFeed() => new(
        Options.Create(new DhanOptions()),
        null!, null!, null!, null!, null!,
        NullLogger<SpotFeedHostedService>.Instance);

    private static (EmaCrossoverAlertService Service, RecordingHandler Handler) CreateService(SpotFeedHostedService spotFeed)
    {
        var handler = new RecordingHandler();
        var telegram = new TelegramAlertService(
            new HttpClient(handler),
            Options.Create(new TelegramOptions { Enabled = true, BotToken = "test-token", ChatId = "123" }),
            NullLogger<TelegramAlertService>.Instance);
        var service = new EmaCrossoverAlertService(spotFeed, telegram, NullLogger<EmaCrossoverAlertService>.Instance);
        return (service, handler);
    }

    // Sends one tick per minute (so every tick but the last closes the previous bar), each tick's
    // price a flat move from the last - a clean, unbroken trend, same "no ambiguity" reasoning the
    // other strategies' own EMA tests use.
    private static void FeedTrend(SpotUnderlyingState state, ref DateTimeOffset time, ref decimal price, decimal stepPerBar, int bars)
    {
        for (var i = 0; i < bars; i++)
        {
            price += stepPerBar;
            state.ApplyTick(new SpotTick(0, price, price, price, price, price, 0, 0, 0, time));
            time = time.AddMinutes(1);
        }
    }

    [Fact]
    public async Task OnBarClosed_FirstEverConfirmedDirection_DoesNotAlert()
    {
        var spotFeed = CreateSpotFeed();
        var (service, handler) = CreateService(spotFeed);
        // No SeedHistory call at all - simulates the exact race: this underlying's backfill hasn't
        // finished by the time the service's own startup seed pass runs.
        await service.StartAsync(CancellationToken.None);

        var time = new DateTimeOffset(2026, 1, 5, 4, 0, 0, TimeSpan.Zero); // 09:30 IST
        var price = 20000m;
        // Comfortably more than the 22 closed bars EMA9/21 needs to confirm at all - a clean,
        // one-directional rally so the very first confirmation this process ever sees is Bullish.
        FeedTrend(spotFeed.States["NIFTY"], ref time, ref price, stepPerBar: 5, bars: 40);

        Assert.Equal(0, handler.SendCount);
    }

    [Fact]
    public async Task OnBarClosed_GenuineDirectionChangeAfterFirstObservation_Alerts()
    {
        var spotFeed = CreateSpotFeed();
        var (service, handler) = CreateService(spotFeed);
        await service.StartAsync(CancellationToken.None);

        var time = new DateTimeOffset(2026, 1, 5, 4, 0, 0, TimeSpan.Zero);
        var price = 20000m;
        var state = spotFeed.States["NIFTY"];

        FeedTrend(state, ref time, ref price, stepPerBar: 5, bars: 40); // establishes Bullish - the baseline, silent
        Assert.Equal(0, handler.SendCount);

        FeedTrend(state, ref time, ref price, stepPerBar: -8, bars: 40); // a real, later reversal to Bearish

        Assert.Equal(1, handler.SendCount);
    }
}
