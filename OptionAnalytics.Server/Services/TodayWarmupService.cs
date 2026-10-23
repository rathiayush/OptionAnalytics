using OptionAnalytics.Server.Services.OrderFlow;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Keeps TODAY ready on the server for every index, so switching index on the live OI Replay / Order Flow pages
/// shows at once - no page waits for a first load. During market hours (weekdays 09:16-15:35 IST) it asks, every
/// <see cref="Interval"/>, for each index's live OI Replay run (NIFTY / SENSEX weekly, BANKNIFTY monthly - what the
/// live page asks for) and each Order Flow engine's before-start backfill. The first ask of the day backfills from
/// Dhan once (OiReplayService / TodayFetchShare, OrderFlowHistory); every later one is served from memory, so this
/// costs Dhan nothing after that - and a server restart mid-day is ready again within one interval.
/// OiReplay:WarmToday = false turns it off; a local development server (AppEnvironment.IsLocal) never runs it - it
/// would call Dhan with nobody asking.
/// </summary>
public sealed class TodayWarmupService : BackgroundService
{
    internal static readonly TimeSpan Interval = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan FirstDelay = TimeSpan.FromSeconds(45);
    internal static readonly (string Underlying, string ExpiryFlag)[] Chains = { ("NIFTY", "WEEK"), ("BANKNIFTY", "MONTH"), ("SENSEX", "WEEK") };

    private readonly OiReplayService _oiReplay;
    private readonly OrderFlowService _orderFlow;
    private readonly OrderFlowHistory _orderFlowHistory;
    private readonly ILogger<TodayWarmupService> _logger;
    private readonly bool _enabled;
    // An index whose warm-up failed is asked again after 10 minutes, doubling to an hour - not every Interval.
    private readonly KeyedBackoff _backoff = new(TimeSpan.FromMinutes(10), TimeSpan.FromHours(1));

    public TodayWarmupService(OiReplayService oiReplay, OrderFlowService orderFlow, OrderFlowHistory orderFlowHistory,
        ILogger<TodayWarmupService> logger, IConfiguration? configuration = null, AppEnvironment? appEnvironment = null)
    {
        _oiReplay = oiReplay;
        _orderFlow = orderFlow;
        _orderFlowHistory = orderFlowHistory;
        _logger = logger;
        _enabled = (configuration?.GetValue("OiReplay:WarmToday", true) ?? true) && appEnvironment?.IsLocal != true;
    }

    /// <summary>Whether `now` is in today's warm window - a weekday, 09:16 to 15:35 IST.</summary>
    internal static bool InWindow(DateTimeOffset now)
    {
        var ist = now.ToOffset(IstClock.Offset);
        if (ist.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) return false;
        var t = ist.TimeOfDay;
        return t >= new TimeSpan(9, 16, 0) && t <= new TimeSpan(15, 35, 0);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_enabled) return;
        try { await Task.Delay(FirstDelay, stoppingToken); } catch (OperationCanceledException) { return; }
        while (!stoppingToken.IsCancellationRequested)
        {
            if (InWindow(DateTimeOffset.UtcNow)) await WarmAsync(stoppingToken);
            try { await Task.Delay(Interval, stoppingToken); } catch (OperationCanceledException) { return; }
        }
    }

    private async Task WarmAsync(CancellationToken cancellationToken)
    {
        var today = IstClock.Today();
        // One index after another - the first pass of the day is Dhan's rate-limited backfill.
        foreach (var (underlying, flag) in Chains)
        {
            if (_backoff.Due($"oi|{underlying}"))
            {
                try
                {
                    var run = await _oiReplay.RunAsync(underlying, today, 1, flag, cancellationToken, forceLive: true);
                    if (run.Success) _backoff.Succeeded($"oi|{underlying}");
                    else _logger.LogInformation("Warming today's OI Replay for {Underlying}: {Error} - next try in {Wait}.", underlying, run.Error, _backoff.Failed($"oi|{underlying}"));
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogWarning(ex, "Warming today's OI Replay for {Underlying} failed - next try in {Wait}.", underlying, _backoff.Failed($"oi|{underlying}"));
                }
            }
            if (_backoff.Due($"of|{underlying}"))
            {
                try
                {
                    if (_orderFlow.EngineFor(underlying) is { } engine)
                        await _orderFlowHistory.WithBackfillAsync(engine, engine.Snapshot(1, long.MaxValue, 1), cancellationToken);
                    _backoff.Succeeded($"of|{underlying}");
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogWarning(ex, "Warming today's Order Flow backfill for {Underlying} failed - next try in {Wait}.", underlying, _backoff.Failed($"of|{underlying}"));
                }
            }
        }
    }
}
