namespace OptionAnalytics.Server.TrueData;

public static class TrueDataRegistration
{
    /// <summary>Registers TrueData only when TrueData:Enabled is true. With it false (the default) no
    /// TrueData type is registered, so nothing can create the SDK or call TrueData, and OrderFlowHistory
    /// gets no TrueData step (its optional dependency stays null) - the app runs exactly as without it.</summary>
    public static IServiceCollection AddTrueDataIfEnabled(this IServiceCollection services, IConfiguration configuration)
    {
        var section = configuration.GetSection(TrueDataOptions.SectionName);
        services.Configure<TrueDataOptions>(section);
        var options = section.Get<TrueDataOptions>();
        // TrueData's raw ticks on disk - its own store (Storage:TrueDataTicksPath): the live feed records into it, the tick history reads through it.
        if (options?.TickFlowOn == true || options?.Enabled == true) services.AddSingleton(sp => new TrueDataTickStore(
            TrueDataTickStore.ResolveRoot(configuration["Storage:TrueDataTicksPath"], sp.GetService<IHostEnvironment>()?.ContentRootPath ?? AppContext.BaseDirectory),
            sp.GetRequiredService<ILogger<TrueDataTickStore>>()));
        // The LIVE tick feed and the Tick Flow page: TrueData:Enabled (the master switch) with the login set - TickFlowOn.
        if (options?.TickFlowOn == true)
        {
            services.PostConfigure<TrueDataOptions>(o =>
            {
                if (string.IsNullOrWhiteSpace(o.Live.StatePath)) o.Live.StatePath = configuration["Storage:ScannerRunnerPath"] ?? "";
            });
            services.AddSingleton<TickDayDiskCache>();
            services.AddSingleton<TickHistoryDays>();
            services.AddSingleton<OptionTickHistoryDays>();
            services.AddSingleton<TrueDataLiveFeed>();
            services.AddHostedService(sp => sp.GetRequiredService<TrueDataLiveFeed>());
        }
        if (options?.Enabled != true) return services;
        services.AddSingleton<TrueDataSdkHistoryApi>();
        services.AddSingleton<ITrueDataHistoryApi>(sp => new CachingTrueDataHistoryApi(sp.GetRequiredService<TrueDataSdkHistoryApi>(), sp.GetRequiredService<TrueDataTickStore>()));
        services.AddSingleton<TrueDataOrderFlowSource>();
        return services;
    }
}
