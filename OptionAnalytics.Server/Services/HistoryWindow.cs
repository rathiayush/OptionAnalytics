namespace OptionAnalytics.Server.Services;

/// <summary>
/// How much history every chart in this app holds, in one place.
///
/// SpotFeedHostedService (the spot chart) and CdvHostedService (each option strike's premium chart,
/// the OBV series built from them, and the CDV reconstruction) both backfill on startup, and they
/// have to agree: if the spot chart reached back further than the option charts, the two would
/// visibly disagree about where "history" begins, and a backtest walking spot bars would find no
/// option bars to trade against for the days only spot covered. They used to hold their own private
/// copies of these two numbers with a comment on each saying it must match the other - this is that
/// comment made mechanical.
///
/// Everything is in-memory only, so this is refetched from Dhan on every restart. Dhan serves
/// 1-minute intraday data for the last five years and caps a single request at 90 days, so the
/// window below is nowhere near either limit - it is a working-set choice, not an API one.
/// </summary>
public static class HistoryWindow
{
    /// <summary>Distinct IST trading days of 1-minute history kept per instrument, counted in days
    /// that actually traded rather than calendar days - a weekend or a holiday cluster shortens a
    /// calendar window but must not shorten the chart.</summary>
    public const int TradingDays = 45;

    /// <summary>How far back the single range request to Dhan asks, in calendar days. Deliberately
    /// wider than TradingDays needs (45 trading days is about 63 calendar days at 5 trading days a
    /// week) so a long weekend plus a festival cluster still leaves 45 days that traded inside the
    /// window; the response is then trimmed to the most recent TradingDays distinct dates actually
    /// present. 80 keeps the same ~17-day holiday/weekend-slop buffer the original 30/60 pair had
    /// (60 - 42 = 18) over the new 63-day base, while staying comfortably under - not flirting with -
    /// Dhan's documented 90-day-per-request cap (see the class doc above): doubling straight to 90
    /// the way 30->60 once did would land exactly ON that cap instead of nowhere near it.</summary>
    public const int LookbackCalendarDays = 80;
}
