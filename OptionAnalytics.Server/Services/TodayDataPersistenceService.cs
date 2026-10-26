namespace OptionAnalytics.Server.Services;

/// <summary>
/// Keeps today's live minute bars (LiveOptionLegStore) on disk - TodayDiskStore's live-bars.csv - so a restart or a deploy
/// carries the day on instead of asking Dhan for it again. On start it removes the earlier days' folders and reads today's
/// saved minutes back into the store; then every 15 s it appends the minutes completed since (a minute is written once it
/// has been over for 5 s), and once more when the server stops. Disk only - no Dhan call.
/// </summary>
public sealed class TodayDataPersistenceService : BackgroundService
{
    public static readonly TimeSpan FlushEvery = TimeSpan.FromSeconds(15);
    /// <summary>How long after a minute ends it is written - a tick for it arriving a moment late still counts.</summary>
    public static readonly TimeSpan MinuteSettles = TimeSpan.FromSeconds(5);

    private readonly LiveOptionLegStore _store;
    private readonly TodayDiskStore _disk;
    private readonly ILogger<TodayDataPersistenceService> _logger;
    private readonly Func<DateTimeOffset> _clock;
    private readonly object _flushLock = new();
    private DateOnly _day;
    private long _flushedThrough = long.MinValue;

    public TodayDataPersistenceService(LiveOptionLegStore store, TodayDiskStore disk, ILogger<TodayDataPersistenceService> logger)
        : this(store, disk, logger, () => DateTimeOffset.UtcNow) { }

    internal TodayDataPersistenceService(LiveOptionLegStore store, TodayDiskStore disk, ILogger<TodayDataPersistenceService> logger, Func<DateTimeOffset> clock)
    {
        _store = store;
        _disk = disk;
        _logger = logger;
        _clock = clock;
    }

    /// <summary>Removes the earlier days' folders and reads today's saved minutes back into the store. Returns how many.</summary>
    internal int RestoreToday()
    {
        var today = IstDay(_clock());
        _disk.RemoveOlderDays(today);
        var rows = _disk.ReadLiveBars(today);
        _store.Restore(today, rows);
        lock (_flushLock)
        {
            _day = today;
            _flushedThrough = rows.Count > 0 ? rows.Max(r => MinuteOf(r.Minute)) : long.MinValue;
        }
        if (rows.Count > 0)
            _logger.LogInformation("Today's live minute bars read back from {Dir}: {Rows} rows, up to {Last:HH:mm} IST - no Dhan call for them.",
                _disk.DayDir(today), rows.Count, rows.Max(r => r.Minute).ToOffset(IstClock.Offset));
        return rows.Count;
    }

    /// <summary>Appends the minutes completed (and settled) since the last write. Returns how many rows were written.</summary>
    internal int FlushOnce()
    {
        var now = _clock();
        var day = IstDay(now);
        lock (_flushLock)
        {
            if (day != _day)
            {
                _day = day;
                _flushedThrough = long.MinValue;
                _disk.RemoveOlderDays(day);
            }
            var through = MinuteOf(now - MinuteSettles) - 1;
            if (through <= _flushedThrough) return 0;
            var rows = _store.CompletedBars(day, _flushedThrough, through);
            _disk.AppendLiveBars(day, rows);
            _flushedThrough = through;
            return rows.Count;
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { RestoreToday(); }
        catch (Exception ex) { _logger.LogWarning(ex, "Today's saved live bars could not be read back."); }
        using var timer = new PeriodicTimer(FlushEvery);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                try { FlushOnce(); }
                catch (Exception ex) { _logger.LogWarning(ex, "Today's live bars could not be saved."); }
            }
        }
        catch (OperationCanceledException) { }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken);
        // A deploy stops the server: the minutes completed since the last write go to disk first.
        try { FlushOnce(); }
        catch (Exception ex) { _logger.LogWarning(ex, "Today's live bars could not be saved at shutdown."); }
    }

    private static DateOnly IstDay(DateTimeOffset t) => DateOnly.FromDateTime(t.ToOffset(IstClock.Offset).DateTime);
    private static long MinuteOf(DateTimeOffset t) => t.ToUnixTimeSeconds() / 60;
}
