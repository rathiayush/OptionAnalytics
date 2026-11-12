using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Tests;

/// <summary>The Telegram signals page's load, SERVER FIRST (TelegramSignalMessages): a day the server's log holds whole is read
/// from it (Telegram not asked); a day before the log from the days fetched from Telegram before, else fetched from
/// Telegram - the missing days only, consecutive ones in one request - and a whole past day kept (an empty one too), today
/// not; a second load asks Telegram nothing; Telegram not connected = those days missing with why, the rest still there,
/// asked once; a fetch cut short at MaxMessages not kept. And the log's start mark: since it first ran, kept through a
/// restart, a log that ran before the mark counted from the day after its first file.</summary>
public sealed class TelegramSignalMessagesTests : IDisposable
{
    private static readonly DateOnly Today = new(2026, 11, 12);
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "tg-signals-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch (IOException) { }
    }

    private static DateTimeOffset Ist(DateOnly day, int h, int m) => new(day.Year, day.Month, day.Day, h, m, 0, IstClock.Offset);

    private (TelegramMessageLog Log, TelegramDayCache Cache) Stores(DateTimeOffset logStarted)
    {
        var now = logStarted;
        var log = new TelegramMessageLog(Path.Combine(_dir, "log"), NullLogger<TelegramMessageLog>.Instance, () => now);
        return (log, new TelegramDayCache(Path.Combine(_dir, "log", "from-telegram"), NullLogger<TelegramDayCache>.Instance));
    }

    private async Task<TelegramChannelReader> Connected(Channel channel)
    {
        var reader = new TelegramChannelReader(channel, new TelegramOptions { ChatId = "-1001" }, Path.Combine(_dir, "session"), NullLogger<TelegramChannelReader>.Instance);
        await reader.ConnectAsync(1, "0123456789abcdef0123456789abcdef", "+919876543210", default);
        await reader.ContinueAsync("12345", default);
        return reader;
    }

    [Fact]
    public async Task Each_day_comes_from_the_server_first_then_the_cache_then_Telegram_and_a_fetched_past_day_is_kept()
    {
        // The log has run since 10 Nov 08:00 IST: 10, 11 and 12 Nov are the server's; 6 - 9 Nov are not.
        var (log, cache) = Stores(Ist(new DateOnly(2026, 11, 10), 8, 0));
        var nov11 = new DateOnly(2026, 11, 11);
        var channel = new Channel(
            new TelegramChannelMessage(1, Ist(new DateOnly(2026, 11, 6), 10, 0), "🧊 Iceberg NIFTY futures: hidden BUYER at the bid 24500"),
            new TelegramChannelMessage(2, Ist(new DateOnly(2026, 11, 9), 11, 0), "[OI divergence] NIFTY DISCOUNT zone"),
            new TelegramChannelMessage(3, Ist(nov11, 10, 0), "on Telegram only - the log is read for this day"));
        using var reader = await Connected(channel);
        // A day of the log (written as the server sends - a different clock for each).
        var logAt = Ist(nov11, 10, 5);
        var writer = new TelegramMessageLog(Path.Combine(_dir, "log"), NullLogger<TelegramMessageLog>.Instance, () => logAt);
        writer.Record("[Server] 🧱 <b>NIFTY</b> OI PE broke 🟢", "sent");
        writer.Record("🐋 Big order NIFTY futures: BUY 150 lots @ 24512.5 · 10:05:00", "failed");

        var signals = new TelegramSignalMessages(log, cache, reader, () => Today);
        var read = await signals.ReadAsync(new DateOnly(2026, 11, 6), Today, default);

        Assert.Equal(new[] { "telegram", "telegram", "telegram", "telegram", "server", "server", "server" }, read.Days.Select(d => d.Source));
        Assert.Equal(new[] { (new DateOnly(2026, 11, 6), new DateOnly(2026, 11, 9)) }, channel.Asked);   // one request: the run not on the server
        Assert.Equal(new[] { "🧊 Iceberg NIFTY futures: hidden BUYER at the bid 24500", "[OI divergence] NIFTY DISCOUNT zone", "[Server] 🧱 NIFTY OI PE broke 🟢", "🐋 Big order NIFTY futures: BUY 150 lots @ 24512.5 · 10:05:00" },
            read.Messages.Select(m => m.Text));
        Assert.Equal(new[] { "sent", "sent", "sent", "failed" }, read.Messages.Select(m => m.Status));       // the log's own statuses
        Assert.Equal(new[] { 1, 0, 0, 1 }, read.Days.Take(4).Select(d => d.Count));                             // the weekend kept empty

        // Again: every day from the server (the log, and the days fetched before) - Telegram asked nothing.
        var again = await signals.ReadAsync(new DateOnly(2026, 11, 6), Today, default);
        Assert.Equal(new[] { "cache", "cache", "cache", "cache", "server", "server", "server" }, again.Days.Select(d => d.Source));
        Assert.Single(channel.Asked);
        Assert.Equal(read.Messages.Select(m => m.Text), again.Messages.Select(m => m.Text));
    }

    [Fact]
    public async Task Today_not_on_the_server_is_fetched_each_time_and_not_kept()
    {
        var (log, cache) = Stores(Ist(Today, 11, 0));        // the log began after today's open: today is not whole
        var channel = new Channel(new TelegramChannelMessage(1, Ist(Today, 9, 30), "🎯 HIGH PROBABILITY BULLISH · NIFTY at 09:30"));
        using var reader = await Connected(channel);
        var signals = new TelegramSignalMessages(log, cache, reader, () => Today);
        Assert.Equal("telegram", (await signals.ReadAsync(Today, Today, default)).Days.Single().Source);
        Assert.Equal("telegram", (await signals.ReadAsync(Today, Today, default)).Days.Single().Source);
        Assert.Equal(2, channel.Asked.Count);
        Assert.Null(cache.Read(Today));
    }

    [Fact]
    public async Task Telegram_not_connected_leaves_those_days_missing_with_why_and_is_asked_once()
    {
        var (log, cache) = Stores(Ist(new DateOnly(2026, 11, 10), 8, 0));
        cache.Write(new DateOnly(2026, 11, 3), [new TelegramChannelMessage(9, Ist(new DateOnly(2026, 11, 3), 10, 0), "kept")], Today);
        var reader = new TelegramChannelReader(new Channel(), new TelegramOptions { ChatId = "-1001" }, Path.Combine(_dir, "session"), NullLogger<TelegramChannelReader>.Instance);
        var signals = new TelegramSignalMessages(log, cache, reader, () => Today);
        var read = await signals.ReadAsync(new DateOnly(2026, 11, 2), new DateOnly(2026, 11, 11), default);
        var byDay = read.Days.ToDictionary(d => d.Date);
        Assert.Equal("cache", byDay[new DateOnly(2026, 11, 3)].Source);
        Assert.Equal("server", byDay[new DateOnly(2026, 11, 10)].Source);
        Assert.Equal("missing", byDay[new DateOnly(2026, 11, 2)].Source);
        Assert.Equal("missing", byDay[new DateOnly(2026, 11, 9)].Source);
        Assert.Contains("not connected", byDay[new DateOnly(2026, 11, 9)].Note);
        Assert.Equal(new[] { "kept" }, read.Messages.Select(m => m.Text));
        Assert.Null(cache.Read(new DateOnly(2026, 11, 9)));                                   // nothing kept for a day not read
    }

    [Fact]
    public async Task A_fetch_cut_short_at_the_message_cap_is_not_kept()
    {
        var (log, cache) = Stores(Ist(Today, 8, 0));
        var day = new DateOnly(2026, 11, 10);
        var many = Enumerable.Range(0, TelegramChannelReader.MaxMessages)
            .Select(k => new TelegramChannelMessage(k, Ist(day, 9, 15).AddSeconds(k), $"m{k}")).ToArray();
        using var reader = await Connected(new Channel(many));
        var read = await new TelegramSignalMessages(log, cache, reader, () => Today).ReadAsync(new DateOnly(2026, 11, 9), new DateOnly(2026, 11, 11), default);
        Assert.Equal(new[] { "partial", "partial", "telegram" }, read.Days.Select(d => d.Source));
        Assert.Null(cache.Read(day));
        Assert.NotNull(cache.Read(new DateOnly(2026, 11, 11)));
    }

    [Fact]
    public void The_logs_start_mark_is_kept_and_a_log_from_before_it_counts_from_the_day_after_its_first_file()
    {
        var root = Path.Combine(_dir, "mark");
        var started = Ist(new DateOnly(2026, 11, 10), 8, 30);
        var log = new TelegramMessageLog(root, NullLogger<TelegramMessageLog>.Instance, () => started);
        Assert.True(log.Covers(new DateOnly(2026, 11, 10)));                 // running before 09:00
        Assert.False(log.Covers(new DateOnly(2026, 11, 9)));
        var restarted = new TelegramMessageLog(root, NullLogger<TelegramMessageLog>.Instance, () => started.AddDays(3));
        Assert.Equal(started, restarted.CoveredFrom);                          // kept through a restart

        var old = Path.Combine(_dir, "old");
        Directory.CreateDirectory(old);
        File.WriteAllText(Path.Combine(old, "2026-11-05.csv"), "time_ist,time_utc,status,text\n");
        var before = new TelegramMessageLog(old, NullLogger<TelegramMessageLog>.Instance, () => started);
        Assert.False(before.Covers(new DateOnly(2026, 11, 5)));               // its first day may have begun before it
        Assert.True(before.Covers(new DateOnly(2026, 11, 6)));
    }

    [Fact]
    public void Missing_days_are_asked_in_runs_of_consecutive_days()
    {
        var d = new DateOnly(2026, 11, 1);
        var days = new[] { d, d.AddDays(1), d.AddDays(2), d.AddDays(5), d.AddDays(6) };
        Assert.Equal(new[] { (d, d.AddDays(2)), (d.AddDays(5), d.AddDays(6)) }, TelegramSignalMessages.Runs(days, 31));
        Assert.Equal(new[] { (d, d.AddDays(1)), (d.AddDays(2), d.AddDays(2)), (d.AddDays(5), d.AddDays(6)) }, TelegramSignalMessages.Runs(days, 2));
    }

    /// <summary>A channel on a fake Telegram: signs in with code 12345, gives its messages in [from, to) and counts what it
    /// was asked (as IST days).</summary>
    private sealed class Channel(params TelegramChannelMessage[] messages) : ITelegramUserClientFactory
    {
        public List<(DateOnly, DateOnly)> Asked { get; } = [];
        public IReadOnlyList<TelegramChannelMessage> Messages { get; } = messages;

        public ITelegramUserClient Create(int apiId, string apiHash, string sessionPath) => new Client(this);

        private sealed class Client(Channel c) : ITelegramUserClient
        {
            private bool _codeAsked;
            public string? Account => "Trader";

            public Task<string?> LoginAsync(string value)
            {
                if (!_codeAsked) { _codeAsked = true; return Task.FromResult<string?>("verification_code"); }
                return Task.FromResult<string?>(null);
            }

            public Task<IReadOnlyList<TelegramChannelMessage>> HistoryAsync(string chat, DateTimeOffset fromUtc, DateTimeOffset toUtc, int max, CancellationToken cancellationToken)
            {
                c.Asked.Add((IstClock.IstDate(fromUtc), IstClock.IstDate(toUtc.AddMinutes(-1))));
                IReadOnlyList<TelegramChannelMessage> list = c.Messages.Where(m => m.Time >= fromUtc && m.Time < toUtc).OrderBy(m => m.Time).TakeLast(max).ToList();
                return Task.FromResult(list);
            }

            public Task LogOutAsync() => Task.CompletedTask;
            public void Dispose() { }
        }
    }
}
