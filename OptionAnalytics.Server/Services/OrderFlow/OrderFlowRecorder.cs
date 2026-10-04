using System.IO.Compression;
using System.Text;

namespace OptionAnalytics.Server.Services.OrderFlow;

/// <summary>
/// Keeps each underlying's order flow day on disk - {root}/{UNDERLYING}/{yyyy-MM-dd}.ofd.gz - so a
/// restart (every deploy) does not wipe the day, and a past day can be replayed on the Order Flow page.
/// Dhan has no historical tick or market depth data at all, so a day exists here only if the server
/// was recording it.
///
/// The file is a compact gzipped binary dump of OrderFlowEngine.ExportDay (minute footprints, prints,
/// icebergs and the heatmap snapshots): JSON would be several times larger for the same day, almost
/// all of it the ~10,000 heatmap snapshots. Written to a temp file and moved into place, so a crash
/// mid-write never leaves a broken day. Storage:OrderFlowPath points it at the mounted volume in a
/// container; days older than OrderFlow:RetentionDays (default 60) are deleted.
/// </summary>
public sealed class OrderFlowRecorder
{
    private const string Magic = "OFD1";
    private const string Extension = ".ofd.gz";

    private readonly string _root;
    private readonly int _retentionDays;
    private readonly ILogger<OrderFlowRecorder> _logger;
    private readonly object _cacheLock = new();
    private readonly LinkedList<(string Key, DateTime Written, OrderFlowEngine Engine)> _cache = new();

    public OrderFlowRecorder(IHostEnvironment environment, IConfiguration configuration, ILogger<OrderFlowRecorder> logger)
    {
        var configured = configuration["Storage:OrderFlowPath"];
        _root = string.IsNullOrWhiteSpace(configured) ? Path.Combine(environment.ContentRootPath, "order-flow-data") : configured;
        _retentionDays = Math.Max(1, configuration.GetValue("OrderFlow:RetentionDays", 60));
        _logger = logger;
    }

    public string Root => _root;

    private string PathFor(string underlying, DateOnly day) => Path.Combine(_root, underlying.ToUpperInvariant(), day.ToString("yyyy-MM-dd") + Extension);

    public void Save(OrderFlowDay day)
    {
        var path = PathFor(day.Underlying, day.Day);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + ".tmp";
        using (var file = File.Create(temp))
        using (var gzip = new GZipStream(file, CompressionLevel.Fastest))
        using (var writer = new BinaryWriter(gzip, Encoding.UTF8))
            Write(writer, day);
        File.Move(temp, path, overwrite: true);
    }

    /// <summary>The saved day, or null when there is none (or it cannot be read).</summary>
    public OrderFlowDay? Load(string underlying, DateOnly day)
    {
        var path = PathFor(underlying, day);
        if (!File.Exists(path)) return null;
        try
        {
            using var file = File.OpenRead(path);
            using var gzip = new GZipStream(file, CompressionMode.Decompress);
            using var reader = new BinaryReader(gzip, Encoding.UTF8);
            return Read(reader);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not read the recorded order flow day {Path}.", path);
            return null;
        }
    }

    /// <summary>The recorded days for an underlying, newest first.</summary>
    public IReadOnlyList<RecordedOrderFlowDay> Days(string underlying)
    {
        var directory = Path.Combine(_root, underlying.ToUpperInvariant());
        if (!Directory.Exists(directory)) return Array.Empty<RecordedOrderFlowDay>();
        return Directory.EnumerateFiles(directory, "*" + Extension)
            .Select(f => (File: new FileInfo(f), Name: Path.GetFileName(f)[..^Extension.Length]))
            .Where(x => DateOnly.TryParseExact(x.Name, "yyyy-MM-dd", out _))
            .Select(x => new RecordedOrderFlowDay(DateOnly.ParseExact(x.Name, "yyyy-MM-dd"), x.File.Length, x.File.LastWriteTimeUtc))
            .OrderByDescending(d => d.Date)
            .ToList();
    }

    /// <summary>An engine holding a recorded day, cached (a day's file takes a moment to decode and
    /// replay asks for it again on every row-size or print-size change).</summary>
    public OrderFlowEngine? EngineFor(string underlying, DateOnly day)
    {
        var path = PathFor(underlying, day);
        if (!File.Exists(path)) return null;
        var written = File.GetLastWriteTimeUtc(path);
        var key = path;
        lock (_cacheLock)
        {
            for (var node = _cache.First; node is not null; node = node.Next)
            {
                if (node.Value.Key != key) continue;
                if (node.Value.Written == written) { _cache.Remove(node); _cache.AddFirst(node); return node.Value.Engine; }
                _cache.Remove(node);
                break;
            }
        }

        var saved = Load(underlying, day);
        if (saved is null) return null;
        var engine = OrderFlowEngine.FromDay(saved);
        lock (_cacheLock)
        {
            _cache.AddFirst((key, written, engine));
            while (_cache.Count > 3) _cache.RemoveLast();
        }
        return engine;
    }

    /// <summary>Deletes days past the retention period.</summary>
    public void Prune(DateOnly today)
    {
        if (!Directory.Exists(_root)) return;
        var cutoff = today.AddDays(-_retentionDays);
        foreach (var directory in Directory.EnumerateDirectories(_root))
        foreach (var file in Directory.EnumerateFiles(directory, "*" + Extension))
        {
            var name = Path.GetFileName(file)[..^Extension.Length];
            if (!DateOnly.TryParseExact(name, "yyyy-MM-dd", out var date) || date >= cutoff) continue;
            try { File.Delete(file); _logger.LogInformation("Deleted order flow recording {File} (older than {Days} days).", file, _retentionDays); }
            catch (Exception ex) { _logger.LogWarning(ex, "Could not delete old order flow recording {File}.", file); }
        }
    }

    // ---- binary format ----------------------------------------------------------------------------

    internal static void Write(BinaryWriter w, OrderFlowDay day)
    {
        w.Write(Encoding.ASCII.GetBytes(Magic));
        w.Write(day.Underlying);
        w.Write(day.SecurityId);
        w.Write(day.ContractSymbol);
        w.Write(day.ExchangeSegment);
        w.Write(day.TickSize);
        w.Write(day.LotSize);
        w.Write(day.Day.DayNumber);
        w.Write(day.Sequence);
        w.Write(day.LastPrice);
        w.Write(day.LastTradeAt?.UtcTicks ?? 0L);
        w.Write(day.Clock.UtcTicks);
        w.Write(day.DepthLevels);

        w.Write(day.Bars.Count);
        foreach (var bar in day.Bars)
        {
            w.Write(bar.Time.UtcTicks);
            w.Write(bar.Open); w.Write(bar.High); w.Write(bar.Low); w.Write(bar.Close);
            w.Write(bar.Buy); w.Write(bar.Sell); w.Write(bar.Trades);
            w.Write(bar.Levels.Length);
            foreach (var level in bar.Levels) { w.Write(level.Price); w.Write7BitEncodedInt64(level.Buy); w.Write7BitEncodedInt64(level.Sell); }
        }

        w.Write(day.Trades.Count);
        foreach (var trade in day.Trades)
        {
            w.Write(trade.Seq); w.Write(trade.Time.UtcTicks); w.Write(trade.Price); w.Write7BitEncodedInt64(trade.Quantity); w.Write(trade.Buy);
        }

        w.Write(day.Icebergs.Count);
        foreach (var i in day.Icebergs)
        {
            w.Write(i.Id); w.Write(i.IsBid); w.Write(i.Price);
            w.Write(i.StartedAt.UtcTicks); w.Write(i.DetectedAt.UtcTicks); w.Write(i.LastSeenAt.UtcTicks); w.Write(i.EndedAt?.UtcTicks ?? 0L);
            w.Write(i.Traded); w.Write(i.MaxDisplayed); w.Write(i.Refills);
        }

        w.Write(day.Snapshots.Count);
        foreach (var snapshot in day.Snapshots)
        {
            w.Write(snapshot.Time.UtcTicks);
            WriteRows(snapshot.Bids);
            WriteRows(snapshot.Asks);
        }

        // Rows are ascending: the first absolute, the rest as gaps from the previous one.
        void WriteRows(HeatRow[] rows)
        {
            w.Write7BitEncodedInt(rows.Length);
            var previous = 0;
            for (var i = 0; i < rows.Length; i++)
            {
                w.Write7BitEncodedInt(i == 0 ? rows[i].Row : rows[i].Row - previous);
                w.Write7BitEncodedInt(rows[i].Quantity);
                previous = rows[i].Row;
            }
        }
    }

    internal static OrderFlowDay Read(BinaryReader r)
    {
        if (Encoding.ASCII.GetString(r.ReadBytes(4)) != Magic) throw new InvalidDataException("not an order flow recording");
        static DateTimeOffset Utc(long ticks) => new(ticks, TimeSpan.Zero);
        static DateTimeOffset Ist(long ticks) => new DateTimeOffset(ticks, TimeSpan.Zero).ToOffset(IstClock.Offset);

        var underlying = r.ReadString();
        var securityId = r.ReadUInt32();
        var symbol = r.ReadString();
        var segment = r.ReadString();
        var tickSize = r.ReadDecimal();
        var lotSize = r.ReadInt32();
        var day = DateOnly.FromDayNumber(r.ReadInt32());
        var sequence = r.ReadInt64();
        var lastPrice = r.ReadDecimal();
        var lastTradeTicks = r.ReadInt64();
        var clock = Utc(r.ReadInt64());
        var depthLevels = r.ReadInt32();

        var bars = new List<OrderFlowDay.Bar>();
        for (int n = r.ReadInt32(), b = 0; b < n; b++)
        {
            var time = Ist(r.ReadInt64());
            decimal open = r.ReadDecimal(), high = r.ReadDecimal(), low = r.ReadDecimal(), close = r.ReadDecimal();
            long buy = r.ReadInt64(), sell = r.ReadInt64();
            var tradeCount = r.ReadInt32();
            var levels = new FootprintLevel[r.ReadInt32()];
            for (var i = 0; i < levels.Length; i++) levels[i] = new FootprintLevel(r.ReadDecimal(), r.Read7BitEncodedInt64(), r.Read7BitEncodedInt64());
            bars.Add(new OrderFlowDay.Bar(time, open, high, low, close, buy, sell, tradeCount, levels));
        }

        var trades = new List<OrderFlowTrade>();
        for (int n = r.ReadInt32(), i = 0; i < n; i++)
            trades.Add(new OrderFlowTrade(r.ReadInt64(), Utc(r.ReadInt64()), r.ReadDecimal(), r.Read7BitEncodedInt64(), r.ReadBoolean()));

        var icebergs = new List<OrderFlowIceberg>();
        for (int n = r.ReadInt32(), i = 0; i < n; i++)
        {
            var id = r.ReadInt64(); var isBid = r.ReadBoolean(); var price = r.ReadDecimal();
            var started = Utc(r.ReadInt64()); var detected = Utc(r.ReadInt64()); var lastSeen = Utc(r.ReadInt64()); var endedTicks = r.ReadInt64();
            icebergs.Add(new OrderFlowIceberg(id, isBid, price, started, detected, lastSeen, endedTicks == 0 ? null : Utc(endedTicks),
                r.ReadInt64(), r.ReadInt64(), r.ReadInt32()));
        }

        var snapshots = new List<OrderFlowDay.Snapshot>();
        for (int n = r.ReadInt32(), i = 0; i < n; i++)
            snapshots.Add(new OrderFlowDay.Snapshot(Utc(r.ReadInt64()), ReadRows(), ReadRows()));

        return new OrderFlowDay
        {
            Underlying = underlying, SecurityId = securityId, ContractSymbol = symbol, ExchangeSegment = segment, TickSize = tickSize,
            LotSize = lotSize, Day = day, Sequence = sequence, LastPrice = lastPrice, LastTradeAt = lastTradeTicks == 0 ? null : Utc(lastTradeTicks),
            Clock = clock, DepthLevels = depthLevels, Bars = bars, Trades = trades, Icebergs = icebergs, Snapshots = snapshots,
        };

        HeatRow[] ReadRows()
        {
            var rows = new HeatRow[r.Read7BitEncodedInt()];
            var previous = 0;
            for (var i = 0; i < rows.Length; i++)
            {
                var row = i == 0 ? r.Read7BitEncodedInt() : previous + r.Read7BitEncodedInt();
                rows[i] = new HeatRow(row, r.Read7BitEncodedInt());
                previous = row;
            }
            return rows;
        }
    }
}

public sealed record RecordedOrderFlowDay(DateOnly Date, long SizeBytes, DateTime SavedAtUtc);
