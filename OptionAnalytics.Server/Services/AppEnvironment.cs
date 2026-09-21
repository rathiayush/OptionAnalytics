using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Services;

/// <summary>Resolves AppEnvironmentOptions.IsLocal once at startup - see its own doc comment for
/// where the value comes from. Services key a "local dev vs. real deployment" toggle off THIS
/// (a singleton, resolved once) rather than each independently re-deriving
/// "options.Value.X ?? environment.IsDevelopment()", so they can never disagree with each other
/// about which mode the app is running in.</summary>
public sealed class AppEnvironment
{
    public bool IsLocal { get; }

    public AppEnvironment(IHostEnvironment environment, IOptions<AppEnvironmentOptions> options)
    {
        IsLocal = options.Value.IsLocal ?? environment.IsDevelopment();
    }
}
