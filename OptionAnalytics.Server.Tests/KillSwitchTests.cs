using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>The daily loss limit (RiskSettingsStore) and the kill switch (KillSwitchService): Dhan's P&L based
/// exit set once a day at the limit, and at the limit - exit everything, block new orders, Dhan's kill switch on.
/// Dhan is a fake here - nothing is sent anywhere.</summary>
public sealed class KillSwitchTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "oa-risk-" + Guid.NewGuid().ToString("n"));
    private string FilePath => Path.Combine(_dir, "risk-settings.csv");
    // 10:00 IST on 9 Oct 2026.
    private static readonly DateTimeOffset T0 = new(2026, 10, 9, 4, 30, 0, TimeSpan.Zero);
    private static readonly DateOnly Day0 = new(2026, 10, 9);

    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Tests";
        public string ContentRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = null!;
    }

    private RiskSettingsStore Store() => new(new FakeHostEnvironment { ContentRootPath = _dir },
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Storage:RiskSettingsPath"] = FilePath }).Build(),
        NullLogger<RiskSettingsStore>.Instance);

    private sealed class FakeDhan : DhanTradersControlClient
    {
        public FakeDhan() : base(null!, NullLogger<DhanTradersControlClient>.Instance) { }
        public List<decimal> PnlExitsSet { get; } = new();
        public int Stops;
        public int Activations;
        public bool KillSwitchOn;
        public Func<string?> Activate { get; set; } = () => null;
        public override Task<string?> SetPnlExitAsync(decimal lossValue, decimal profitValue, CancellationToken cancellationToken) { PnlExitsSet.Add(lossValue); return Task.FromResult<string?>(null); }
        public override Task<string?> StopPnlExitAsync(CancellationToken cancellationToken) { Stops++; return Task.FromResult<string?>(null); }
        public override Task<bool?> KillSwitchActiveAsync(CancellationToken cancellationToken) => Task.FromResult<bool?>(KillSwitchOn);
        public override Task<string?> ActivateKillSwitchAsync(CancellationToken cancellationToken)
        {
            Activations++;
            var error = Activate();
            if (error is null) KillSwitchOn = true;
            return Task.FromResult(error);
        }
    }

    private sealed class FakeAccount : IKillSwitchAccount
    {
        public bool LoggedIn { get; set; } = true;
        public decimal Pnl { get; set; }
        public bool OpenPosition { get; set; }
        public int ExitAlls;
        public bool ExitFlattens { get; set; } = true;
        public LivePositionsSnapshot Snapshot() => new(
            OpenPosition ? new[] { new LivePositionRow("1", "NIFTY 25000 CE", "NSE_FNO", "INTRADAY", "SHORT", -65, true, 100, 120, -1300, 0, null, null) } : Array.Empty<LivePositionRow>(),
            Array.Empty<LivePendingOrder>(), Array.Empty<string>(), Pnl, T0, true, true, 20);
        public Task<ManualOrderResult> ExitAllAsync(CancellationToken cancellationToken)
        {
            ExitAlls++;
            if (ExitFlattens) OpenPosition = false;
            return Task.FromResult(new ManualOrderResult(true, "exited", Array.Empty<string>(), null));
        }
    }

    private (KillSwitchService Svc, FakeDhan Dhan, FakeAccount Account, RiskSettingsStore Store) Make()
    {
        var store = Store();
        var dhan = new FakeDhan();
        var account = new FakeAccount();
        var svc = new KillSwitchService(store, dhan, account, NullLogger<KillSwitchService>.Instance) { UtcNow = () => T0 };
        return (svc, dhan, account, store);
    }

    [Fact]
    public void Store_DefaultsTo20000On_AndIsWrittenWhenMissing()
    {
        var s = Store().Get();
        Assert.Equal(20_000m, s.DailyLossLimit);
        Assert.True(s.Enabled);
        Assert.True(File.Exists(FilePath));
    }

    [Fact]
    public void Store_TheLimitCanBeChangedOnceADay()
    {
        var store = Store();
        var (first, e1) = store.Change(15_000m, true, Day0);
        Assert.Null(e1);
        Assert.Equal(15_000m, first!.DailyLossLimit);
        var (_, e2) = store.Change(30_000m, true, Day0);
        Assert.Contains("already changed today", e2);
        Assert.Equal(15_000m, store.Get().DailyLossLimit);
        var (_, e3) = store.Change(15_000m, false, Day0);
        Assert.NotNull(e3); // switching it off is a change too
        var (next, e4) = store.Change(30_000m, true, Day0.AddDays(1));
        Assert.Null(e4);
        Assert.Equal(30_000m, next!.DailyLossLimit);
        Assert.Equal(30_000m, Store().Get().DailyLossLimit); // kept on disk
    }

    [Fact]
    public void Store_RejectsOutOfRange_AndNoChangeAfterATrip()
    {
        var store = Store();
        Assert.NotNull(store.Change(500m, true, Day0).Error);
        store.MarkTripped(Day0);
        Assert.Contains("tripped", store.Change(25_000m, true, Day0).Error);
    }

    [Fact]
    public async Task DhansPnlExit_IsSetOnceADayAtTheLimit_AndAgainWhenTheLimitChanges()
    {
        var (svc, dhan, _, store) = Make();
        await svc.CheckAsync(T0, default);
        await svc.CheckAsync(T0.AddSeconds(2), default);
        Assert.Equal(new[] { 20_000m }, dhan.PnlExitsSet);
        Assert.True(svc.Status().DhanPnlExitSet);
        store.Change(12_000m, true, Day0);
        await svc.CheckAsync(T0.AddSeconds(4), default);
        Assert.Equal(new[] { 20_000m, 12_000m }, dhan.PnlExitsSet);
        await svc.CheckAsync(T0.AddDays(1), default);
        Assert.Equal(3, dhan.PnlExitsSet.Count);
    }

    [Fact]
    public async Task BelowTheLimit_NothingTrips()
    {
        var (svc, dhan, account, _) = Make();
        account.Pnl = -19_999m;
        await svc.CheckAsync(T0, default);
        Assert.Equal(0, account.ExitAlls);
        Assert.Equal(0, dhan.Activations);
        Assert.Null(svc.BlockReason(T0));
        Assert.False(svc.Status().TrippedToday);
    }

    [Fact]
    public async Task AtTheLimit_ExitsEverything_BlocksNewOrders_AndTurnsTheKillSwitchOn()
    {
        var (svc, dhan, account, store) = Make();
        account.Pnl = -20_000m;
        account.OpenPosition = true;
        await svc.CheckAsync(T0, default);
        Assert.Equal(1, account.ExitAlls);
        Assert.Equal(Day0, store.Get().TrippedOn);
        Assert.Equal(1, dhan.Activations);
        Assert.True(svc.Status().DhanKillSwitchOn);
        Assert.Contains("daily loss limit", svc.BlockReason(T0));
        // It stays tripped for the day even if the P&L comes back, and nothing is sent again.
        account.Pnl = 5_000m;
        await svc.CheckAsync(T0.AddMinutes(1), default);
        Assert.Equal(1, account.ExitAlls);
        Assert.Equal(1, dhan.Activations);
        Assert.NotNull(svc.BlockReason(T0.AddMinutes(1)));
        // A restart keeps the block (the trip day is on disk); the next day is clear.
        var restarted = new KillSwitchService(Store(), new FakeDhan(), new FakeAccount(), NullLogger<KillSwitchService>.Instance);
        Assert.NotNull(restarted.BlockReason(T0));
        Assert.Null(restarted.BlockReason(T0.AddDays(1)));
    }

    [Fact]
    public async Task DhanRefusesTheKillSwitchUntilFlat_ItIsRetried_AndExitAllRunsAgain()
    {
        var (svc, dhan, account, _) = Make();
        account.Pnl = -25_000m;
        account.OpenPosition = true;
        account.ExitFlattens = false; // the first exit-all leaves something open
        dhan.Activate = () => account.OpenPosition ? "positions still open" : null;
        await svc.CheckAsync(T0, default);
        Assert.Equal(1, account.ExitAlls);
        Assert.Equal(1, dhan.Activations);
        Assert.False(dhan.KillSwitchOn);
        await svc.CheckAsync(T0.AddSeconds(2), default); // inside the 5s retry - nothing
        Assert.Equal(1, dhan.Activations);
        await svc.CheckAsync(T0.AddSeconds(6), default); // retried; exit-all not again yet (every 30s)
        Assert.Equal(2, dhan.Activations);
        Assert.Equal(1, account.ExitAlls);
        account.ExitFlattens = true;
        await svc.CheckAsync(T0.AddSeconds(31), default); // exit-all again, flat, accepted
        Assert.Equal(2, account.ExitAlls);
        Assert.True(dhan.KillSwitchOn);
        Assert.True(svc.Status().DhanKillSwitchOn);
    }

    [Fact]
    public async Task SwitchedOff_NoExitIsSet_NothingTrips_AndTodaysDhanExitIsStopped()
    {
        var (svc, dhan, account, store) = Make();
        await svc.CheckAsync(T0, default);
        Assert.Single(dhan.PnlExitsSet);
        store.Change(20_000m, false, Day0);
        account.Pnl = -50_000m;
        await svc.CheckAsync(T0.AddSeconds(2), default);
        Assert.Equal(1, dhan.Stops);
        Assert.Equal(0, account.ExitAlls);
        Assert.Null(svc.BlockReason(T0));
    }

    [Fact]
    public async Task LoggedOut_NothingIsSentToDhan()
    {
        var (svc, dhan, account, _) = Make();
        account.LoggedIn = false;
        account.Pnl = -50_000m;
        await svc.CheckAsync(T0, default);
        Assert.Empty(dhan.PnlExitsSet);
        Assert.Equal(0, account.ExitAlls);
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch { /* temp */ }
    }
}
