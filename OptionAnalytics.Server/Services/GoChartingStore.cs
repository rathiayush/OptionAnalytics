using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// GoCharting's own order flow per 1-minute bar, sent to this server by a Lipi script running as a GoCharting
/// alert with a webhook (GoChartingController; the script is GoChartingStore.LipiScript). GoCharting has no
/// public market-data API and its scripts cannot read per-price footprint cells or the volume profile - what a
/// script CAN read per bar is its tick-by-tick buy / sell volume, delta, max / min delta, trade count and the
/// session's cumulative delta, and that is what it sends: one plain-text message per finished bar.
/// Kept per index and IST day as JSON under Storage:GoChartingPath (default /app/data/gocharting).
/// </summary>
public sealed class GoChartingStore
{
    public static readonly string[] Underlyings = { "NIFTY", "BANKNIFTY", "SENSEX" };
    private const long MinMs = 60_000;

    private readonly string _dir;
    private readonly object _lock = new();
    private readonly Dictionary<(string U, DateOnly Day), SortedDictionary<long, GoChartingBar>> _days = new();
    private readonly ILogger<GoChartingStore> _logger;
    private readonly string _token;
    private readonly IConfiguration _configuration;

    public GoChartingStore(IHostEnvironment environment, IConfiguration configuration, ILogger<GoChartingStore> logger)
    {
        _configuration = configuration;
        var configured = configuration["Storage:GoChartingPath"];
        var path = string.IsNullOrWhiteSpace(configured) ? "gocharting" : configured;
        _dir = Path.IsPathRooted(path) ? path : Path.Combine(environment.ContentRootPath, path);
        _logger = logger;
        Directory.CreateDirectory(_dir);
        _token = configuration["GoCharting:WebhookToken"] is { Length: >= 16 } fromConfig ? fromConfig : LoadOrCreateToken();
    }

    /// <summary>The GoCharting chart SDK license key (the Order Flow page loads GoCharting's footprint chart with it):
    /// GoCharting:SdkLicenseKey, else the one an admin saved (sdk-license.txt). Null when there is none. The key is
    /// not a secret from the browser - it is in the script URL GoCharting hosts the SDK at.</summary>
    public string? SdkLicenseKey
    {
        get
        {
            if (_configuration["GoCharting:SdkLicenseKey"] is { Length: > 0 } configured) return configured.Trim();
            var file = Path.Combine(_dir, "sdk-license.txt");
            try { return File.Exists(file) && File.ReadAllText(file).Trim() is { Length: > 0 } saved ? saved : null; }
            catch { return null; }
        }
    }

    public bool SdkLicenseKeyFromConfig => _configuration["GoCharting:SdkLicenseKey"] is { Length: > 0 };

    public static bool IsValidSdkLicenseKey(string? key) => key is { Length: >= 8 and <= 120 } && Regex.IsMatch(key, "^[A-Za-z0-9_-]+$");

    /// <summary>Saves (or with null / empty clears) the SDK license key an admin entered. Returns an error or null.</summary>
    public string? SaveSdkLicenseKey(string? key)
    {
        var file = Path.Combine(_dir, "sdk-license.txt");
        if (string.IsNullOrWhiteSpace(key)) { if (File.Exists(file)) File.Delete(file); return null; }
        key = key.Trim();
        if (!IsValidSdkLicenseKey(key)) return "That does not look like a GoCharting SDK license key (letters, digits and dashes, 8-120 characters).";
        File.WriteAllText(file, key);
        return null;
    }

    /// <summary>Where GoCharting hosts the SDK for a license key.</summary>
    public static string SdkScriptUrl(string key) => $"https://gocharting.com/sdk/library/{Uri.EscapeDataString(key)}/index.umd.js";

    /// <summary>The secret in the webhook URL (GoCharting cannot send a login) - GoCharting:WebhookToken, else
    /// generated once and kept in webhook-token.txt.</summary>
    public string Token => _token;
    public DateTimeOffset? LastReceivedUtc { get; private set; }
    public string? LastMessage { get; private set; }
    public string? LastError { get; private set; }

    public bool TokenMatches(string? token) =>
        token is not null && CryptographicOperations.FixedTimeEquals(System.Text.Encoding.UTF8.GetBytes(token), System.Text.Encoding.UTF8.GetBytes(_token));

    /// <summary>Takes one webhook message. Returns the bar stored, or why the message was not understood.</summary>
    public (GoChartingBar? Bar, string? Error) Receive(string body, DateTimeOffset receivedUtc)
    {
        var (bar, error) = Parse(body, receivedUtc);
        lock (_lock)
        {
            LastReceivedUtc = receivedUtc;
            LastMessage = body.Length > 300 ? body[..300] : body;
            LastError = error;
            if (bar is null) return (null, error);
            var day = IstClock.IstDate(DateTimeOffset.FromUnixTimeMilliseconds(bar.Time));
            var bars = Load(bar.Underlying, day);
            bars[bar.Time] = bar;
            Save(bar.Underlying, day, bars);
        }
        return (bar, null);
    }

    /// <summary>The bars GoCharting sent for an index's IST day, oldest first.</summary>
    public IReadOnlyList<GoChartingBar> Day(string underlying, DateOnly day)
    {
        var u = underlying.Trim().ToUpperInvariant();
        lock (_lock) return Load(u, day).Values.ToList();
    }

    /// <summary>
    /// A message: "OA1 sym=NIFTY t=1791182400000 o=.. h=.. l=.. c=.. v=.. bv=.. sv=.. d=.. dmax=.. dmin=.. n=.. cvd=.."
    /// (key=value pairs, any separator), or the same keys as a JSON object. t is the bar's start (ms or s since
    /// the epoch); without it the bar is the minute before the message arrived.
    /// </summary>
    internal static (GoChartingBar? Bar, string? Error) Parse(string body, DateTimeOffset receivedUtc)
    {
        if (string.IsNullOrWhiteSpace(body)) return (null, "empty message");
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var trimmed = body.Trim();
        if (trimmed.StartsWith('{'))
        {
            try
            {
                using var doc = JsonDocument.Parse(trimmed);
                foreach (var p in doc.RootElement.EnumerateObject())
                    values[p.Name] = p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() ?? "" : p.Value.GetRawText();
            }
            catch (JsonException ex) { return (null, $"not valid JSON: {ex.Message}"); }
        }
        else
        {
            foreach (Match m in Regex.Matches(trimmed, @"([A-Za-z]+)\s*[=:]\s*([^\s,;|]+)"))
                values[m.Groups[1].Value] = m.Groups[2].Value;
        }

        var sym = (values.GetValueOrDefault("sym") ?? values.GetValueOrDefault("symbol") ?? "").ToUpperInvariant();
        var underlying = Underlyings.FirstOrDefault(u => sym == u || sym.StartsWith(u, StringComparison.Ordinal) && !(u == "NIFTY" && sym.StartsWith("NIFTYBANK", StringComparison.Ordinal)))
            ?? (sym.Contains("BANK") ? "BANKNIFTY" : sym.Contains("SENSEX") ? "SENSEX" : sym.Contains("NIFTY") ? "NIFTY" : null);
        if (underlying is null) return (null, $"no index in sym='{sym}' (NIFTY, BANKNIFTY or SENSEX)");

        double? Num(params string[] keys)
        {
            foreach (var k in keys)
                if (values.TryGetValue(k, out var s) && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) && double.IsFinite(v))
                    return v;
            return null;
        }

        long time;
        if (Num("t", "time") is { } t)
        {
            var ms = t < 1e11 ? t * 1000 : t; // seconds or milliseconds
            time = (long)Math.Floor(ms / MinMs) * MinMs;
        }
        else
        {
            time = (receivedUtc.ToUnixTimeMilliseconds() / MinMs - 1) * MinMs;
        }
        var age = receivedUtc.ToUnixTimeMilliseconds() - time;
        if (age < -5 * MinMs || age > 3 * 86_400_000L) return (null, $"bar time {DateTimeOffset.FromUnixTimeMilliseconds(time):u} is not around now");

        var buy = Num("bv", "buyvolume");
        var sell = Num("sv", "sellvolume");
        var delta = Num("d", "delta") ?? (buy is not null && sell is not null ? buy - sell : null);
        if (delta is null && buy is null && sell is null) return (null, "no order flow values (bv / sv / d) in the message");

        return (new GoChartingBar(underlying, time,
            Num("o", "open"), Num("h", "high"), Num("l", "low"), Num("c", "close"), Num("v", "volume"),
            buy, sell, delta, Num("dmax", "maxdelta"), Num("dmin", "mindelta"), Num("n", "trades"), Num("cvd")), null);
    }

    private SortedDictionary<long, GoChartingBar> Load(string u, DateOnly day)
    {
        if (_days.TryGetValue((u, day), out var bars)) return bars;
        bars = new SortedDictionary<long, GoChartingBar>();
        var file = FileFor(u, day);
        try
        {
            if (File.Exists(file))
                foreach (var b in JsonSerializer.Deserialize<List<GoChartingBar>>(File.ReadAllText(file)) ?? new()) bars[b.Time] = b;
        }
        catch (Exception ex) { _logger.LogWarning(ex, "GoCharting: {File} could not be read.", file); }
        _days[(u, day)] = bars;
        // Only today and the last few days stay in memory.
        foreach (var old in _days.Keys.Where(k => k.Day < day.AddDays(-5)).ToList()) _days.Remove(old);
        return bars;
    }

    private void Save(string u, DateOnly day, SortedDictionary<long, GoChartingBar> bars)
    {
        var file = FileFor(u, day);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var temp = file + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(bars.Values.ToList()));
        File.Move(temp, file, overwrite: true);
    }

    private string FileFor(string u, DateOnly day) => Path.Combine(_dir, u, $"{day:yyyy-MM-dd}.json");

    private string LoadOrCreateToken()
    {
        var file = Path.Combine(_dir, "webhook-token.txt");
        try
        {
            if (File.Exists(file) && File.ReadAllText(file).Trim() is { Length: >= 16 } saved) return saved;
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
            File.WriteAllText(file, token);
            return token;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "GoCharting: the webhook token could not be kept in {File} - using one for this run only.", file);
            return Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        }
    }

    /// <summary>The Lipi script to add on a GoCharting 1-minute chart of the index future, then create an alert
    /// on it with the webhook URL. On the first tick of each new bar it sends the bar that just finished.</summary>
    public static string LipiScript(string underlying) => $$"""
indicator("OptionAnalytics order flow bridge", overlay=false)
sym = input.string("{{underlying}}", "Index sent to OptionAnalytics (NIFTY / BANKNIFTY / SENSEX)")
cvd = orderflow.cvd()
plot(orderflow.delta, title="Delta")
// On the first tick of a new bar, send the bar that just finished (its values are final).
if barstate.isnew and barstate.isrealtime
    msg = "OA1 sym=" + sym + " t=" + str.tostring(time[1]) + " o=" + str.tostring(open[1]) + " h=" + str.tostring(high[1]) + " l=" + str.tostring(low[1]) + " c=" + str.tostring(close[1]) + " v=" + str.tostring(volume[1]) + " bv=" + str.tostring(orderflow.buyvolume[1]) + " sv=" + str.tostring(orderflow.sellvolume[1]) + " d=" + str.tostring(orderflow.delta[1]) + " dmax=" + str.tostring(orderflow.maxdelta[1]) + " dmin=" + str.tostring(orderflow.mindelta[1]) + " n=" + str.tostring(orderflow.trades[1]) + " cvd=" + str.tostring(cvd[1])
    alert(msg)
""";
}

/// <summary>One finished 1-minute bar as GoCharting measured it (Time = the bar's start, ms since the epoch).
/// BuyVolume / SellVolume / Delta / Cvd are in contracts as GoCharting counts them.</summary>
public sealed record GoChartingBar(
    string Underlying, long Time, double? Open, double? High, double? Low, double? Close, double? Volume,
    double? BuyVolume, double? SellVolume, double? Delta, double? MaxDelta, double? MinDelta, double? Trades, double? Cvd);
