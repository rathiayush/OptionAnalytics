using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using OptionAnalytics.Server.TrueData;
using Xunit;

namespace OptionAnalytics.Server.Tests;

/// <summary>THE ONE SWITCH (asked for - "driven by config: truedata true then services and page will appear, else no"): TrueData:Enabled with
/// the login set registers the live feed, the tick history and the Tick Flow page's flag; off, nothing TrueData is registered.</summary>
public sealed class TrueDataSwitchTests
{
    private static IServiceCollection Register(params (string Key, string Value)[] settings)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(settings.Select(s => new KeyValuePair<string, string?>(s.Key, s.Value))).Build();
        var services = new ServiceCollection();
        TrueDataRegistration.AddTrueDataIfEnabled(services, config);
        return services;
    }

    private static bool Has<T>(IServiceCollection services) => services.Any(d => d.ServiceType == typeof(T));

    [Fact]
    public void Off_by_default_nothing_is_registered()
    {
        var services = Register();
        Assert.False(Has<TrueDataLiveFeed>(services));
        Assert.False(Has<TickHistoryDays>(services));
        Assert.False(Has<TrueDataOrderFlowSource>(services));
        Assert.False(new TrueDataOptions().TickFlowOn);
    }

    [Fact]
    public void Enabled_without_a_login_starts_no_feed()
    {
        var services = Register(("TrueData:Enabled", "true"));
        Assert.False(Has<TrueDataLiveFeed>(services));
        Assert.False(new TrueDataOptions { Enabled = true }.TickFlowOn);
    }

    [Fact]
    public void Enabled_with_a_login_registers_the_feed_and_the_page()
    {
        var services = Register(("TrueData:Enabled", "true"), ("TrueData:UserId", "u"), ("TrueData:Password", "p"));
        Assert.True(Has<TrueDataLiveFeed>(services));
        Assert.True(Has<TickHistoryDays>(services));
        Assert.True(Has<TrueDataOrderFlowSource>(services));
        Assert.True(new TrueDataOptions { Enabled = true, UserId = "u", Password = "p" }.TickFlowOn);
    }

    [Fact]
    public void Live_off_keeps_the_history_rebuild_but_no_feed_or_page()
    {
        var services = Register(("TrueData:Enabled", "true"), ("TrueData:UserId", "u"), ("TrueData:Password", "p"), ("TrueData:Live:Enabled", "false"));
        Assert.False(Has<TrueDataLiveFeed>(services));
        Assert.True(Has<TrueDataOrderFlowSource>(services));
    }

    [Fact]
    public void A_live_switch_alone_without_the_master_switch_does_nothing()
    {
        var services = Register(("TrueData:Live:Enabled", "true"), ("TrueData:UserId", "u"), ("TrueData:Password", "p"));
        Assert.False(Has<TrueDataLiveFeed>(services));
    }
}
