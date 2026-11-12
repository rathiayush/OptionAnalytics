using System.Reflection;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Controllers;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Tests;

/// <summary>The Telegram signals page's reading of the bot's channel straight from Telegram (TelegramChannelReader) on a fake
/// Telegram: the sign-in steps (code, 2-step password, a wrong code tried again), the saved sign-in resumed after a restart
/// with no code, a session Telegram ended asking to connect again, log out removing it all, only the bot's own chat read, on
/// the IST days asked (at most MaxDays), the status never carrying a secret, and who may do what.</summary>
public sealed class TelegramChannelReaderTests : IDisposable
{
    private const string Hash = "0123456789abcdef0123456789abcdef";
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "tg-reader-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch (IOException) { }
    }

    private TelegramChannelReader Reader(FakeTelegram telegram, TelegramOptions? options = null) =>
        new(telegram, options ?? new TelegramOptions { ChatId = "-1001234567890" }, _dir, NullLogger<TelegramChannelReader>.Instance);

    [Fact]
    public async Task Signing_in_takes_the_code_then_the_password_and_a_wrong_code_can_be_tried_again()
    {
        var telegram = new FakeTelegram { Password = "pw" };
        using var reader = Reader(telegram);
        Assert.False((await reader.StatusAsync(default)).Connected);

        var s = await reader.ConnectAsync(12345, Hash, "+91 98765 43210", default);
        Assert.Equal("verification_code", s.Pending);
        Assert.Equal(("+919876543210", 12345, Hash), (telegram.LastPhone, telegram.LastApiId, telegram.LastApiHash));
        Assert.Equal("+91••••••3210", s.Phone);

        var wrong = await Assert.ThrowsAsync<TelegramReaderException>(() => reader.ContinueAsync("11111", default));
        Assert.Contains("code is not right", wrong.Message);
        Assert.Equal("password", (await reader.ContinueAsync("12345", default)).Pending);   // the same sign-in carries on
        var done = await reader.ContinueAsync("pw", default);
        Assert.True(done.Connected);
        Assert.Null(done.Pending);
        Assert.Equal("Trader (@trader)", done.Account);

        // What the status says never holds the api hash, the code or the full phone.
        var json = JsonSerializer.Serialize(done);
        Assert.DoesNotContain(Hash, json);
        Assert.DoesNotContain("9876543210", json);
        Assert.DoesNotContain("pw", json.Replace("\"Phone\"", ""), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_restart_resumes_the_saved_sign_in_with_no_code_and_reads_only_the_bots_chat_on_the_IST_days_asked()
    {
        var telegram = new FakeTelegram();
        using (var first = Reader(telegram))
        {
            await first.ConnectAsync(12345, Hash, "+919876543210", default);
            await first.ContinueAsync("12345", default);
        }
        Assert.True(File.Exists(Path.Combine(_dir, "reader.json")));

        using var reader = Reader(telegram);                  // the server restarted
        var status = await reader.StatusAsync(default);
        Assert.True(status.Connected);
        Assert.Equal(1, telegram.Resumes);                    // the phone again, no code asked

        var messages = await reader.ReadAsync(new DateOnly(2026, 11, 10), new DateOnly(2026, 11, 11), default);
        Assert.Equal("-1001234567890", telegram.LastChat);   // Telegram:ChatId - nothing else is ever read
        Assert.Equal(new DateTimeOffset(2026, 11, 10, 0, 0, 0, IstClock.Offset), telegram.LastFrom);
        Assert.Equal(new DateTimeOffset(2026, 11, 12, 0, 0, 0, IstClock.Offset), telegram.LastTo);
        Assert.Equal(TelegramChannelReader.MaxMessages, telegram.LastMax);
        Assert.Equal(new[] { "🧊 Iceberg NIFTY futures: hidden BUYER at the bid 24500" }, messages.Select(m => m.Text));

        // At most MaxDays days, ending at the last one asked.
        await reader.ReadAsync(new DateOnly(2026, 1, 1), new DateOnly(2026, 11, 11), default);
        Assert.Equal(new DateTimeOffset(2026, 11, 11, 0, 0, 0, IstClock.Offset).AddDays(-(TelegramChannelReader.MaxDays - 1)), telegram.LastFrom);
    }

    [Fact]
    public async Task A_session_Telegram_ended_says_connect_again_and_log_out_removes_the_sign_in()
    {
        var telegram = new FakeTelegram();
        using (var first = Reader(telegram))
        {
            await first.ConnectAsync(12345, Hash, "+919876543210", default);
            await first.ContinueAsync("12345", default);
            telegram.SessionValid = false;                  // logged out from the phone meanwhile
        }
        using (var reader = Reader(telegram))
        {
            var s = await reader.StatusAsync(default);
            Assert.False(s.Connected);
            Assert.Contains("connect again", s.Error);
            Assert.False(File.Exists(Path.Combine(_dir, "reader.json")));
            await Assert.ThrowsAsync<TelegramReaderException>(() => reader.ReadAsync(new DateOnly(2026, 11, 10), new DateOnly(2026, 11, 10), default));
        }

        telegram.SessionValid = true;
        using var again = Reader(telegram);
        await again.ConnectAsync(12345, Hash, "+919876543210", default);
        await again.ContinueAsync("12345", default);
        var after = await again.LogOutAsync(default);
        Assert.False(after.Connected);
        Assert.Equal(1, telegram.LogOuts);                    // ended on Telegram's side too
        Assert.False(File.Exists(Path.Combine(_dir, "reader.json")));
        Assert.False(File.Exists(Path.Combine(_dir, "session.dat")));
        await Assert.ThrowsAsync<TelegramReaderException>(() => again.ReadAsync(new DateOnly(2026, 11, 10), new DateOnly(2026, 11, 10), default));
    }

    [Fact]
    public async Task The_api_id_and_hash_come_from_the_config_when_set_and_bad_input_is_said_in_words()
    {
        var telegram = new FakeTelegram();
        using var reader = Reader(telegram, new TelegramOptions { ChatId = "@signals", ApiId = 777, ApiHash = Hash });
        Assert.True((await reader.StatusAsync(default)).ApiFromConfig);
        await reader.ConnectAsync(null, null, "+919876543210", default);
        Assert.Equal(777, telegram.LastApiId);
        await reader.ContinueAsync("12345", default);
        Assert.DoesNotContain(Hash, File.ReadAllText(Path.Combine(_dir, "reader.json")));   // configured: not written down again

        using var plain = Reader(new FakeTelegram());
        Assert.Contains("phone", (await Assert.ThrowsAsync<TelegramReaderException>(() => plain.ConnectAsync(1, Hash, "12", default))).Message);
        Assert.Contains("api_hash", (await Assert.ThrowsAsync<TelegramReaderException>(() => plain.ConnectAsync(1, "short", "+919876543210", default))).Message);
        Assert.Contains("No sign-in", (await Assert.ThrowsAsync<TelegramReaderException>(() => plain.ContinueAsync("1", default))).Message);
        using var noChat = Reader(new FakeTelegram(), new TelegramOptions());
        Assert.Contains("ChatId", (await Assert.ThrowsAsync<TelegramReaderException>(() => noChat.ReadAsync(new DateOnly(2026, 11, 10), new DateOnly(2026, 11, 10), default))).Message);
    }

    [Fact]
    public void Reading_is_Admin_and_User_the_sign_in_Admin_only()
    {
        Assert.Equal($"{AuthRoles.Admin},{AuthRoles.User}", typeof(TelegramHistoryController).GetCustomAttribute<AuthorizeAttribute>()!.Roles);
        foreach (var name in new[] { nameof(TelegramHistoryController.Connect), nameof(TelegramHistoryController.Code), nameof(TelegramHistoryController.Logout) })
            Assert.Equal(AuthRoles.Admin, typeof(TelegramHistoryController).GetMethod(name)!.GetCustomAttribute<AuthorizeAttribute>()!.Roles);
        foreach (var name in new[] { nameof(TelegramHistoryController.Status), nameof(TelegramHistoryController.Messages) })
            Assert.Null(typeof(TelegramHistoryController).GetMethod(name)!.GetCustomAttribute<AuthorizeAttribute>());
    }

    /// <summary>Telegram as WTelegram's Login sees it: the phone -> a code -> (a 2-step password) -> signed in; a saved, still
    /// valid session signs in on the phone alone.</summary>
    private sealed class FakeTelegram : ITelegramUserClientFactory
    {
        public string? Password { get; init; }
        public bool SessionValid { get; set; } = true;
        public int Resumes, LogOuts, LastApiId, LastMax;
        public string? LastPhone, LastApiHash, LastChat;
        public DateTimeOffset LastFrom, LastTo;

        public ITelegramUserClient Create(int apiId, string apiHash, string sessionPath)
        {
            LastApiId = apiId;
            LastApiHash = apiHash;
            return new Client(this, sessionPath);
        }

        private sealed class Client(FakeTelegram t, string session) : ITelegramUserClient
        {
            private string _step = "phone";
            public string? Account { get; private set; }

            public Task<string?> LoginAsync(string value)
            {
                string? next;
                switch (_step)
                {
                    case "phone":
                        t.LastPhone = value;
                        if (File.Exists(session))
                        {
                            t.Resumes++;
                            next = t.SessionValid ? null : "verification_code";
                        }
                        else next = "verification_code";
                        break;
                    case "verification_code":
                        if (value != "12345") throw new InvalidOperationException("RPC_ERROR 400 PHONE_CODE_INVALID");
                        next = t.Password is null ? null : "password";
                        break;
                    default:
                        if (value != t.Password) throw new InvalidOperationException("RPC_ERROR 400 PASSWORD_HASH_INVALID");
                        next = null;
                        break;
                }
                if (next is null)
                {
                    Account = "Trader (@trader)";
                    File.WriteAllText(session, "session");
                }
                else _step = next;
                return Task.FromResult(next);
            }

            public Task<IReadOnlyList<TelegramChannelMessage>> HistoryAsync(string chat, DateTimeOffset fromUtc, DateTimeOffset toUtc, int max, CancellationToken cancellationToken)
            {
                (t.LastChat, t.LastFrom, t.LastTo, t.LastMax) = (chat, fromUtc, toUtc, max);
                IReadOnlyList<TelegramChannelMessage> list = new[] { new TelegramChannelMessage(7, fromUtc.AddHours(4), "🧊 Iceberg NIFTY futures: hidden BUYER at the bid 24500") };
                return Task.FromResult(list);
            }

            public Task LogOutAsync()
            {
                t.LogOuts++;
                return Task.CompletedTask;
            }

            public void Dispose() { }
        }
    }
}
