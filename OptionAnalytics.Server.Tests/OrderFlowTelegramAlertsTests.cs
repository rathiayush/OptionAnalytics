using System.Net;
using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Controllers;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services.OrderFlow;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Tests;

/// <summary>The server's iceberg / big order Telegram (OrderFlowTelegramAlerts / OrderFlowAlertWatch): an iceberg once at its
/// threshold - never twice, not after a restart, not an old one on the first look - big prints after the last one seen only,
/// gathered at most every 20 s; the thresholds per index; and the Telegram message log every message lands in.</summary>
public sealed class OrderFlowTelegramAlertsTests : IDisposable
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 12, 4, 30, 0, TimeSpan.Zero);   // 10:00 IST
    private static readonly DateOnly Day = new(2026, 11, 12);
    private const int Lot = 75;
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "of-alerts-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch (IOException) { }
    }

    private static OrderFlowIceberg Ice(bool bid, decimal price, long tradedLots, DateTimeOffset start, bool ended = false, int refills = 3) =>
        new(1, bid, price, start, start.AddSeconds(30), start.AddMinutes(1), ended ? start.AddMinutes(2) : null, tradedLots * Lot, 15 * Lot, refills);

    private static OrderFlowTrade Print(long seq, bool buy, long lots, decimal price, DateTimeOffset at) => new(seq, at, price, lots * Lot, buy);

    private static OrderFlowAlertReads Reads(long lastSeq, IEnumerable<OrderFlowTrade>? trades = null, IEnumerable<OrderFlowIceberg>? icebergs = null) =>
        new(Day, Lot, lastSeq, (trades ?? Array.Empty<OrderFlowTrade>()).ToList(), (icebergs ?? Array.Empty<OrderFlowIceberg>()).ToList());

    private static readonly OrderFlowAlertLimits Limits = new("NIFTY", 100, 100);

    [Fact]
    public void An_iceberg_is_sent_once_when_it_reaches_its_lots_and_an_old_one_is_not_news()
    {
        var watch = new OrderFlowAlertWatch();
        var old = Ice(false, 24600, 300, T0.AddMinutes(-40), ended: true);
        var small = Ice(true, 24500, 40, T0.AddMinutes(-5));
        // First look: the ended one is marked without a message; the small one is under 100 lots.
        Assert.Empty(watch.Step("NIFTY", 35001, Reads(10, icebergs: new[] { old, small }), Limits, T0, out var changed));
        Assert.True(changed);
        // It grows past 100 lots: one message, at the bid - a hidden buyer.
        var grown = small with { Traded = 120 * Lot };
        var sent = watch.Step("NIFTY", 35001, Reads(10, icebergs: new[] { old, grown }), Limits, T0.AddSeconds(2), out _);
        var text = Assert.Single(sent);
        Assert.Equal("🧊 Iceberg NIFTY futures: hidden BUYER at the bid 24500 · 120 lots traded there (15 shown at most) · 3 refills · still active · 10:00:02", text);
        // Never again, however much more it trades.
        Assert.Empty(watch.Step("NIFTY", 35001, Reads(10, icebergs: new[] { grown with { Traded = 900 * Lot } }), Limits, T0.AddSeconds(4), out _));
        // A restart that kept the day's keys sends none again; one that did not (or a new day) would.
        var restarted = new OrderFlowAlertWatch();
        restarted.Restore(Day, watch.SentKeys);
        Assert.Empty(restarted.Step("NIFTY", 35001, Reads(10, icebergs: new[] { grown }), Limits, T0.AddSeconds(6), out _));
        Assert.Single(new OrderFlowAlertWatch().Step("NIFTY", 35001, Reads(10, icebergs: new[] { grown }), Limits, T0, out _));
        // Off for the index (0 lots): nothing.
        Assert.Empty(new OrderFlowAlertWatch().Step("NIFTY", 35001, Reads(10, icebergs: new[] { grown }), Limits with { IcebergLots = 0 }, T0, out _));
    }

    [Fact]
    public void Big_orders_after_the_last_print_seen_only_gathered_at_most_every_20_seconds()
    {
        var watch = new OrderFlowAlertWatch();
        // First look: only learns where the prints are - a restart does not send the morning's.
        Assert.Empty(watch.Step("NIFTY", 35001, Reads(50), Limits, T0, out _));
        Assert.Equal(50, watch.AfterSeq("NIFTY", 35001, Day));
        var one = watch.Step("NIFTY", 35001, Reads(52, new[] { Print(51, true, 150, 24512.5m, T0.AddSeconds(1)), Print(52, false, 40, 24512m, T0.AddSeconds(1)) }), Limits, T0.AddSeconds(2), out _);
        Assert.Equal("🐋 Big order NIFTY futures: BUY 150 lots @ 24512.5 · 10:00:01", Assert.Single(one));   // the 40-lot print is not big
        // Within 20 s: gathered, not sent...
        Assert.Empty(watch.Step("NIFTY", 35001, Reads(54, new[] { Print(53, false, 120, 24510m, T0.AddSeconds(5)), Print(54, true, 200, 24511m, T0.AddSeconds(6)) }), Limits, T0.AddSeconds(8), out _));
        // ...then one message with both, and what was bought / sold.
        var many = Assert.Single(watch.Step("NIFTY", 35001, Reads(54), Limits, T0.AddSeconds(23), out _));
        Assert.Equal("🐋 Big orders NIFTY futures: 2 prints - bought 200 lots, sold 120 lots\nSELL 120 lots @ 24510 · 10:00:05\nBUY 200 lots @ 24511 · 10:00:06", many);
        // A print already seen is never sent again; a new contract / day starts over.
        Assert.Empty(watch.Step("NIFTY", 35001, Reads(54, new[] { Print(54, true, 200, 24511m, T0.AddSeconds(6)) }), Limits, T0.AddSeconds(50), out _));
        Assert.Null(watch.AfterSeq("NIFTY", 35002, Day));
        // More than ten in one message: the first ten and how many more.
        var burst = Enumerable.Range(0, 13).Select(k => Print(100 + k, true, 100, 24500 + k, T0.AddSeconds(k))).ToList();
        var text = OrderFlowAlertWatch.BigOrderText("NIFTY", burst, Lot);
        Assert.Equal(1 + 10 + 1, text.Split('\n').Length);
        Assert.EndsWith("… and 3 more", text);
    }

    [Fact]
    public void The_engine_hands_the_watch_the_prints_after_a_sequence_and_its_icebergs()
    {
        var engine = new OrderFlowEngine("NIFTY", 35001, "NIFTY-Nov2026-FUT", "NSE_FNO", 0.05m, Lot);
        var tick = (decimal price, long volume, DateTimeOffset at) => new SpotTick(35001, price, 0, 0, 0, 0, volume, price - 0.05m, price, 0, at)
        {
            Bids = new[] { new DepthLevel(price - 0.05m, 750, 5) }, Asks = new[] { new DepthLevel(price, 750, 5) },
        };
        engine.OnTick(tick(24500m, 1000, T0), T0);
        engine.OnTick(tick(24500.05m, 1000 + 200 * Lot, T0.AddSeconds(1)), T0.AddSeconds(1));   // a 200-lot print
        engine.OnTick(tick(24500.10m, 1000 + 210 * Lot, T0.AddSeconds(2)), T0.AddSeconds(2));   // 10 lots
        var all = engine.AlertReads(0, 1);
        Assert.Equal(Day, all.Day);
        Assert.Equal(Lot, all.LotSize);
        Assert.Equal(2, all.Trades.Count);
        var big = engine.AlertReads(0, 100L * Lot);
        Assert.Equal(200L * Lot, Assert.Single(big.Trades).Quantity);
        Assert.Empty(engine.AlertReads(all.LastSeq, 1).Trades);
        Assert.Empty(engine.AlertReads(long.MaxValue, 1).Trades);                          // the first look reads none
        Assert.Equal(all.LastSeq, engine.AlertReads(long.MaxValue, 1).LastSeq);
    }

    [Fact]
    public void The_thresholds_per_index_default_and_saved_with_0_for_off()
    {
        var store = new OrderFlowAlertSettingsStore(Path.Combine(_dir, "order-flow-alerts.json"));
        Assert.Equal(new[] { "NIFTY", "BANKNIFTY", "SENSEX" }, store.All().Select(x => x.Underlying));
        Assert.All(store.All(), x => Assert.Equal((100, 100), (x.IcebergLots, x.BigOrderLots)));
        var (saved, error) = store.Save("banknifty", 50, 0);
        Assert.Null(error);
        Assert.Equal((50, 0), (saved!.IcebergLots, saved.BigOrderLots));
        Assert.Equal((50, 0), (store.Get("BANKNIFTY").IcebergLots, store.Get("BANKNIFTY").BigOrderLots));
        Assert.Equal(100, new OrderFlowAlertSettingsStore(Path.Combine(_dir, "order-flow-alerts.json")).Get("NIFTY").BigOrderLots);
        Assert.NotNull(store.Save("FTSE", 1, 1).Error);
        Assert.NotNull(store.Save("NIFTY", -1, 1).Error);
        // Admin only to change them; Admin / User to read.
        var put = typeof(OrderFlowAlertsController).GetMethod(nameof(OrderFlowAlertsController.Put))!.GetCustomAttribute<AuthorizeAttribute>();
        Assert.Equal(AuthRoles.Admin, put!.Roles);
        Assert.Equal($"{AuthRoles.Admin},{AuthRoles.User}", typeof(OrderFlowAlertsController).GetCustomAttribute<AuthorizeAttribute>()!.Roles);
    }

    [Fact]
    public async Task Every_message_lands_in_the_Telegram_log_with_how_it_went_and_reads_back_as_text()
    {
        var now = new DateTimeOffset(2026, 11, 12, 10, 5, 0, IstClock.Offset);
        var log = new TelegramMessageLog(Path.Combine(_dir, "telegram-log"), NullLogger<TelegramMessageLog>.Instance, () => now);
        // Not configured: kept as "off" (what would have gone).
        var off = new TelegramAlertService(new HttpClient(), Options.Create(new TelegramOptions()), NullLogger<TelegramAlertService>.Instance, log);
        await off.SendAsync("[Server] 🧱 <b>NIFTY</b> OI PE broke &amp; held 🟢\nline two, with \"quotes\" and a \\ slash", CancellationToken.None);
        // Configured: sent / failed by Telegram's answer.
        var configured = Options.Create(new TelegramOptions { Enabled = true, BotToken = "t", ChatId = "c", ApiBaseUrl = "http://telegram.test" });
        var ok = new TelegramAlertService(new HttpClient(new Answer(HttpStatusCode.OK)), configured, NullLogger<TelegramAlertService>.Instance, log);
        now = now.AddMinutes(1);
        await ok.SendAsync("=SUM(A1) 🐋 Big order", CancellationToken.None);
        var bad = new TelegramAlertService(new HttpClient(new Answer(HttpStatusCode.BadRequest)), configured, NullLogger<TelegramAlertService>.Instance, log);
        await bad.SendAsync("failed one", CancellationToken.None);

        var read = log.Read(new DateOnly(2026, 11, 12), new DateOnly(2026, 11, 12));
        Assert.Equal(new[] { "off", "sent", "failed" }, read.Select(x => x.Status));
        Assert.Equal("[Server] 🧱 NIFTY OI PE broke & held 🟢\nline two, with \"quotes\" and a \\ slash", read[0].Text);   // one line on disk, the text back whole
        Assert.Equal("=SUM(A1) 🐋 Big order", read[1].Text);                                                           // kept as text, given back as sent
        Assert.Equal(now.AddMinutes(-1).UtcDateTime, read[0].Time.UtcDateTime);
        Assert.Single(File.ReadAllLines(Path.Combine(_dir, "telegram-log", "2026-11-12.csv")), l => l.Contains("line two"));
        Assert.Empty(log.Read(new DateOnly(2026, 11, 11), new DateOnly(2026, 11, 11)));
        // Admin / User only.
        Assert.Equal($"{AuthRoles.Admin},{AuthRoles.User}", typeof(TelegramLogController).GetCustomAttribute<AuthorizeAttribute>()!.Roles);
    }

    private sealed class Answer(HttpStatusCode status) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent("{}") });
    }
}
