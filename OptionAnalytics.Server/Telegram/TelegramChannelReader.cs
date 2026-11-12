using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;
using TL;

namespace OptionAnalytics.Server.Telegram;

/// <summary>One message of the channel as Telegram holds it (its id, when it was posted, its text - plain, as shown).</summary>
public sealed record TelegramChannelMessage(int Id, DateTimeOffset Time, string Text);

/// <summary>What the Telegram signals page shows about the reader: signed in or not, what the login waits for next
/// (`verification_code` - the code Telegram sent to the app - or `password`, the account's 2-step password), the account
/// and a masked phone. Never the api hash, the code or the session.</summary>
public sealed record TelegramReaderStatus(bool Connected, string? Pending, string? Account, string? Phone, bool ApiFromConfig, bool ChatConfigured, string? Error);

/// <summary>A Telegram USER account signed in over Telegram's own API (MTProto) - the only way to READ a channel's posts: the
/// Bot API can send but has no call that reads a chat's history (and a bot is never told of its own posts). Tests use a fake.</summary>
public interface ITelegramUserClient : IDisposable
{
    /// <summary>WTelegram's Login: the first call with the phone number, then with what it asked for. Returns the next item
    /// it needs (`verification_code`, `password`, `name` / `email` for an account that does not exist) or null once signed in.
    /// A session saved before resumes on the first call with no code.</summary>
    Task<string?> LoginAsync(string value);

    /// <summary>The signed-in account's name (and @username), null until signed in.</summary>
    string? Account { get; }

    /// <summary>The chat's text messages posted in [fromUtc, toUtc), oldest first, at most `max` (the newest kept).</summary>
    Task<IReadOnlyList<TelegramChannelMessage>> HistoryAsync(string chat, DateTimeOffset fromUtc, DateTimeOffset toUtc, int max, CancellationToken cancellationToken);

    Task LogOutAsync();
}

public interface ITelegramUserClientFactory
{
    ITelegramUserClient Create(int apiId, string apiHash, string sessionPath);
}

/// <summary>A Telegram failure said in words for the page (a wrong code, not a member of the channel, Telegram not
/// answering, signed out).</summary>
public sealed class TelegramReaderException(string message) : Exception(message);

/// <summary>
/// READS THE TELEGRAM CHANNEL the app's bot posts to (`Telegram:ChatId`), straight from Telegram, for the Telegram signals
/// page - the reader keeps none of the messages (the server's own copy is TelegramMessageLog): each Fetch asks Telegram
/// for the days picked and hands them on - so it also has the posts sent before the log began, or from anywhere else.
/// The bot cannot read (see ITelegramUserClient), so an ADMIN signs in a Telegram account that is a member of the channel,
/// ONCE: the api id / hash from my.telegram.org (or `Telegram:ApiId` / `Telegram:ApiHash` in the config), the phone, the
/// code Telegram sends to its app, the 2-step password if the account has one. What that leaves on the server is the
/// SIGN-IN, not the messages: the session (WTelegram's, encrypted with the api hash) and `reader.json` (the api id / hash
/// unless configured, the phone) under `Storage:TelegramSessionPath` - removed by Log out (and the session ended on
/// Telegram's side too). Only that one chat is ever read - a User of the app never reaches the admin's other chats. One
/// request at a time; nothing polls (a page click). At most MaxDays days and MaxMessages messages a fetch.
/// </summary>
public sealed class TelegramChannelReader : IDisposable
{
    public const int MaxDays = 31;
    public const int MaxMessages = 20_000;

    private readonly ITelegramUserClientFactory _factory;
    private readonly TelegramOptions _options;
    private readonly ILogger<TelegramChannelReader> _logger;
    private readonly string _folder;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private ITelegramUserClient? _client;
    private Credentials? _creds;          // the sign-in in use (saved once it succeeds)
    private string? _pending;             // what the login waits for
    private bool _connected;
    private bool _resumeTried;

    private sealed record Credentials(int ApiId, string ApiHash, string Phone);
    private sealed record SavedReader(int ApiId, string? ApiHash, string Phone);

    public TelegramChannelReader(ITelegramUserClientFactory factory, IOptions<TelegramOptions> options, IHostEnvironment environment, IConfiguration configuration, ILogger<TelegramChannelReader> logger)
        : this(factory, options.Value, ResolveFolder(environment, configuration), logger)
    {
    }

    internal TelegramChannelReader(ITelegramUserClientFactory factory, TelegramOptions options, string folder, ILogger<TelegramChannelReader> logger)
    {
        _factory = factory;
        _options = options;
        _folder = folder;
        _logger = logger;
    }

    private static string ResolveFolder(IHostEnvironment environment, IConfiguration configuration)
    {
        var configured = configuration["Storage:TelegramSessionPath"];
        var path = string.IsNullOrWhiteSpace(configured) ? "telegram-session" : configured;
        return Path.IsPathRooted(path) ? path : Path.Combine(environment.ContentRootPath, path);
    }

    private string SessionPath => Path.Combine(_folder, "session.dat");
    private string ReaderPath => Path.Combine(_folder, "reader.json");
    private bool ApiFromConfig => _options.ApiId > 0 && !string.IsNullOrWhiteSpace(_options.ApiHash);

    /// <summary>Where the reader stands. After a restart the saved sign-in is resumed here once (a call to Telegram).</summary>
    public async Task<TelegramReaderStatus> StatusAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            string? error = null;
            try { await ResumeIfSavedAsync(); }
            catch (TelegramReaderException ex) { error = ex.Message; }
            return Status(error);
        }
        finally { _gate.Release(); }
    }

    /// <summary>Starts a sign-in (Admin): a fresh session for the phone. Returns what it waits for next.</summary>
    public async Task<TelegramReaderStatus> ConnectAsync(int? apiId, string? apiHash, string? phone, CancellationToken cancellationToken)
    {
        var cleanPhone = CleanPhone(phone) ?? throw new TelegramReaderException("Enter the phone number of the Telegram account, with its country code (+91…).");
        var id = ApiFromConfig ? _options.ApiId : apiId ?? 0;
        var hash = ApiFromConfig ? _options.ApiHash.Trim() : (apiHash ?? "").Trim();
        if (id <= 0 || !Regex.IsMatch(hash, "^[0-9a-fA-F]{32}$"))
            throw new TelegramReaderException("Enter the api_id (a number) and api_hash (32 characters) from my.telegram.org → API development tools.");

        await _gate.WaitAsync(cancellationToken);
        try
        {
            DropClient();
            Directory.CreateDirectory(_folder);
            TryDelete(SessionPath);                       // a fresh sign-in, not whatever was there
            _creds = new Credentials(id, hash, cleanPhone);
            _client = _factory.Create(id, hash, SessionPath);
            _resumeTried = true;
            await StepAsync(cleanPhone);
            return Status(null);
        }
        finally { _gate.Release(); }
    }

    /// <summary>The code Telegram sent to the app, or the account's 2-step password - whichever the sign-in waits for (Admin).</summary>
    public async Task<TelegramReaderStatus> ContinueAsync(string? value, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_client is null || _pending is null) throw new TelegramReaderException("No sign-in is waiting - start again with Connect.");
            var given = (value ?? "").Trim();
            if (given.Length == 0) throw new TelegramReaderException(_pending == "password" ? "Enter the account's 2-step verification password." : "Enter the code Telegram sent to the app.");
            await StepAsync(given);
            return Status(null);
        }
        finally { _gate.Release(); }
    }

    /// <summary>Signs the account out (Admin): the session is ended on Telegram's side and its files removed.</summary>
    public async Task<TelegramReaderStatus> LogOutAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_client is not null && _connected)
            {
                try { await _client.LogOutAsync(); }
                catch (Exception ex) { _logger.LogWarning(ex, "Telegram reader: log out on Telegram's side failed - the session files are removed anyway."); }
            }
            DropClient();
            _creds = null;
            _resumeTried = true;
            TryDelete(SessionPath);
            TryDelete(ReaderPath);
            _logger.LogInformation("Telegram reader signed out.");
            return Status(null);
        }
        finally { _gate.Release(); }
    }

    /// <summary>The channel's messages posted on the IST days `from` .. `to` (at most MaxDays, ending at `to`), oldest first -
    /// asked of Telegram now, kept nowhere.</summary>
    public async Task<IReadOnlyList<TelegramChannelMessage>> ReadAsync(DateOnly from, DateOnly to, CancellationToken cancellationToken)
    {
        if (from > to) (from, to) = (to, from);
        if (to.DayNumber - from.DayNumber >= MaxDays) from = to.AddDays(-(MaxDays - 1));
        var chat = _options.ChatId?.Trim();
        if (string.IsNullOrEmpty(chat)) throw new TelegramReaderException("No channel to read - Telegram:ChatId (the chat the bot posts to) is not set on the server.");

        await _gate.WaitAsync(cancellationToken);
        try
        {
            await ResumeIfSavedAsync();
            if (!_connected || _client is null) throw new TelegramReaderException("Telegram is not connected - an admin connects a Telegram account that is in the channel (Connect Telegram).");
            var start = IstClock.AtIstTime(from, 0);
            var end = IstClock.AtIstTime(to.AddDays(1), 0);
            try
            {
                return await _client.HistoryAsync(chat, start, end, MaxMessages, cancellationToken);
            }
            catch (TelegramReaderException) { throw; }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Telegram reader: reading the channel failed.");
                throw new TelegramReaderException(Words(ex, "Telegram did not answer"));
            }
        }
        finally { _gate.Release(); }
    }

    private async Task StepAsync(string value)
    {
        string? next;
        try { next = await _client!.LoginAsync(value); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Telegram reader: sign-in step failed.");
            var words = Words(ex, "Telegram refused the sign-in");
            // A wrong code / password: the same step can be tried again; anything else starts over.
            if (_pending is null || !Regex.IsMatch(ex.Message, "CODE_INVALID|PASSWORD_HASH_INVALID|CODE_EMPTY", RegexOptions.IgnoreCase))
            {
                DropClient();
                _creds = null;
            }
            throw new TelegramReaderException(words);
        }
        if (next is null)
        {
            _pending = null;
            _connected = true;
            Save(_creds!);
            _logger.LogInformation("Telegram reader signed in as {Account}.", _client!.Account);
            return;
        }
        if (next is "verification_code" or "password")
        {
            _pending = next;
            _connected = false;
            return;
        }
        DropClient();
        _creds = null;
        throw new TelegramReaderException(next is "name"
            ? "That phone number has no Telegram account - sign up in the Telegram app first."
            : $"Telegram asks for \"{next}\" - finish setting the account up in the Telegram app, then connect again.");
    }

    /// <summary>After a restart: the saved sign-in resumed once (Login with the phone - a valid session needs no code).
    /// A session Telegram no longer accepts is dropped - the page says to connect again.</summary>
    private async Task ResumeIfSavedAsync()
    {
        if (_connected || _pending is not null || _resumeTried) return;
        _resumeTried = true;
        var saved = Load();
        if (saved is null || !File.Exists(SessionPath)) return;
        _creds = saved;
        _client = _factory.Create(saved.ApiId, saved.ApiHash, SessionPath);
        string? next;
        try { next = await _client.LoginAsync(saved.Phone); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Telegram reader: resuming the saved sign-in failed.");
            DropClient();
            _resumeTried = false;   // Telegram may just not have answered - the next look tries again
            throw new TelegramReaderException(Words(ex, "Telegram did not answer"));
        }
        if (next is null) { _connected = true; return; }
        // The session was ended (logged out from the phone, expired): nothing to resume - sign in again.
        _logger.LogInformation("Telegram reader: the saved session is no longer valid ({Next}).", next);
        DropClient();
        _creds = null;
        TryDelete(SessionPath);
        TryDelete(ReaderPath);
        throw new TelegramReaderException("The saved Telegram sign-in is no longer valid (logged out from the app?) - connect again.");
    }

    private TelegramReaderStatus Status(string? error) => new(
        _connected, _pending, _connected ? _client?.Account : null, Mask(_creds?.Phone ?? Load()?.Phone), ApiFromConfig,
        !string.IsNullOrWhiteSpace(_options.ChatId), error);

    private void DropClient()
    {
        try { _client?.Dispose(); }
        catch (Exception ex) { _logger.LogDebug(ex, "Telegram reader: disposing the client failed."); }
        _client = null;
        _pending = null;
        _connected = false;
    }

    private void Save(Credentials creds)
    {
        try
        {
            Directory.CreateDirectory(_folder);
            var tmp = ReaderPath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(new SavedReader(creds.ApiId, ApiFromConfig ? null : creds.ApiHash, creds.Phone)));
            File.Move(tmp, ReaderPath, overwrite: true);
        }
        catch (Exception ex) { _logger.LogWarning(ex, "Telegram reader: saving the sign-in failed - it is lost at the next restart."); }
    }

    private Credentials? Load()
    {
        try
        {
            if (!File.Exists(ReaderPath)) return null;
            var saved = JsonSerializer.Deserialize<SavedReader>(File.ReadAllText(ReaderPath));
            if (saved is null || string.IsNullOrWhiteSpace(saved.Phone)) return null;
            var id = ApiFromConfig ? _options.ApiId : saved.ApiId;
            var hash = ApiFromConfig ? _options.ApiHash.Trim() : saved.ApiHash;
            return id > 0 && !string.IsNullOrWhiteSpace(hash) ? new Credentials(id, hash, saved.Phone) : null;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Telegram reader: reading the saved sign-in failed.");
            return null;
        }
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch { /* best effort */ }
    }

    internal static string? CleanPhone(string? phone)
    {
        var digits = new string((phone ?? "").Where(char.IsDigit).ToArray());
        return digits.Length is >= 8 and <= 15 ? "+" + digits : null;
    }

    internal static string? Mask(string? phone) =>
        string.IsNullOrEmpty(phone) || phone.Length < 6 ? null : phone[..3] + new string('•', phone.Length - 7) + phone[^4..];

    private static readonly (string Code, string Words)[] KnownErrors =
    [
        ("PHONE_CODE_INVALID", "That code is not right - enter the code Telegram sent to the app."),
        ("PHONE_CODE_EXPIRED", "The code expired - connect again for a new one."),
        ("PASSWORD_HASH_INVALID", "That password is not right - the account's 2-step verification password."),
        ("PHONE_NUMBER_INVALID", "Telegram does not know that phone number - with its country code (+91…)."),
        ("API_ID_INVALID", "The api_id / api_hash are not valid - copy them again from my.telegram.org."),
        ("API_ID_PUBLISHED_FLOOD", "The api_id / api_hash are not valid - copy them again from my.telegram.org."),
        ("CHANNEL_PRIVATE", "This Telegram account cannot read the channel - join it with this account first."),
        ("CHANNEL_INVALID", "This Telegram account cannot read the channel - join it with this account first."),
        ("AUTH_KEY_UNREGISTERED", "The Telegram sign-in was ended (logged out from the app?) - connect again."),
        ("SESSION_REVOKED", "The Telegram sign-in was ended (logged out from the app?) - connect again."),
        ("USER_DEACTIVATED", "The Telegram sign-in was ended (logged out from the app?) - connect again."),
        ("FLOOD_WAIT", "Telegram asks to wait before trying again (too many tries) - try again later."),
    ];

    /// <summary>A failure in words the page can show: Telegram's own error code (anywhere in the message) read, any other
    /// code named, the rest generic (no stack, no secret).</summary>
    private static string Words(Exception ex, string fallback)
    {
        var m = ex.Message ?? "";
        foreach (var (code, words) in KnownErrors)
            if (m.Contains(code, StringComparison.Ordinal)) return words;
        var other = Regex.Matches(m, "[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+").Select(x => x.Value).FirstOrDefault(x => x != "RPC_ERROR");
        return other is null ? fallback + "." : $"{fallback} ({other}).";
    }

    public void Dispose()
    {
        DropClient();
        _gate.Dispose();
    }
}

/// <summary>The real Telegram client (WTelegramClient - MTProto). Its own log goes to ours at Debug (it is chatty).</summary>
public sealed class WTelegramUserClientFactory : ITelegramUserClientFactory
{
    public WTelegramUserClientFactory(ILogger<WTelegramUserClientFactory> logger)
    {
        WTelegram.Helpers.Log = (level, text) =>
        {
            if (level >= (int)LogLevel.Warning) logger.LogWarning("WTelegram: {Text}", text);
            else logger.LogDebug("WTelegram: {Text}", text);
        };
    }

    public ITelegramUserClient Create(int apiId, string apiHash, string sessionPath) => new WTelegramUserClient(apiId, apiHash, sessionPath);
}

internal sealed class WTelegramUserClient : ITelegramUserClient
{
    private const int Page = 100;
    private readonly WTelegram.Client _client;
    private readonly Dictionary<string, TL.InputPeer> _peers = new(StringComparer.OrdinalIgnoreCase);

    public WTelegramUserClient(int apiId, string apiHash, string sessionPath)
    {
        _client = new WTelegram.Client(what => what switch
        {
            "api_id" => apiId.ToString(CultureInfo.InvariantCulture),
            "api_hash" => apiHash,
            "session_pathname" => sessionPath,
            _ => null,
        });
        _client.FloodRetryThreshold = 30;
    }

    public Task<string?> LoginAsync(string value) => _client.Login(value);

    public string? Account => _client.User is { } user
        ? $"{user.first_name} {user.last_name}".Trim() + (string.IsNullOrEmpty(user.username) ? "" : $" (@{user.username})")
        : null;

    public async Task<IReadOnlyList<TelegramChannelMessage>> HistoryAsync(string chat, DateTimeOffset fromUtc, DateTimeOffset toUtc, int max, CancellationToken cancellationToken)
    {
        var peer = await PeerAsync(chat);
        var list = new List<TelegramChannelMessage>();
        var offsetId = 0;
        while (list.Count < max)
        {
            cancellationToken.ThrowIfCancellationRequested();
            // Newest first: the first page from just before the end of the range, then on from the oldest id seen.
            var page = await _client.Messages_GetHistory(peer, offset_id: offsetId, offset_date: offsetId == 0 ? toUtc.UtcDateTime : default, limit: Page);
            var messages = page.Messages;
            if (messages.Length == 0) break;
            var done = false;
            foreach (var item in messages)
            {
                offsetId = item.ID;
                if (item is not TL.Message m) continue;
                var time = new DateTimeOffset(DateTime.SpecifyKind(m.date, DateTimeKind.Utc));
                if (time < fromUtc) { done = true; break; }
                if (time >= toUtc || string.IsNullOrWhiteSpace(m.message)) continue;
                list.Add(new TelegramChannelMessage(m.id, time, m.message));
                if (list.Count >= max) break;
            }
            if (done || messages.Length < Page) break;
        }
        list.Reverse();
        return list;
    }

    /// <summary>The chat the bot posts to: "@name" resolved, or a numeric id (a channel's -100… id) found among the
    /// account's chats - it must be a member.</summary>
    private async Task<TL.InputPeer> PeerAsync(string chat)
    {
        if (_peers.TryGetValue(chat, out var known)) return known;
        TL.InputPeer? peer = null;
        if (chat.StartsWith('@'))
        {
            var resolved = await _client.Contacts_ResolveUsername(chat[1..]);
            peer = resolved.Chat is { } c ? c.ToInputPeer() : null;
        }
        else if (long.TryParse(chat, NumberStyles.Integer, CultureInfo.InvariantCulture, out var id))
        {
            var bare = id <= -1_000_000_000_000 ? -id - 1_000_000_000_000 : Math.Abs(id);
            var chats = await _client.Messages_GetAllChats();
            if (chats.chats.TryGetValue(bare, out var found)) peer = found.ToInputPeer();
        }
        if (peer is null) throw new TelegramReaderException("This Telegram account is not in the channel the bot posts to (Telegram:ChatId) - join it with this account, then fetch again.");
        _peers[chat] = peer;
        return peer;
    }

    public async Task LogOutAsync() => await _client.Auth_LogOut();

    public void Dispose() => _client.Dispose();
}
