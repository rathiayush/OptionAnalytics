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
        if (section.Get<TrueDataOptions>()?.Enabled != true) return services;
        services.AddSingleton<ITrueDataHistoryApi, TrueDataSdkHistoryApi>();
        services.AddSingleton<TrueDataOrderFlowSource>();
        return services;
    }
}
