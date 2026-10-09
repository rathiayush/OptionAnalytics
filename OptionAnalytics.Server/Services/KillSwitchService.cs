using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Services;

/// <summary>What the kill switch needs from the live account (LiveTradingService) - a seam for the tests.</summary>
internal interface IKillSwitchAccount
{
    bool LoggedIn { get; }
    LivePositionsSnapshot Snapshot();
    Task<ManualOrderResult> ExitAllAsync(CancellationToken cancellationToken);
}

/// <summary>
/// The daily loss limit (RiskSettingsStore, default ₹20,000) on the whole Dhan account, in two layers:
/// <list type="number">
/// <item>Dhan's own P&L based exit, set every day at the limit with the kill switch on - Dhan exits every
/// intraday position and stops trading for the day when the loss is reached, even with this server down.</item>
/// <item>A watch here on the live P&L (LiveTradingService's realised + unrealised): at the limit it exits
/// everything (Dhan's exit-all plus the sweep of leftover orders), blocks new orders from this app for the
/// rest of the day, and turns Dhan's kill switch on - retrying until Dhan accepts it (Dhan needs the
/// account flat first). Telegram is told at each step.</item>
/// </list>
/// Once tripped it stays tripped for the day (kept on disk), whatever happens to the P&L after.
/// </summary>
public sealed class KillSwitchService : BackgroundService
{
    /// <summary>Dhan's P&L based exit needs a profit level too - set out of reach, only the loss matters.</summary>
    internal const decimal ProfitCeiling = 1_00_00_000m;
    internal static readonly TimeSpan CheckInterval = TimeSpan.FromSeconds(2);
    internal static readonly TimeSpan ArmRetryInterval = TimeSpan.FromMinutes(1);
    internal static readonly TimeSpan KillRetryInterval = TimeSpan.FromSeconds(5);
    internal static readonly TimeSpan ExitRetryInterval = TimeSpan.FromSeconds(30);

    private readonly RiskSettingsStore _store;
    private readonly DhanTradersControlClient _dhan;
    private readonly IKillSwitchAccount _account;
    private readonly TelegramAlertService? _telegram;
    private readonly ILogger<KillSwitchService> _logger;
    private readonly object _lock = new();
    private readonly SemaphoreSlim _checkLock = new(1, 1);

    private DateOnly? _armedDay;
    private decimal? _armedLimit;
    private string? _armError;
    private DateTimeOffset _nextArmAttempt = DateTimeOffset.MinValue;
    private DateOnly? _disarmedDay;
    private DateOnly? _killActiveDay;
    private string? _killError;
    private DateTimeOffset _nextKillAttempt = DateTimeOffset.MinValue;
    private DateTimeOffset _lastExitAttempt = DateTimeOffset.MinValue;
    private string? _exitResult;
    private DateTimeOffset? _trippedAt;
    private decimal? _trippedPnl;
    private decimal? _dayPnl;
    private DateTimeOffset? _checkedAt;

    /// <summary>The clock (tests pin it).</summary>
    internal Func<DateTimeOffset> UtcNow { get; set; } = () => DateTimeOffset.UtcNow;

    public KillSwitchService(RiskSettingsStore store, DhanTradersControlClient dhan, LiveTradingService trading, DhanSession session,
        ILogger<KillSwitchService> logger, TelegramAlertService? telegram = null)
        : this(store, dhan, new LiveAccount(trading, session), logger, telegram)
    {
        // No new order from this app once the day's loss limit is reached.
        trading.NewOrderBlock = () => BlockReason(UtcNow());
    }

    internal KillSwitchService(RiskSettingsStore store, DhanTradersControlClient dhan, IKillSwitchAccount account,
        ILogger<KillSwitchService> logger, TelegramAlertService? telegram = null)
    {
        _store = store;
        _dhan = dhan;
        _account = account;
        _logger = logger;
        _telegram = telegram;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await CheckAsync(UtcNow(), stoppingToken); }
            catch (Exception ex) when (ex is not OperationCanceledException) { _logger.LogWarning(ex, "Kill switch check failed."); }
            try { await Task.Delay(CheckInterval, stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    /// <summary>Why a new order must not go out now (the limit reached today), else null.</summary>
    public string? BlockReason(DateTimeOffset now)
    {
        var s = _store.Get();
        if (!s.Enabled) return null;
        var today = IstClock.IstDate(now);
        if (s.TrippedOn == today)
            return $"the daily loss limit (₹{s.DailyLossLimit:N0}) was reached today - the kill switch is on, no new orders until tomorrow";
        decimal? pnl;
        lock (_lock) pnl = _dayPnl;
        return pnl <= -s.DailyLossLimit ? $"the day's P&L (₹{pnl:N0}) is at the daily loss limit (₹{s.DailyLossLimit:N0}) - no new orders" : null;
    }

    /// <summary>One look: keep Dhan's P&L based exit set for today, watch the P&L, and after a trip get the
    /// account flat and the kill switch on.</summary>
    internal async Task CheckAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        await _checkLock.WaitAsync(cancellationToken);
        try
        {
            lock (_lock) _checkedAt = now;
            if (!_account.LoggedIn) return;
            var s = _store.Get();
            var today = IstClock.IstDate(now);

            await KeepDhanPnlExitAsync(s, today, now, cancellationToken);

            var snapshot = _account.Snapshot();
            if (snapshot.RefreshedUtc is not null) lock (_lock) _dayPnl = snapshot.DayPnl;
            if (s.Enabled && s.TrippedOn != today && snapshot.RefreshedUtc is not null && snapshot.DayPnl <= -s.DailyLossLimit)
            {
                s = _store.MarkTripped(today);
                lock (_lock) { _trippedAt = now; _trippedPnl = snapshot.DayPnl; _killError = null; }
                _logger.LogWarning("KILL SWITCH: the day's P&L {Pnl} reached the daily loss limit {Limit} - exiting everything.", snapshot.DayPnl, s.DailyLossLimit);
                await TellAsync($"🛑 KILL SWITCH: day's P&L ₹{snapshot.DayPnl:N0} hit the daily loss limit ₹{s.DailyLossLimit:N0}. Exiting every position, cancelling every order, then turning Dhan's kill switch on - no more trading today.", cancellationToken);
                await ExitAllAsync(now, cancellationToken);
            }

            if (s.Enabled && s.TrippedOn == today) await KeepKillSwitchOnAsync(snapshot, today, now, cancellationToken);
        }
        finally
        {
            _checkLock.Release();
        }
    }

    private async Task KeepDhanPnlExitAsync(RiskSettings s, DateOnly today, DateTimeOffset now, CancellationToken cancellationToken)
    {
        bool armed;
        lock (_lock) armed = _armedDay == today && _armedLimit == s.DailyLossLimit;
        if (!s.Enabled)
        {
            // Switched off: stop today's exit on Dhan once (it would otherwise hold until the session ends).
            bool wasArmed;
            lock (_lock) wasArmed = _armedDay == today && _disarmedDay != today;
            if (!wasArmed) return;
            var stopError = await _dhan.StopPnlExitAsync(cancellationToken);
            lock (_lock) { _disarmedDay = today; _armedDay = null; _armedLimit = null; _armError = stopError; }
            return;
        }
        if (armed || s.TrippedOn == today || now < _nextArmAttempt) return;
        var error = await _dhan.SetPnlExitAsync(s.DailyLossLimit, ProfitCeiling, cancellationToken);
        lock (_lock)
        {
            _armError = error;
            if (error is null) { _armedDay = today; _armedLimit = s.DailyLossLimit; _disarmedDay = null; }
            else _nextArmAttempt = now + ArmRetryInterval;
        }
        if (error is null)
        {
            _logger.LogInformation("Dhan P&L based exit set for {Day}: loss ₹{Limit} with the kill switch.", today, s.DailyLossLimit);
            await TellAsync($"Daily loss limit set on Dhan for today: ₹{s.DailyLossLimit:N0} - at that loss Dhan exits every position and turns the kill switch on.", cancellationToken);
        }
    }

    private async Task KeepKillSwitchOnAsync(LivePositionsSnapshot snapshot, DateOnly today, DateTimeOffset now, CancellationToken cancellationToken)
    {
        lock (_lock) if (_killActiveDay == today || now < _nextKillAttempt) return;
        lock (_lock) _nextKillAttempt = now + KillRetryInterval;
        if (await _dhan.KillSwitchActiveAsync(cancellationToken) == true)
        {
            await KillSwitchOnAsync(today, cancellationToken);
            return;
        }
        // Dhan turns the kill switch on only with the account flat - anything still open is exited again.
        var notFlat = snapshot.Positions.Any(p => p.IsOpen) || snapshot.PendingOrders.Count > 0;
        if (notFlat && now - _lastExitAttempt >= ExitRetryInterval) await ExitAllAsync(now, cancellationToken);
        var error = await _dhan.ActivateKillSwitchAsync(cancellationToken);
        if (error is null) { await KillSwitchOnAsync(today, cancellationToken); return; }
        lock (_lock) _killError = error;
    }

    private async Task KillSwitchOnAsync(DateOnly today, CancellationToken cancellationToken)
    {
        lock (_lock) { _killActiveDay = today; _killError = null; }
        _logger.LogWarning("KILL SWITCH: Dhan's kill switch is ON for {Day}.", today);
        await TellAsync("🛑 Dhan kill switch is ON - trading is disabled on the account for the rest of the day.", cancellationToken);
    }

    private async Task ExitAllAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        _lastExitAttempt = now;
        ManualOrderResult result;
        try { result = await _account.ExitAllAsync(cancellationToken); }
        catch (Exception ex) when (ex is not OperationCanceledException) { result = ManualOrderResult.Fail(ex.Message); }
        lock (_lock) _exitResult = result.Message;
        await TellAsync($"Kill switch exit-all: {result.Message}", cancellationToken);
    }

    private async Task TellAsync(string text, CancellationToken cancellationToken)
    {
        if (_telegram is null || !_telegram.IsConfigured) return;
        try { await _telegram.SendAsync(text, cancellationToken); }
        catch (Exception ex) when (ex is not OperationCanceledException) { _logger.LogWarning(ex, "Kill switch: Telegram failed."); }
    }

    /// <summary>What the Trade settings page shows.</summary>
    public KillSwitchStatus Status()
    {
        var s = _store.Get();
        var now = UtcNow();
        var today = IstClock.IstDate(now);
        lock (_lock)
        {
            return new KillSwitchStatus(
                s.DailyLossLimit, s.Enabled, s.ChangedOn, s.ChangedOn != today, s.TrippedOn == today,
                s.TrippedOn == today ? _trippedAt : null, s.TrippedOn == today ? _trippedPnl : null, _dayPnl,
                _armedDay == today && _armedLimit == s.DailyLossLimit, _armError,
                _killActiveDay == today, s.TrippedOn == today ? _killError : null, s.TrippedOn == today ? _exitResult : null,
                _account.LoggedIn, _checkedAt, Path.GetFileName(_store.FilePath));
        }
    }

    private sealed class LiveAccount : IKillSwitchAccount
    {
        private readonly LiveTradingService _trading;
        private readonly DhanSession _session;
        public LiveAccount(LiveTradingService trading, DhanSession session) { _trading = trading; _session = session; }
        public bool LoggedIn => _session.IsAuthenticated;
        public LivePositionsSnapshot Snapshot() => _trading.Snapshot();
        public Task<ManualOrderResult> ExitAllAsync(CancellationToken cancellationToken) => _trading.EmergencyExitAllAsync(cancellationToken);
    }
}

/// <summary>The daily loss limit and kill switch as the Trade settings page shows them.</summary>
public sealed record KillSwitchStatus(
    decimal DailyLossLimit, bool Enabled, DateOnly? ChangedOn, bool CanChangeToday, bool TrippedToday,
    DateTimeOffset? TrippedAtUtc, decimal? TrippedPnl, decimal? DayPnl,
    bool DhanPnlExitSet, string? DhanPnlExitError, bool DhanKillSwitchOn, string? DhanKillSwitchError, string? ExitResult,
    bool DhanLoggedIn, DateTimeOffset? CheckedUtc, string File);
