namespace OptionAnalytics.Server.Services;

/// <summary>Bound from the "HistoricalDataPrefetch" config section - governs
/// HistoricalSpotDataPrefetchHostedService. Off by default: downloading a year of NIFTY/BANKNIFTY
/// spot history, even paced and chunked, is real Dhan traffic that should be opted into per
/// deployment rather than kicking off automatically the moment Dhan credentials exist.</summary>
public sealed class HistoricalDataPrefetchOptions
{
    public const string SectionName = "HistoricalDataPrefetch";

    public bool Enabled { get; set; }
}
