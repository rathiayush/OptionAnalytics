namespace OptionAnalytics.Server.Services;

/// <summary>Bound from the "OiReplay" section of appsettings.json - see OiReplayService's own doc
/// comment for why this page ever needs a live Dhan fallback at all, when it was originally built
/// deliberately stored-data-only.</summary>
public sealed class OiReplayOptions
{
    public const string SectionName = "OiReplay";

    /// <summary>null (the default) means "decide automatically": allow a live Dhan fallback only
    /// when NOT running in the Development environment. docker-compose.yml/Dockerfile always set
    /// ASPNETCORE_ENVIRONMENT=Production for a real deployment; a local `dotnet run`/IDE launch
    /// profile always sets Development (see appsettings.Development.json /
    /// Properties/launchSettings.json) - so this already-existing, zero-config signal is exactly
    /// "is this running on my own machine" without needing a separate flag to keep in sync. Set
    /// this explicitly to true/false to override that default (e.g. to test the live-fallback path
    /// locally, or to force this page back to pure stored-data-only on a deployed instance).</summary>
    public bool? AllowLiveDataFallback { get; set; }
}
