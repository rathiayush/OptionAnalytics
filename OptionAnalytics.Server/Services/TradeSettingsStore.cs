using System.Globalization;
using System.Text;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The trade settings per index, in ONE CSV file on the server (Storage:TradeSettingsPath, default
/// /app/data/trade-settings.csv on the volume): the default lots, the option stop-loss / target and trailing
/// stop in premium points, the live order slippage, whether the server scanner runs the index and what it
/// trades on an alert. Every page reads them (the OI Replay trade panel, the Order Flow scanner, the Trade
/// settings page) and so does the server scanner - set once, used everywhere, with or without a page open.
/// A missing (or unreadable) file is written again with the defaults; an index missing from it gets its
/// defaults. Rewritten atomically (temp file + move) under a lock.
/// </summary>
public sealed class TradeSettingsStore
{
    public static readonly string[] Underlyings = { "NIFTY", "BANKNIFTY", "SENSEX" };
    public static readonly string[] Columns = { "underlying", "lots", "sl_points", "target_points", "trail_start", "trail_gap", "slippage_points", "scanner_enabled", "auto_trade", "updated_utc" };
    // "strategy": each strategy buys or sells what its own tuned setting says (Strategy tuning - Apply to the
    // scanner), selling where it has none. "sell" / "buy" are a choice for the whole index and override that.
    public static readonly string[] AutoTrades = { "sell", "buy", "off", "strategy" };

    // The premiums of BANKNIFTY / SENSEX move ~2.5x / ~3x NIFTY's - their stops and targets are wider.
    public static TradeSettings Default(string underlying) => underlying switch
    {
        "BANKNIFTY" => new TradeSettings("BANKNIFTY", 1, 50, 75, 0, 0, 2, true, "sell", null),
        "SENSEX" => new TradeSettings("SENSEX", 1, 60, 90, 0, 0, 2, true, "sell", null),
        _ => new TradeSettings(underlying, 1, 20, 30, 0, 0, 2, true, "sell", null),
    };

    private readonly string _path;
    private readonly object _lock = new();
    private readonly ILogger<TradeSettingsStore> _logger;

    public TradeSettingsStore(IHostEnvironment environment, IConfiguration configuration, ILogger<TradeSettingsStore> logger)
    {
        var configured = configuration["Storage:TradeSettingsPath"];
        var path = string.IsNullOrWhiteSpace(configured) ? "trade-settings.csv" : configured;
        _path = Path.IsPathRooted(path) ? path : Path.Combine(environment.ContentRootPath, path);
        _logger = logger;
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
    }

    public string FilePath => _path;

    /// <summary>Every index's settings - the file is (re)created with the defaults when it is not there.</summary>
    public IReadOnlyList<TradeSettings> All()
    {
        lock (_lock)
        {
            var rows = Read();
            if (rows is null || Underlyings.Any(u => !rows.ContainsKey(u)))
            {
                rows ??= new Dictionary<string, TradeSettings>();
                foreach (var u in Underlyings) rows.TryAdd(u, Default(u));
                Write(rows);
            }
            return Underlyings.Select(u => rows[u]).ToList();
        }
    }

    public TradeSettings Get(string underlying) => All().FirstOrDefault(s => s.Underlying == underlying) ?? Default(underlying);

    /// <summary>Validates and saves one index's settings. Returns the saved row, or an error.</summary>
    public (TradeSettings? Saved, string? Error) Save(string underlying, TradeSettings request)
    {
        var u = underlying.Trim().ToUpperInvariant();
        if (!Underlyings.Contains(u)) return (null, $"Unknown index {underlying}.");
        if (request.Lots is < 1 or > 500) return (null, "Lots must be 1 to 500.");
        if (request.SlPoints is < 0 or > 5000 || request.TargetPoints is < 0 or > 5000) return (null, "SL and target must be 0 to 5000 points.");
        if (request.TrailStart is < 0 or > 5000 || request.TrailGap is < 0 or > 5000) return (null, "Trailing must be 0 to 5000 points.");
        if (request.SlippagePoints is < 0 or > 100) return (null, "Slippage must be 0 to 100 points.");
        var auto = (request.AutoTrade ?? "sell").Trim().ToLowerInvariant();
        if (!AutoTrades.Contains(auto)) return (null, "Auto trade must be sell, buy, off or strategy.");
        var saved = request with { Underlying = u, AutoTrade = auto, UpdatedUtc = DateTimeOffset.UtcNow };
        lock (_lock)
        {
            var rows = Read() ?? new Dictionary<string, TradeSettings>();
            foreach (var x in Underlyings) rows.TryAdd(x, Default(x));
            rows[u] = saved;
            Write(rows);
        }
        return (saved, null);
    }

    private Dictionary<string, TradeSettings>? Read()
    {
        try
        {
            if (!File.Exists(_path)) return null;
            var lines = File.ReadAllLines(_path).Where(l => l.Trim().Length > 0).ToList();
            if (lines.Count == 0) return null;
            var head = lines[0].Split(',').Select(h => h.Trim()).ToList();
            int Col(string name) => head.IndexOf(name);
            var rows = new Dictionary<string, TradeSettings>();
            foreach (var line in lines.Skip(1))
            {
                var cells = line.Split(',');
                string Cell(string name) => Col(name) is var i and >= 0 && i < cells.Length ? cells[i].Trim() : "";
                var u = Cell("underlying").ToUpperInvariant();
                if (!Underlyings.Contains(u)) continue;
                var d = Default(u);
                rows[u] = new TradeSettings(u,
                    Int(Cell("lots"), d.Lots), Dec(Cell("sl_points"), d.SlPoints), Dec(Cell("target_points"), d.TargetPoints),
                    Dec(Cell("trail_start"), d.TrailStart), Dec(Cell("trail_gap"), d.TrailGap), Dec(Cell("slippage_points"), d.SlippagePoints),
                    bool.TryParse(Cell("scanner_enabled"), out var on) ? on : d.ScannerEnabled,
                    AutoTrades.Contains(Cell("auto_trade").ToLowerInvariant()) ? Cell("auto_trade").ToLowerInvariant() : d.AutoTrade,
                    DateTimeOffset.TryParse(Cell("updated_utc"), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) ? at : null);
            }
            return rows;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Trade settings: {Path} could not be read - writing it again with the defaults.", _path);
            return null;
        }
    }

    private void Write(Dictionary<string, TradeSettings> rows)
    {
        var csv = new StringBuilder();
        csv.AppendLine(string.Join(',', Columns));
        foreach (var u in Underlyings)
        {
            var s = rows[u];
            csv.AppendLine(string.Join(',', s.Underlying, s.Lots.ToString(CultureInfo.InvariantCulture), Num(s.SlPoints), Num(s.TargetPoints), Num(s.TrailStart),
                Num(s.TrailGap), Num(s.SlippagePoints), s.ScannerEnabled ? "true" : "false", s.AutoTrade, s.UpdatedUtc?.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture) ?? ""));
        }
        var temp = _path + ".tmp";
        File.WriteAllText(temp, csv.ToString());
        File.Move(temp, _path, overwrite: true);
    }

    private static string Num(decimal v) => v.ToString("0.##", CultureInfo.InvariantCulture);
    private static int Int(string s, int fallback) => int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : fallback;
    private static decimal Dec(string s, decimal fallback) => decimal.TryParse(s, NumberStyles.Number, CultureInfo.InvariantCulture, out var v) ? v : fallback;
}

/// <summary>One index's trade settings - see TradeSettingsStore. Points are option premium points;
/// AutoTrade is what the server scanner does on an alert: "sell" or "buy" the option (paper), "strategy" (each
/// strategy's own tuned setting), or "off".</summary>
public sealed record TradeSettings(
    string Underlying, int Lots, decimal SlPoints, decimal TargetPoints, decimal TrailStart, decimal TrailGap, decimal SlippagePoints,
    bool ScannerEnabled, string AutoTrade, DateTimeOffset? UpdatedUtc);
