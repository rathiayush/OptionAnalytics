namespace OptionAnalytics.Server.Services;

/// <summary>Bound from the "ExpiredOptionDataPrefetch" config section - governs
/// ExpiredOptionDataPrefetchHostedService. Off by default, same reasoning as
/// HistoricalDataPrefetchOptions: downloading a year of NIFTY/BANKNIFTY rolling-option data across
/// every weekly/monthly expiry and the whole ATM+-10 band is an enormous amount of Dhan traffic (see
/// that hosted service's own doc comment for the real scale), so a deployment opts into it
/// explicitly rather than it running the moment Dhan credentials exist.</summary>
public sealed class ExpiredOptionDataPrefetchOptions
{
    public const string SectionName = "ExpiredOptionDataPrefetch";

    public bool Enabled { get; set; }
}
