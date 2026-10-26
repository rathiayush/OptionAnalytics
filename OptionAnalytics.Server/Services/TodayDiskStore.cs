using System.Globalization;
using System.Text;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// TODAY's OI Replay data kept as CSV files on the server, under {Storage:DhanCachePath}/today/{yyyy-MM-dd}/ (the
/// persistent volume in docker-compose), so a restart or a deploy carries on from them instead of asking Dhan for the
/// whole day again (an OI Replay run is 40+ Dhan calls per index):
///  - live-bars.csv: the live feed's 1-minute bars of every tracked option leg and the near futures
///    (LiveOptionLegStore), a row per leg and completed minute, appended as each minute completes and read back on start;
///  - series/{key}.csv: each series' backfill from Dhan (an option strike's day so far, the futures), with when it was
///    fetched - OiReplayService reuses it while the saved live bars carry on from that time (see
///    LiveOptionLegStore.CarriesOnFrom).
/// Past days are DhanDataCache's. Only today is kept here: an earlier day's folder is removed. A disk problem is logged
/// and never fails anything - the caller then asks Dhan as before.
/// </summary>
public sealed class TodayDiskStore
{
    public const string LiveBarsFile = "live-bars.csv";
    internal const string LiveBarsHeader = "kind,underlying,expiry_flag,side,strike,minute_utc,open,high,low,close,oi,volume";
    internal const string OptionSeriesHeader = "time_utc,open,high,low,close,volume,strike,spot,oi,iv";
    internal const string FuturesHeader = "time_utc,open,high,low,close,volume,oi";
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    private readonly string _root;
    private readonly ILogger<TodayDiskStore> _logger;
    private readonly object _appendLock = new();

    public TodayDiskStore(IHostEnvironment environment, IConfiguration configuration, ILogger<TodayDiskStore> logger)
        : this(Path.Combine(DhanDataCache.PathOf(environment, configuration), "today"), logger) { }

    internal TodayDiskStore(string root, ILogger<TodayDiskStore> logger)
    {
        _root = root;
        _logger = logger;
    }

    public string Root => _root;

    public string DayDir(DateOnly day) => Path.Combine(_root, day.ToString("yyyy-MM-dd", Inv));

    private string SeriesFile(DateOnly day, string key) => Path.Combine(DayDir(day), "series", $"{SafeName(key)}.csv");

    /// <summary>A key as a readable file name: letters and digits kept, '+' p, '-' m, anything else '_'
    /// ("NIFTY|opt|WEEK|ATM+3|CALL" -> NIFTY_opt_WEEK_ATMp3_CALL) - ATM+3 and ATM-3 stay apart.</summary>
    internal static string SafeName(string key)
    {
        var sb = new StringBuilder(key.Length);
        foreach (var c in key) sb.Append(char.IsAsciiLetterOrDigit(c) ? c : c == '+' ? 'p' : c == '-' ? 'm' : '_');
        return sb.ToString();
    }

    // ---- The live feed's bars ----

    /// <summary>One leg's (or the futures') completed minute. Kind "opt" or "fut" (futures: no expiry flag, side or strike).</summary>
    public sealed record LiveBarRow(string Kind, string Underlying, string ExpiryFlag, string Side, decimal Strike, DateTimeOffset Minute,
        decimal Open, decimal High, decimal Low, decimal Close, long OpenInterest, long Volume);

    /// <summary>Appends completed minutes to the day's live-bars.csv (the header first, on a new file).</summary>
    public void AppendLiveBars(DateOnly day, IReadOnlyCollection<LiveBarRow> rows)
    {
        if (rows.Count == 0) return;
        var path = Path.Combine(DayDir(day), LiveBarsFile);
        var sb = new StringBuilder();
        foreach (var r in rows)
            sb.Append(r.Kind).Append(',').Append(r.Underlying).Append(',').Append(r.ExpiryFlag).Append(',').Append(r.Side).Append(',')
              .Append(r.Strike.ToString(Inv)).Append(',').Append(Utc(r.Minute)).Append(',')
              .Append(r.Open.ToString(Inv)).Append(',').Append(r.High.ToString(Inv)).Append(',').Append(r.Low.ToString(Inv)).Append(',')
              .Append(r.Close.ToString(Inv)).Append(',').Append(r.OpenInterest.ToString(Inv)).Append(',').Append(r.Volume.ToString(Inv)).Append('\n');
        lock (_appendLock)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                var isNew = !File.Exists(path) || new FileInfo(path).Length == 0;
                File.AppendAllText(path, (isNew ? LiveBarsHeader + "\n" : "") + sb, Encoding.UTF8);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _logger.LogWarning("Today's live bars not saved to {Path} ({Error}).", path, ex.Message);
            }
        }
    }

    /// <summary>The day's saved live bars (a broken row is skipped; a later row for the same leg and minute wins when read
    /// into the store). Empty when there is no file.</summary>
    public IReadOnlyList<LiveBarRow> ReadLiveBars(DateOnly day)
    {
        var path = Path.Combine(DayDir(day), LiveBarsFile);
        var rows = new List<LiveBarRow>();
        foreach (var line in ReadLines(path))
        {
            if (line.Length == 0 || line.StartsWith("kind,", StringComparison.Ordinal)) continue;
            var f = line.Split(',');
            if (f.Length != 12 || !TryUtc(f[5], out var minute) || !Dec(f[4], out var strike) || !Dec(f[6], out var open) || !Dec(f[7], out var high)
                || !Dec(f[8], out var low) || !Dec(f[9], out var close) || !Long(f[10], out var oi) || !Long(f[11], out var volume)) continue;
            rows.Add(new LiveBarRow(f[0], f[1], f[2], f[3], strike, minute, open, high, low, close, oi, volume));
        }
        return rows;
    }

    // ---- Each series' backfill from Dhan ----

    public sealed record SavedOptionSeries(DateTimeOffset FetchedAt,
        IReadOnlyList<(CandleWithVolume Bar, decimal? Strike, decimal? Spot, long? OpenInterest, decimal? ImpliedVolatility)> Bars);

    public sealed record SavedFutures(DateTimeOffset FetchedAt, IReadOnlyList<FuturesBar> Bars, DateOnly? Expiry, bool OiAvailable);

    /// <summary>Keeps today's backfill of one option series (`key` - OiReplayService's) as fetched at `fetchedAt`.</summary>
    public void SaveOptionSeries(DateOnly day, string key, DateTimeOffset fetchedAt,
        IReadOnlyList<(CandleWithVolume Bar, decimal? Strike, decimal? Spot, long? OpenInterest, decimal? ImpliedVolatility)> bars)
    {
        var sb = new StringBuilder();
        sb.Append("# fetched_utc=").Append(Utc(fetchedAt)).Append(",key=").Append(key).Append('\n').Append(OptionSeriesHeader).Append('\n');
        foreach (var (bar, strike, spot, oi, iv) in bars)
            sb.Append(Utc(bar.Time)).Append(',').Append(bar.Open.ToString(Inv)).Append(',').Append(bar.High.ToString(Inv)).Append(',')
              .Append(bar.Low.ToString(Inv)).Append(',').Append(bar.Close.ToString(Inv)).Append(',').Append(bar.Volume.ToString(Inv)).Append(',')
              .Append(strike?.ToString(Inv)).Append(',').Append(spot?.ToString(Inv)).Append(',').Append(oi?.ToString(Inv)).Append(',')
              .Append(iv?.ToString(Inv)).Append('\n');
        WriteAtomic(SeriesFile(day, key), sb.ToString());
    }

    /// <summary>Today's saved backfill of one option series, else null.</summary>
    public SavedOptionSeries? ReadOptionSeries(DateOnly day, string key)
    {
        var lines = ReadLines(SeriesFile(day, key));
        if (lines.Count < 2 || FetchedAtOf(lines[0]) is not { } fetchedAt) return null;
        var bars = new List<(CandleWithVolume, decimal?, decimal?, long?, decimal?)>(lines.Count);
        foreach (var line in lines.Skip(2))
        {
            var f = line.Split(',');
            if (f.Length != 10 || !TryUtc(f[0], out var time) || !Dec(f[1], out var open) || !Dec(f[2], out var high) || !Dec(f[3], out var low)
                || !Dec(f[4], out var close) || !Long(f[5], out var volume)) continue;
            bars.Add((new CandleWithVolume(time, open, high, low, close, volume), OptDec(f[6]), OptDec(f[7]), OptLong(f[8]), OptDec(f[9])));
        }
        return bars.Count > 0 ? new SavedOptionSeries(fetchedAt, bars) : null;
    }

    /// <summary>Keeps today's futures backfill (`key` - OiReplayService's) as fetched at `fetchedAt`.</summary>
    public void SaveFutures(DateOnly day, string key, DateTimeOffset fetchedAt, IReadOnlyList<FuturesBar> bars, DateOnly? expiry, bool oiAvailable)
    {
        var sb = new StringBuilder();
        sb.Append("# fetched_utc=").Append(Utc(fetchedAt)).Append(",key=").Append(key)
          .Append(",expiry=").Append(expiry?.ToString("yyyy-MM-dd", Inv)).Append(",oi_available=").Append(oiAvailable ? "true" : "false").Append('\n')
          .Append(FuturesHeader).Append('\n');
        foreach (var b in bars)
            sb.Append(Utc(b.Time)).Append(',').Append(b.Open.ToString(Inv)).Append(',').Append(b.High.ToString(Inv)).Append(',')
              .Append(b.Low.ToString(Inv)).Append(',').Append(b.Close.ToString(Inv)).Append(',').Append(b.Volume.ToString(Inv)).Append(',')
              .Append(b.OpenInterest?.ToString(Inv)).Append('\n');
        WriteAtomic(SeriesFile(day, key), sb.ToString());
    }

    /// <summary>Today's saved futures backfill, else null.</summary>
    public SavedFutures? ReadFutures(DateOnly day, string key)
    {
        var lines = ReadLines(SeriesFile(day, key));
        if (lines.Count < 2 || FetchedAtOf(lines[0]) is not { } fetchedAt) return null;
        var meta = MetaOf(lines[0]);
        DateOnly? expiry = meta.TryGetValue("expiry", out var e) && DateOnly.TryParseExact(e, "yyyy-MM-dd", Inv, DateTimeStyles.None, out var d) ? d : null;
        var oiAvailable = meta.TryGetValue("oi_available", out var o) && o == "true";
        var bars = new List<FuturesBar>(lines.Count);
        foreach (var line in lines.Skip(2))
        {
            var f = line.Split(',');
            if (f.Length != 7 || !TryUtc(f[0], out var time) || !Dec(f[1], out var open) || !Dec(f[2], out var high) || !Dec(f[3], out var low)
                || !Dec(f[4], out var close) || !Long(f[5], out var volume)) continue;
            bars.Add(new FuturesBar(time, open, high, low, close, volume, OptLong(f[6])));
        }
        return bars.Count > 0 ? new SavedFutures(fetchedAt, bars, expiry, oiAvailable) : null;
    }

    /// <summary>Drops today's saved backfills whose key starts with `keyPrefix` (the page's Clear cache) - the next run asks
    /// Dhan afresh.</summary>
    public void DeleteSeries(DateOnly day, string keyPrefix)
    {
        var dir = Path.Combine(DayDir(day), "series");
        var prefix = SafeName(keyPrefix);
        try
        {
            if (!Directory.Exists(dir)) return;
            foreach (var file in Directory.EnumerateFiles(dir, "*.csv"))
                if (Path.GetFileName(file).StartsWith(prefix, StringComparison.Ordinal)) File.Delete(file);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning("Today's saved series under {Dir} not cleared ({Error}).", dir, ex.Message);
        }
    }

    /// <summary>Removes every day's folder before `today` - only today is kept here (past days are DhanDataCache's).</summary>
    public void RemoveOlderDays(DateOnly today)
    {
        try
        {
            if (!Directory.Exists(_root)) return;
            foreach (var dir in Directory.EnumerateDirectories(_root))
                if (DateOnly.TryParseExact(Path.GetFileName(dir), "yyyy-MM-dd", Inv, DateTimeStyles.None, out var day) && day < today)
                    Directory.Delete(dir, recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning("Older days under {Root} not removed ({Error}).", _root, ex.Message);
        }
    }

    // ---- Helpers ----

    private void WriteAtomic(string path, string content)
    {
        var tmp = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(tmp, content, Encoding.UTF8);
            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning("Today's data not saved to {Path} ({Error}).", path, ex.Message);
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    private List<string> ReadLines(string path)
    {
        try
        {
            return File.Exists(path) ? File.ReadAllLines(path, Encoding.UTF8).Select(l => l.TrimEnd('\r')).ToList() : new List<string>();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning("Today's saved data {Path} not read ({Error}).", path, ex.Message);
            return new List<string>();
        }
    }

    private static Dictionary<string, string> MetaOf(string firstLine)
    {
        var meta = new Dictionary<string, string>(StringComparer.Ordinal);
        if (!firstLine.StartsWith("# ", StringComparison.Ordinal)) return meta;
        foreach (var part in firstLine[2..].Split(','))
        {
            var eq = part.IndexOf('=');
            if (eq > 0) meta[part[..eq]] = part[(eq + 1)..];
        }
        return meta;
    }

    private static DateTimeOffset? FetchedAtOf(string firstLine) =>
        MetaOf(firstLine).TryGetValue("fetched_utc", out var v) && TryUtc(v, out var t) ? t : null;

    private static string Utc(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", Inv);

    // Read back at IST, as the live feed's bars and the rest of the server keep them.
    private static bool TryUtc(string s, out DateTimeOffset t)
    {
        if (!DateTimeOffset.TryParse(s, Inv, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out t)) return false;
        t = t.ToOffset(IstClock.Offset);
        return true;
    }

    private static bool Dec(string s, out decimal v) => decimal.TryParse(s, NumberStyles.Float, Inv, out v);
    private static bool Long(string s, out long v) => long.TryParse(s, NumberStyles.Integer, Inv, out v);
    private static decimal? OptDec(string s) => Dec(s, out var v) ? v : null;
    private static long? OptLong(string s) => Long(s, out var v) ? v : null;
}
