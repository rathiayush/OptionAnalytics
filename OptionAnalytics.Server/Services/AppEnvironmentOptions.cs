namespace OptionAnalytics.Server.Services;

/// <summary>Bound from the "Environment" section of appsettings.json - the one explicit "is this
/// running on my own machine" setting, for a feature toggle that should behave differently in a
/// real deployment (where a live Dhan fallback is worth it, and where there may be no database
/// connection at all - see OiReplayService's own doc comment) than during local development
/// (where the whole point of the stored-data-only design was to avoid burning Dhan API quota).</summary>
public sealed class AppEnvironmentOptions
{
    public const string SectionName = "Environment";

    /// <summary>null (the default) auto-detects from IHostEnvironment.IsDevelopment() - true for a
    /// local `dotnet run`/IDE launch profile (see appsettings.Development.json/
    /// Properties/launchSettings.json), false wherever docker-compose.yml/Dockerfile's own
    /// ASPNETCORE_ENVIRONMENT=Production applies. Set this explicitly here to override that
    /// auto-detection - e.g. if a real deployment ever doesn't set ASPNETCORE_ENVIRONMENT the way
    /// this app's own docker-compose.yml/Dockerfile currently do.</summary>
    public bool? IsLocal { get; set; }

    /// <summary>Whether this server shows the LOCAL TOOLS - the AI analysis of a run (a local model). null (the default) follows <see cref="IsLocal"/>. It is its own setting because IsLocal also changes where past
    /// days come from (the stored database only, never Dhan - a machine with no database then cannot load a day at all): a developer's
    /// machine with no database sets IsLocal false and this true.</summary>
    public bool? LocalTools { get; set; }
}
