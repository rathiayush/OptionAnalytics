namespace OptionAnalytics.Server.Models;

/// <summary>One bar of Dhan's rolling/expired-option history (POST /v2/charts/rollingoption) - a
/// CONTINUOUS series that splices in the next contract at the same relative expiry/strike position
/// as the date range crosses each one's own expiry, the same idea as a continuous front-month
/// futures chart. OpenInterest/Spot are nullable because they are only populated when asked for via
/// the request's own requiredData list, unlike Volume which this app always asks for.</summary>
public readonly record struct RollingOptionCandle(
    DateTimeOffset Time, decimal Open, decimal High, decimal Low, decimal Close, long Volume, long? OpenInterest, decimal? Spot);
