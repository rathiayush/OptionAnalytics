namespace OptionAnalytics.Server.Models;

/// <summary>
/// A last line of defense against a corrupt option premium reaching a chart, a backtest, or a live
/// order - found via a Strike Data page chart whose price axis blew out to +14,000,000/-10,000,000
/// while its actual candles sat around 475, meaning at least one bar's OHLC held a garbage value
/// from somewhere upstream (Dhan's historical API, or a malformed live tick - both are external
/// input this app does not control). Every other page reading the same candle series (a backtest's
/// entry/stop/target math, a live trigger's UseLivePremiumEntry price, CDV's running delta) would
/// have silently absorbed that same garbage number with no visible symptom at all, unlike a chart
/// whose blown-out axis at least LOOKS wrong - which is what makes this worth checking at the
/// source rather than only where it happens to be visible.
///
/// Deliberately NOT the same bound a spot index would use - NIFTY/BANKNIFTY themselves trade in the
/// tens of thousands, but an option PREMIUM on either is a small fraction of that even deep ITM in
/// extreme volatility, so a premium anywhere near MaxPlausiblePremium is certain corruption, not a
/// real quote.
/// </summary>
public static class OptionPriceSanity
{
    /// <summary>Comfortably above any real NIFTY/BANKNIFTY option premium this app will ever see,
    /// yet nowhere near the spot-index-sized numbers (tens of thousands) or CDV/OBV running-total-
    /// sized numbers (hundreds of millions) that a genuine data mix-up would produce instead - a
    /// single fixed ceiling this far below either failure mode still separates "corrupt" from
    /// "real" cleanly.</summary>
    public const decimal MaxPlausiblePremium = 100_000m;

    /// <summary>A single premium print (a live tick's LastPrice) is plausible.</summary>
    public static bool IsPlausiblePrice(decimal price) => price > 0 && price <= MaxPlausiblePremium;

    /// <summary>A whole OHLC bar is plausible: every field is itself a plausible price, and the
    /// four values obey the one relationship real trading always produces - High is the largest,
    /// Low the smallest, Open and Close both fall inside that range. A bar failing any part of this
    /// (say Open/Close normal but High corrupted to a garbage magnitude) could still slip past a
    /// per-field-only check, since nothing about a single huge High technically requires it to be
    /// smaller than some other field - checking the full relationship is what actually catches
    /// that shape of corruption instead of just the price-per-field one.</summary>
    public static bool IsPlausibleBar(decimal open, decimal high, decimal low, decimal close)
    {
        if (!IsPlausiblePrice(open) || !IsPlausiblePrice(high) || !IsPlausiblePrice(low) || !IsPlausiblePrice(close))
            return false;

        return high >= low && high >= open && high >= close && low <= open && low <= close;
    }
}
