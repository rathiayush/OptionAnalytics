using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A genuine multi-timeframe cascade, per the user's own follow-up refinement of the "NIFTY &amp;
/// BANKNIFTY - Adaptive Option Selling Strategy" flowchart: REGIME -&gt; SETUP -&gt; CONFIRM -&gt; ENTRY,
/// each stage gating the next, rather than one score computed off a single timeframe.
///
/// ALL FOUR LAYERS SCALE WITH THE PAGE'S OWN SELECTED TIMEFRAME (<c>context.TimeframeMinutes</c>),
/// not fixed real-clock minutes: ENTRY runs at the page's own timeframe, CONFIRM at 3x that, SETUP at
/// 5x, REGIME at 15x - so changing the Backtrack/Expired Backtest page from 1-minute to 3-minute
/// re-bases the whole cascade to 3/9/15/45 minutes, keeping the same 1:3:5:15 ratio the flowchart's
/// own diagram used. All four layers are built once per run straight from
/// <see cref="BacktestStrategyContext.SpotBarsOneMinute"/> (via BacktestUtil.AggregateCandles); the
/// ENTRY layer is exactly <see cref="BacktestStrategyContext.SpotBars"/> (already aggregated to
/// <c>context.TimeframeMinutes</c>), which is also what the Range-fade path and the ATR volatility
/// gate below use, so there is only ever one "page timeframe" bar series in play, not two.
///
/// REGIME SCORE (0-5), computed fresh on every REGIME-layer bar (15x the page timeframe):
///   1. 15M EMA ALIGNMENT: EMA-fast &gt; EMA-mid (Bearish is the mirror) - this point is MANDATORY;
///      without a directional stack there is no candidate direction to score the other four against.
///   2. REGIME EMA SLOPE: that same fast EMA's slope (over <c>cascadeSlopeLookbackBars</c>) at least
///      +<c>regime15SlopeMinPercent</c> in the aligned direction.
///   3. REGIME ADX &gt;= <c>regime15AdxMin</c>.
///   4. PRICE VS VWAP: the REGIME-layer bar's own close on the aligned side of session VWAP.
///   5. SETUP EMA CONFIRMATION: the SETUP-layer EMA stack (its OWN pair, <c>setup5EmaFast</c>/
///      <c>setup5EmaSlow</c>) agrees with the same direction.
/// Score &gt;= <c>regimeScoreFull</c> (4) is full-confidence Trend; score &gt;= <c>regimeScoreMin</c>
/// (3) but below that is still attempted, just labelled "selective/reduced confidence" in the signal
/// text (this app has no lot-size/quantity model to actually reduce a real position by); anything
/// below <c>regimeScoreMin</c> never attempts a trend trade at all - the Range path picks it up
/// instead, per the flowchart's own "0-2 -&gt; don't use trend strategy."
///
/// THE CASCADE ITSELF, once a REGIME-layer bar's regime clears <c>regimeScoreMin</c>, at every
/// ENTRY-layer bar (the page's own timeframe) for as long as that regime holds:
///   - SETUP: the SETUP-layer EMA stack + ADX(&gt;=<c>setup5AdxMin</c>) + price on the matching side
///     of VWAP, all on the SETUP-layer bar most recently closed at or before this ENTRY bar's time.
///   - CONFIRM: the CONFIRM-layer EMA stack + ADX(&gt;=<c>confirm3AdxMin</c>) + slope
///     (&gt;=<c>confirm3SlopeMinPercent</c>) + that CONFIRM-layer bar's own candle closing in the
///     trend's direction (close vs open) - the flowchart's own "confirmation candle closes bullish."
///   - ENTRY: the ENTRY-layer EMA-fast/EMA-mid pair (<c>entry1EmaFast</c>/<c>entry1EmaSlow</c>)
///     crossing back in the trend's favor (a pullback that just got rejected) at any point within
///     the last <c>entry1CrossWithinBars</c> ENTRY-layer bars - not necessarily the exact same bar as
///     the SETUP/CONFIRM gates. This window exists because SETUP/CONFIRM/REGIME are LEVEL conditions
///     (true for their whole bucket once it closes) while the ENTRY-layer cross is a single-bar EDGE
///     event; without look-ahead bias (see the alignment helpers below), the CONFIRM-layer bar closes
///     up to a full CONFIRM bucket after the ENTRY-layer EMA cross itself, so requiring both on the
///     exact same bar would make the cascade nearly impossible to complete even in genuine trends -
///     real live trading never gets that razor-exact a coincidence across three closing clocks
///     either. Once the window condition is met the entry still needs its own
///     ADX(&gt;=<c>entry1AdxMin</c>)/slope(&gt;=<c>entry1SlopeMinPercent</c>) gates and an
///     RSI-neutral check (<c>rsiNeutralLow</c>-<c>rsiNeutralHigh</c>) so the entry isn't sold into
///     what might already be a breakout.
/// All four stages have to agree by the time the entry fires - a real confluence requirement, so
/// entries are expected to be rare (this is intentional, not a bug: waiting for a genuine
/// multi-timeframe lineup is the whole point of a cascade over a single-timeframe score).
///
/// RANGE STRATEGY: unchanged in mechanism from the single-timeframe version - fades the extremes of
/// a VWAP+-ATR band on the ENTRY/page timeframe (<c>rangeAtrMultiple</c> x ATR either side of VWAP),
/// RSI-neutral gated - but now only attempted when the REGIME-layer score reads below
/// <c>regimeScoreMin</c> (i.e., genuinely not trending), so this and the cascade above never both
/// fire into the same market condition. Its own signal text additionally labels the bar "Choppy"
/// (ADX &lt;= <c>chopAdxMax</c> AND the REGIME-layer EMA slope within +-<c>chopFlatSlopePercent</c>
/// of flat) versus a plainer "weak trend" when the score is merely low without those two also reading
/// genuinely flat/directionless - a label only, it does not change what fires, but it directly answers
/// "let me see the market is actually being read as choppy," not just infer it from an absence.
///
/// VOLATILE REGIME - a THIRD, higher-priority condition, checked ahead of both of the above and
/// capable of overriding either: this app has no VIX feed (see TechnicalIndicators' own doc comment),
/// so instead of one fixed ATR%-of-price cutoff alone (which has to be hand-tuned per underlying/price
/// level and never adapts on its own), four independent, mostly SELF-REFERENCING signals are ORed
/// together - any one being true marks the bar Volatile:
///   1. ATR is still at/above the fixed <c>atrExtremePercent</c> cutoff (kept for continuity/backward
///      compatibility with the single-timeframe version).
///   2. ATR has EXPANDED to at least <c>atrExpansionRatio</c> x its own rolling
///      <c>atrAverageLookbackBars</c>-bar average - "volatility is spiking right now relative to its
///      OWN recent normal," which adapts automatically to whatever underlying/price level/timeframe is
///      running, unlike a fixed % cutoff.
///   3. The current candle's own High-Low range is at least <c>largeCandleRatio</c> x its own rolling
///      average range - a single outsized bar, even before ATR's own smoothing has caught up to it.
///   4. The opening gap (|Open - previous Close|) is at least <c>gapAtrMultiple</c> x ATR - a sudden
///      jump between bars, which neither ATR nor a same-bar range check would necessarily flag on its
///      own.
/// A Volatile bar suspends BOTH the Trend cascade's final entry and the Range fade's final entry (the
/// closest a single-trade decision can get to the flowchart's own "reduce size / stay out until it
/// settles" - see this class's own "what this does not do" section on position sizing) - checked at
/// the actual entry moment, which is the same ENTRY/page-timeframe bar for both paths (see the note
/// above on there being only one page-timeframe series), not baked into the REGIME-layer score
/// itself, so a bar that was calm when the regime last updated but has since gone volatile is still
/// caught.
///
/// No CDV/OBV order-flow filter - an earlier version of this strategy had one ON by default (per an
/// explicit instruction at the time), later explicitly removed at a later, equally explicit
/// instruction, so this is price action + the checks above only, nothing else gating an entry.
///
/// OPTION SIDE and everything this class still deliberately does NOT do (true simultaneous Iron
/// Condor selling, India VIX, position sizing/daily-loss/consecutive-SL state, regime-segmented
/// performance reporting, OI/Volume strike screening) are UNCHANGED from the single-timeframe
/// version - see the CE/PE direction note below, still worth a second look given real money is
/// involved.
///
/// Bullish -&gt; sell PE, Bearish -&gt; sell CE is OptionTradeSimulator.Run's own existing Sell
/// convention (isCall = isSell ? !isBullish : isBullish), the standard defined-direction credit
/// convention - the flowchart's own Trade Direction text ("Uptrend -&gt; Sell CE") reads backwards
/// from that and from every other Sell-capable strategy already shipped here, so this class keeps the
/// standard/existing mapping rather than the literal text.
/// </summary>
public sealed class RegimeAdaptiveStrategy : IBacktestStrategy
{
    public string Key => "regime-adaptive";
    public string Name => "Regime-Adaptive Option Selling (15x/5x/3x/1x Cascade, scales with page timeframe)";
    public string Description => "Identifies Trending, Choppy, and Volatile conditions and trades each differently: a REGIME->SETUP->CONFIRM->ENTRY multi-timeframe cascade (15x/5x/3x/1x the page's own selected timeframe) sells the trend's own direction; a VWAP+-ATR range fade (RSI-neutral gated) sells premium at the edges of a genuinely choppy range; and a relative volatility spike (ATR expansion, an oversized candle, or a gap - not just a fixed ATR% cutoff) suspends new entries from either path until it settles. Sells options by default. Price action only - no CDV/OBV order-flow filter.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    private const decimal FlagOff = 0;
    private const decimal FlagOn = 1;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        // Sells by default (every other strategy here defaults to Buy) - see this class's own doc
        // comment on why, and on the CE/PE direction convention this relies on.
        new BacktestParameterSpec("side", "Position", Default: OptionTradeSimulator.SideSell, Min: OptionTradeSimulator.SideBuy, Max: OptionTradeSimulator.SideSell, Step: 1, Options: new[]
        {
            new BacktestParameterOption(OptionTradeSimulator.SideBuy, "Buy option"),
            new BacktestParameterOption(OptionTradeSimulator.SideSell, "Sell option (credit) - this strategy's own default"),
        }),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        // 09:30, not the shared 09:15 default - "observe only" 9:15-9:30 per the flowchart.
        new BacktestParameterSpec("signalStartMinutes", "No signals before (IST time, 0 = off)", Default: 570, Min: 0, Max: 1439, Step: 1),
        new BacktestParameterSpec("noNewEntriesAfterMinutes", "No new entries from (IST time, 0 = off)", Default: 0, Min: 0, Max: 1439, Step: 1),
        OptionTradeSimulator.ExcludeLastDaysParameter(),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish only"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish only"),
        }),

        // ---- REGIME layer (15x the page's own selected timeframe - see this class's own doc
        // comment on how all four cascade layers scale together) ----
        new BacktestParameterSpec("regime15EmaFast", "Regime EMA fast (bars, at 15x the page timeframe)", Default: 20, Min: 3, Max: 100, Step: 1),
        new BacktestParameterSpec("regime15EmaSlow", "Regime EMA slow (bars, at 15x the page timeframe)", Default: 50, Min: 5, Max: 300, Step: 1),
        new BacktestParameterSpec("regime15SlopeMinPercent", "Regime EMA slope must be at least (%)", Default: 0.050m, Min: 0, Max: 5, Step: 0.005m),
        new BacktestParameterSpec("regime15AdxMin", "Regime ADX must be at least", Default: 25, Min: 0, Max: 80, Step: 1),
        new BacktestParameterSpec("regimeScoreMin", "Regime score needed (out of 5) to even attempt a trend trade", Default: 3, Min: 1, Max: 5, Step: 1),
        new BacktestParameterSpec("regimeScoreFull", "Regime score needed (out of 5) for full confidence (below = selective)", Default: 4, Min: 1, Max: 5, Step: 1),

        // ---- SETUP layer (5x the page's own selected timeframe) ----
        new BacktestParameterSpec("setup5EmaFast", "Setup EMA fast (bars, at 5x the page timeframe)", Default: 9, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("setup5EmaSlow", "Setup EMA slow (bars, at 5x the page timeframe)", Default: 21, Min: 3, Max: 200, Step: 1),
        new BacktestParameterSpec("setup5AdxMin", "Setup ADX must be at least", Default: 25, Min: 0, Max: 80, Step: 1),

        // ---- CONFIRM layer (3x the page's own selected timeframe) ----
        new BacktestParameterSpec("confirm3EmaFast", "Confirm EMA fast (bars, at 3x the page timeframe)", Default: 7, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("confirm3EmaSlow", "Confirm EMA slow (bars, at 3x the page timeframe)", Default: 20, Min: 3, Max: 200, Step: 1),
        new BacktestParameterSpec("confirm3AdxMin", "Confirm ADX must be at least", Default: 23, Min: 0, Max: 80, Step: 1),
        new BacktestParameterSpec("confirm3SlopeMinPercent", "Confirm EMA slope must be at least (%)", Default: 0.025m, Min: 0, Max: 5, Step: 0.005m),

        // ---- ENTRY layer (the page's own selected timeframe itself) ----
        new BacktestParameterSpec("entry1EmaFast", "Entry EMA fast (bars, at the page's own timeframe)", Default: 5, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("entry1EmaSlow", "Entry EMA slow (bars, at the page's own timeframe)", Default: 13, Min: 3, Max: 200, Step: 1),
        new BacktestParameterSpec("entry1AdxMin", "Entry ADX must be at least", Default: 22, Min: 0, Max: 80, Step: 1),
        new BacktestParameterSpec("entry1SlopeMinPercent", "Entry EMA slope must be at least (%)", Default: 0.015m, Min: 0, Max: 5, Step: 0.005m),
        new BacktestParameterSpec("entry1CrossWithinBars", "Entry EMA cross must have happened within this many bars (not necessarily the exact bar)", Default: 5, Min: 1, Max: 30, Step: 1),

        // ---- shared across every cascade stage ----
        new BacktestParameterSpec("cascadeSlopeLookbackBars", "EMA slope measured over (bars, at each stage's own timeframe)", Default: 3, Min: 1, Max: 50, Step: 1),
        new BacktestParameterSpec("cascadeAdxPeriod", "ADX (bars, every cascade stage)", Default: 14, Min: 2, Max: 100, Step: 1),

        // ---- Range fade (page timeframe) + shared RSI/ATR - unchanged mechanism from before ----
        new BacktestParameterSpec("atrPeriod", "ATR (bars, page timeframe)", Default: 14, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("atrNormalHighPercent", "ATR %% of price - High volatility band starts at", Default: 1.5m, Min: 0, Max: 10, Step: 0.05m),
        new BacktestParameterSpec("atrExtremePercent", "ATR %% of price - Extreme (no new trades) starts at", Default: 2.5m, Min: 0, Max: 15, Step: 0.05m),
        new BacktestParameterSpec("rangeAtrMultiple", "Range fade band = VWAP +- this x ATR", Default: 1.5m, Min: 0.2m, Max: 5, Step: 0.1m),
        new BacktestParameterSpec("rsiPeriod", "RSI (bars)", Default: 14, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("rsiNeutralLow", "Entries need RSI above", Default: 40, Min: 0, Max: 50, Step: 1),
        new BacktestParameterSpec("rsiNeutralHigh", "Entries need RSI below", Default: 60, Min: 50, Max: 100, Step: 1),

        // ---- Volatile-regime detection - RELATIVE (self-referencing) signals on top of the fixed
        // ATR%-of-price cutoff above, so a genuine spike gets caught on any underlying/price level
        // without needing its own manual retune. See this class's own doc comment.
        new BacktestParameterSpec("atrAverageLookbackBars", "ATR/range averaging window (bars, page timeframe)", Default: 20, Min: 5, Max: 100, Step: 1),
        new BacktestParameterSpec("atrExpansionRatio", "ATR vs its own average counts as Volatile at", Default: 1.5m, Min: 1, Max: 5, Step: 0.1m),
        new BacktestParameterSpec("largeCandleRatio", "Candle range vs its own average counts as Volatile at", Default: 2, Min: 1, Max: 6, Step: 0.1m),
        new BacktestParameterSpec("gapAtrMultiple", "Opening gap vs ATR counts as Volatile at", Default: 1, Min: 0.2m, Max: 5, Step: 0.1m),

        // ---- Choppy labeling only (does not change routing - see this class's own doc comment) ----
        new BacktestParameterSpec("chopAdxMax", "Regime-layer ADX at/below this, with a flat slope, reads as Choppy", Default: 20, Min: 0, Max: 60, Step: 1),
        new BacktestParameterSpec("chopFlatSlopePercent", "Regime-layer EMA slope within +- this reads as flat (Choppy)", Default: 0.02m, Min: 0, Max: 1, Step: 0.01m),
    };

    /// <summary>What scales here, and why the rest deliberately does not, now that the cascade's own
    /// BAR SIZES already re-base with the page timeframe (15x/5x/3x/1x - see this class's own doc
    /// comment):
    ///   - slPoints/tpPoints/atrNormalHighPercent/atrExtremePercent AND the four SLOPE-MIN-PERCENT
    ///     parameters (regime15/confirm3/entry1SlopeMinPercent, chopFlatSlopePercent) all scale with
    ///     <c>scale</c> - every one of these is a PRICE-DISTANCE threshold (points, ATR%-of-price, or
    ///     a slope's own %-move-per-N-bars), and a coarser bar naturally covers more price distance
    ///     even in ordinary noise, so the same raw number would be too tight on a 15-minute page and
    ///     too loose on a 1-minute one.
    ///
    ///     <c>scale</c> here is <c>sqrt(timeframeMinutes)</c> - the standard random-walk scaling for
    ///     how far price wanders over a longer window (distance grows with the SQUARE ROOT of
    ///     elapsed time, not linearly) - evaluated at the EXACT page timeframe rather than reusing
    ///     OptionTradeSimulator.TimeframeScale's shared 3-step bucket (1x/2x/3x collapsing everything
    ///     &gt;=4 minutes together). This app's own TIMEFRAME_OPTIONS only ever offers 1/3/5/15
    ///     minutes, and this strategy's whole design point is a genuinely distinct feel per timeframe
    ///     (bar sizes 3x apart at each step) - a bucket that gives 5-minute and 15-minute pages the
    ///     identical multiplier defeats that, so this strategy computes its own continuous factor
    ///     instead: 1x at 1 minute, ~1.73x at 3, ~2.24x at 5, ~3.87x at 15 - four distinct values for
    ///     the four distinct choices, and it degrades gracefully to any other timeframe too.
    ///   - ADX minimums and RSI bounds do NOT scale - both are already unitless 0-100 oscillators BY
    ///     CONSTRUCTION (that is the entire point of Wilder's normalization), which is exactly why
    ///     classic TA uses the same ADX&gt;25/RSI 30-70 style cutoffs on a 1-minute chart and a
    ///     15-minute chart alike; scaling them would not track anything real.
    ///   - EMA-period/lookback/cross-window BAR COUNTS (regime15EmaFast, cascadeSlopeLookbackBars,
    ///     entry1CrossWithinBars, etc.) do NOT scale - they are already counted in that layer's OWN
    ///     bars, and each layer's bar duration already re-bases with the page timeframe on its own
    ///     (see the Evaluate method), so "20 bars" or "within 5 bars" keeps meaning the same relative
    ///     lookback at every page timeframe without any further adjustment here.</summary>
    public IReadOnlyDictionary<string, decimal> DefaultsForTimeframe(int timeframeMinutes)
    {
        var scale = (decimal)Math.Sqrt(Math.Max(1, timeframeMinutes));
        return new Dictionary<string, decimal>
        {
            ["slPoints"] = Math.Round(10m * scale, 2),
            ["tpPoints"] = Math.Round(20m * scale, 2),
            ["atrNormalHighPercent"] = Math.Round(1.5m * scale, 2),
            ["atrExtremePercent"] = Math.Round(2.5m * scale, 2),
            ["regime15SlopeMinPercent"] = Math.Round(0.050m * scale, 3),
            ["confirm3SlopeMinPercent"] = Math.Round(0.025m * scale, 3),
            ["entry1SlopeMinPercent"] = Math.Round(0.015m * scale, 3),
            ["chopFlatSlopePercent"] = Math.Round(0.02m * scale, 3),
        };
    }

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var direction = parameters["direction"];
        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 570);
        var noNewEntriesAfterMinutes = (int)parameters.GetValueOrDefault("noNewEntriesAfterMinutes", 0);

        var regime15EmaFast = Math.Max(2, (int)parameters.GetValueOrDefault("regime15EmaFast", 20));
        var regime15EmaSlow = Math.Max(3, (int)parameters.GetValueOrDefault("regime15EmaSlow", 50));
        var regime15SlopeMin = parameters.GetValueOrDefault("regime15SlopeMinPercent", 0.050m);
        var regime15AdxMin = parameters.GetValueOrDefault("regime15AdxMin", 25m);
        var regimeScoreMin = Math.Max(1, (int)parameters.GetValueOrDefault("regimeScoreMin", 3));
        var regimeScoreFull = Math.Max(regimeScoreMin, (int)parameters.GetValueOrDefault("regimeScoreFull", 4));

        var setup5EmaFast = Math.Max(2, (int)parameters.GetValueOrDefault("setup5EmaFast", 9));
        var setup5EmaSlow = Math.Max(3, (int)parameters.GetValueOrDefault("setup5EmaSlow", 21));
        var setup5AdxMin = parameters.GetValueOrDefault("setup5AdxMin", 25m);

        var confirm3EmaFast = Math.Max(2, (int)parameters.GetValueOrDefault("confirm3EmaFast", 7));
        var confirm3EmaSlow = Math.Max(3, (int)parameters.GetValueOrDefault("confirm3EmaSlow", 20));
        var confirm3AdxMin = parameters.GetValueOrDefault("confirm3AdxMin", 23m);
        var confirm3SlopeMin = parameters.GetValueOrDefault("confirm3SlopeMinPercent", 0.025m);

        var entry1EmaFast = Math.Max(2, (int)parameters.GetValueOrDefault("entry1EmaFast", 5));
        var entry1EmaSlow = Math.Max(3, (int)parameters.GetValueOrDefault("entry1EmaSlow", 13));
        var entry1AdxMin = parameters.GetValueOrDefault("entry1AdxMin", 22m);
        var entry1SlopeMin = parameters.GetValueOrDefault("entry1SlopeMinPercent", 0.015m);
        var entry1CrossWithinBars = Math.Max(1, (int)parameters.GetValueOrDefault("entry1CrossWithinBars", 5));

        var slopeLookback = Math.Max(1, (int)parameters.GetValueOrDefault("cascadeSlopeLookbackBars", 3));
        var adxPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("cascadeAdxPeriod", 14));

        var atrPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("atrPeriod", 14));
        var atrNormalHighPercent = parameters.GetValueOrDefault("atrNormalHighPercent", 1.5m);
        var atrExtremePercent = parameters.GetValueOrDefault("atrExtremePercent", 2.5m);
        var rangeAtrMultiple = parameters.GetValueOrDefault("rangeAtrMultiple", 1.5m);
        var rsiPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("rsiPeriod", 14));
        var rsiNeutralLow = parameters.GetValueOrDefault("rsiNeutralLow", 40m);
        var rsiNeutralHigh = parameters.GetValueOrDefault("rsiNeutralHigh", 60m);

        var atrAverageLookbackBars = Math.Max(2, (int)parameters.GetValueOrDefault("atrAverageLookbackBars", 20));
        var atrExpansionRatio = parameters.GetValueOrDefault("atrExpansionRatio", 1.5m);
        var largeCandleRatio = parameters.GetValueOrDefault("largeCandleRatio", 2m);
        var gapAtrMultiple = parameters.GetValueOrDefault("gapAtrMultiple", 1m);
        var chopAdxMax = parameters.GetValueOrDefault("chopAdxMax", 20m);
        var chopFlatSlopePercent = parameters.GetValueOrDefault("chopFlatSlopePercent", 0.02m);

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        // The four cascade layers, all as multiples of the page's own selected timeframe - see this
        // class's own doc comment. ENTRY is exactly the page timeframe, so pageBars IS the ENTRY
        // layer; there is no separate "native 1-minute" entry series any more.
        var entryMinutes = Math.Max(1, context.TimeframeMinutes);
        var confirmMinutes = entryMinutes * 3;
        var setupMinutes = entryMinutes * 5;
        var regimeMinutes = entryMinutes * 15;

        var oneMin = context.SpotBarsOneMinute;
        var pageBars = context.SpotBars;
        if (oneMin.Count < 30 || pageBars.Count < 2) return (entries, signals);

        var bars3 = BacktestUtil.AggregateCandles(oneMin, confirmMinutes);
        var bars5 = BacktestUtil.AggregateCandles(oneMin, setupMinutes);
        var bars15 = BacktestUtil.AggregateCandles(oneMin, regimeMinutes);
        if (bars15.Count < regime15EmaSlow + slopeLookback + 2) return (entries, signals);

        void EmitAt(DateTimeOffset time, bool bullish, string summary, decimal? atrPercentHere, string? volatileReason)
        {
            var dir = bullish ? "Bullish" : "Bearish";
            var volatilityHigh = volatileReason is null && atrPercentHere is { } ap2 && ap2 >= atrNormalHighPercent;
            var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(time) < signalStartMinutes;
            var afterEntryCutoff = noNewEntriesAfterMinutes > 0 && IstClock.MinutesOfDay(time) >= noNewEntriesAfterMinutes;
            var sizingNote = volatilityHigh ? " (ATR reads High volatility - consider reduced size; not enforced by this backtest)" : "";

            if (beforeSignalStart)
                signals.Add(new BacktestSignal(context.Underlying, time, "Rejected", dir, $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
            else if (afterEntryCutoff)
                signals.Add(new BacktestSignal(context.Underlying, time, "Rejected", dir, $"{summary} - skipped, at/after {IstClock.FormatMinutesOfDay(noNewEntriesAfterMinutes)} IST (no new entries)"));
            else if (volatileReason is { Length: > 0 })
                signals.Add(new BacktestSignal(context.Underlying, time, "Rejected", dir, $"{summary} - skipped, market reads Volatile right now ({volatileReason})"));
            else if (bullish && !takeLongs)
                signals.Add(new BacktestSignal(context.Underlying, time, "Rejected", dir, $"{summary} - skipped, shorts only"));
            else if (!bullish && !takeShorts)
                signals.Add(new BacktestSignal(context.Underlying, time, "Rejected", dir, $"{summary} - skipped, longs only"));
            else
            {
                signals.Add(new BacktestSignal(context.Underlying, time, "Entry", dir, $"{summary}{sizingNote}"));
                entries.Add((time, dir));
            }
        }

        var vwapSeries1m = VwapCalculator.ComputeSeries(context.SpotVolumeBarsOneMinute);
        var vwap15 = AlignToTime(vwapSeries1m, 1, bars15, regimeMinutes);
        var vwap5 = AlignToTime(vwapSeries1m, 1, bars5, setupMinutes);
        var vwapPage = AlignToTime(vwapSeries1m, 1, pageBars, entryMinutes);

        // ---- REGIME layer ----
        var ema15Fast = EmaCrossoverDetector.EmaSeries(bars15, regime15EmaFast);
        var ema15Slow = EmaCrossoverDetector.EmaSeries(bars15, regime15EmaSlow);
        var adx15 = ToQuotes(bars15).GetAdx(adxPeriod).Select(r => (decimal?)r.Adx).ToList();

        // ---- SETUP layer's EMA stack (reused for the REGIME score's 5th point AND the SETUP gate) ----
        var ema5Fast = EmaCrossoverDetector.EmaSeries(bars5, setup5EmaFast);
        var ema5Slow = EmaCrossoverDetector.EmaSeries(bars5, setup5EmaSlow);
        var adx5 = ToQuotes(bars5).GetAdx(adxPeriod).Select(r => (decimal?)r.Adx).ToList();
        var stack5Bullish = bars5.Select((_, i) => ema5Fast[i] is { } f && ema5Slow[i] is { } s && f > s).ToList();
        var stack5Bearish = bars5.Select((_, i) => ema5Fast[i] is { } f && ema5Slow[i] is { } s && f < s).ToList();
        var setup5OkBullish = bars5.Select((b, i) => stack5Bullish[i] && adx5[i] is { } a && a >= setup5AdxMin && vwap5[i] is { } v && b.Close > v).ToList();
        var setup5OkBearish = bars5.Select((b, i) => stack5Bearish[i] && adx5[i] is { } a && a >= setup5AdxMin && vwap5[i] is { } v && b.Close < v).ToList();

        // ---- CONFIRM layer ----
        var ema3Fast = EmaCrossoverDetector.EmaSeries(bars3, confirm3EmaFast);
        var ema3Slow = EmaCrossoverDetector.EmaSeries(bars3, confirm3EmaSlow);
        var adx3 = ToQuotes(bars3).GetAdx(adxPeriod).Select(r => (decimal?)r.Adx).ToList();
        var confirm3OkBullish = bars3.Select((b, i) => ema3Fast[i] is { } f && ema3Slow[i] is { } s && f > s && adx3[i] is { } a && a >= confirm3AdxMin
            && Slope(ema3Fast, i, slopeLookback) is { } sl && sl >= confirm3SlopeMin && b.Close > b.Open).ToList();
        var confirm3OkBearish = bars3.Select((b, i) => ema3Fast[i] is { } f && ema3Slow[i] is { } s && f < s && adx3[i] is { } a && a >= confirm3AdxMin
            && Slope(ema3Fast, i, slopeLookback) is { } sl && sl <= -confirm3SlopeMin && b.Close < b.Open).ToList();

        // ---- ENTRY layer inputs - pageBars IS the ENTRY layer (see above) ----
        var ema1Fast = EmaCrossoverDetector.EmaSeries(pageBars, entry1EmaFast);
        var ema1Slow = EmaCrossoverDetector.EmaSeries(pageBars, entry1EmaSlow);
        var adx1 = ToQuotes(pageBars).GetAdx(adxPeriod).Select(r => (decimal?)r.Adx).ToList();
        var rsi1 = ToQuotes(pageBars).GetRsi(rsiPeriod).Select(r => (decimal?)r.Rsi).ToList();

        // ---- REGIME direction + score ----
        var stack5OnBars15Bullish = AlignStepToTime(bars5, stack5Bullish, setupMinutes, bars15, regimeMinutes, false);
        var stack5OnBars15Bearish = AlignStepToTime(bars5, stack5Bearish, setupMinutes, bars15, regimeMinutes, false);
        var regime15Direction = new string?[bars15.Count];
        var regime15Score = new int[bars15.Count];
        for (var i = slopeLookback; i < bars15.Count; i++)
        {
            if (ema15Fast[i] is not { } f || ema15Slow[i] is not { } s) continue;
            if (adx15[i] is not { } a || vwap15[i] is not { } v) continue;

            var candidate = f > s ? "Bullish" : f < s ? "Bearish" : null;
            if (candidate is null) continue;

            var bullish = candidate == "Bullish";
            var slopeOk = Slope(ema15Fast, i, slopeLookback) is { } sl && (bullish ? sl >= regime15SlopeMin : sl <= -regime15SlopeMin);
            var adxOk = a >= regime15AdxMin;
            var vwapOk = bullish ? bars15[i].Close > v : bars15[i].Close < v;
            var fiveMOk = bullish ? stack5OnBars15Bullish[i] : stack5OnBars15Bearish[i];

            var score = 1 + (slopeOk ? 1 : 0) + (adxOk ? 1 : 0) + (vwapOk ? 1 : 0) + (fiveMOk ? 1 : 0);
            regime15Score[i] = score;
            regime15Direction[i] = score >= regimeScoreMin ? candidate : null;
        }

        // ---- page-timeframe ATR/RSI for the Range path + the volatility gate ----
        var atrPage = ToQuotes(pageBars).GetAtr(atrPeriod).Select(r => (decimal?)r.Atr).ToList();
        var rsiPage = ToQuotes(pageBars).GetRsi(rsiPeriod).Select(r => (decimal?)r.Rsi).ToList();
        var atrPercentPage = pageBars.Select((b, i) => atrPage[i] is { } a && b.Close != 0 ? (decimal?)(a / b.Close * 100m) : null).ToList();

        // ---- Volatile regime - see this class's own doc comment for what each of the four signals
        // means; any one being true is enough to flag the bar, and the reason text says which. ----
        var volatileReasonPage = ComputeVolatileReasons(pageBars, atrPage, atrPercentPage, atrExtremePercent, atrAverageLookbackBars, atrExpansionRatio, largeCandleRatio, gapAtrMultiple);

        // ==== TREND CASCADE - entries on the ENTRY layer (pageBars), gated by every coarser stage
        // above agreeing. No separate alignment is needed for ATR%/volatility here - pageBars already
        // IS the ENTRY layer, so atrPercentPage/volatileReasonPage apply directly. ====
        var regime15OnEntry = AlignStepToTime(bars15, regime15Direction, regimeMinutes, pageBars, entryMinutes, (string?)null);
        var regime15ScoreOnEntry = AlignStepToTime(bars15, regime15Score, regimeMinutes, pageBars, entryMinutes, 0);
        var setup5OkOnEntryBullish = AlignStepToTime(bars5, setup5OkBullish, setupMinutes, pageBars, entryMinutes, false);
        var setup5OkOnEntryBearish = AlignStepToTime(bars5, setup5OkBearish, setupMinutes, pageBars, entryMinutes, false);
        var confirm3OkOnEntryBullish = AlignStepToTime(bars3, confirm3OkBullish, confirmMinutes, pageBars, entryMinutes, false);
        var confirm3OkOnEntryBearish = AlignStepToTime(bars3, confirm3OkBearish, confirmMinutes, pageBars, entryMinutes, false);

        bool CrossedUpRecently(int idx)
        {
            for (var k = 0; k <= entry1CrossWithinBars; k++)
            {
                var j = idx - k;
                if (j < 1) return false;
                if (ema1Fast[j] is not { } cf || ema1Slow[j] is not { } cs) continue;
                if (ema1Fast[j - 1] is not { } pf || ema1Slow[j - 1] is not { } ps) continue;
                if (pf <= ps && cf > cs) return true;
            }
            return false;
        }

        bool CrossedDownRecently(int idx)
        {
            for (var k = 0; k <= entry1CrossWithinBars; k++)
            {
                var j = idx - k;
                if (j < 1) return false;
                if (ema1Fast[j] is not { } cf || ema1Slow[j] is not { } cs) continue;
                if (ema1Fast[j - 1] is not { } pf || ema1Slow[j - 1] is not { } ps) continue;
                if (pf >= ps && cf < cs) return true;
            }
            return false;
        }

        for (var i = Math.Max(1, slopeLookback); i < pageBars.Count; i++)
        {
            if (regime15OnEntry[i] is not { } dir) continue;
            if (ema1Fast[i] is not { } f1) continue;
            if (ema1Slow[i] is not { } s1) continue;
            if (adx1[i] is not { } a1 || rsi1[i] is not { } r1) continue;
            if (Slope(ema1Fast, i, slopeLookback) is not { } sl1) continue;

            var bullish = dir == "Bullish";
            var setupOk = bullish ? setup5OkOnEntryBullish[i] : setup5OkOnEntryBearish[i];
            var confirmOk = bullish ? confirm3OkOnEntryBullish[i] : confirm3OkOnEntryBearish[i];
            var pullback = bullish ? f1 > s1 && CrossedUpRecently(i) : f1 < s1 && CrossedDownRecently(i);
            var adxOk = a1 >= entry1AdxMin;
            var slopeOk = bullish ? sl1 >= entry1SlopeMin : sl1 <= -entry1SlopeMin;
            var rsiOk = r1 > rsiNeutralLow && r1 < rsiNeutralHigh;

            if (!(setupOk && confirmOk && pullback && adxOk && slopeOk && rsiOk)) continue;

            var score = regime15ScoreOnEntry[i];
            var confidence = score >= regimeScoreFull ? "full confidence" : "selective/reduced confidence";
            var summary = $"{regimeMinutes}M regime {dir} (score {score}/5, {confidence}) -> {setupMinutes}M setup ok -> {confirmMinutes}M confirmed -> {entryMinutes}M pullback rejection (EMA{entry1EmaFast}/{entry1EmaSlow})";
            EmitAt(pageBars[i].Time, bullish, summary, atrPercentPage[i], volatileReasonPage[i]);
        }

        // ==== RANGE FADE - ENTRY/page-timeframe VWAP+-ATR band, only when the REGIME layer is NOT
        // trending (reuses regime15OnEntry/regime15ScoreOnEntry above - same alignment, same layer) ====
        // Labeling only (see this class's own doc comment) - a genuinely flat, weak-ADX REGIME-layer
        // read is called "Choppy" in the signal text; anything else that still failed to trend is
        // just a plainer "weak trend".
        var slope15 = bars15.Select((_, i) => Slope(ema15Fast, i, slopeLookback)).ToList();
        var adx15OnPage = AlignStepToTime(bars15, adx15, regimeMinutes, pageBars, entryMinutes, (decimal?)null);
        var slope15OnPage = AlignStepToTime(bars15, slope15, regimeMinutes, pageBars, entryMinutes, (decimal?)null);

        for (var i = 1; i < pageBars.Count; i++)
        {
            if (regime15ScoreOnEntry[i] >= regimeScoreMin) continue; // trend cascade already has a candidate - don't fade into it
            if (vwapPage[i] is not { } vwapNow || vwapPage[i - 1] is not { } prevVwap) continue;
            if (atrPage[i] is not { } atrNow || atrPage[i - 1] is not { } prevAtr) continue;
            if (rsiPage[i] is not { } rsiNow || atrPercentPage[i] is not { } atrPctNow) continue;

            var bar = pageBars[i];
            var prevBar = pageBars[i - 1];
            var lower = vwapNow - atrNow * rangeAtrMultiple;
            var prevLower = prevVwap - prevAtr * rangeAtrMultiple;
            var upper = vwapNow + atrNow * rangeAtrMultiple;
            var prevUpper = prevVwap + prevAtr * rangeAtrMultiple;
            var rsiNeutral = rsiNow > rsiNeutralLow && rsiNow < rsiNeutralHigh;
            var isChoppy = adx15OnPage[i] is { } a15 && a15 <= chopAdxMax && slope15OnPage[i] is { } s15 && Math.Abs(s15) <= chopFlatSlopePercent;
            var regimeLabel = isChoppy ? $"Choppy ({regimeMinutes}M ADX {adx15OnPage[i]:0.#}, slope {slope15OnPage[i]:0.###}%)" : $"weak trend (score {regime15ScoreOnEntry[i]}/5)";

            if (prevBar.Close <= prevLower && bar.Close > lower)
            {
                var summary = $"{regimeMinutes}M regime {regimeLabel} - close rejected back above the VWAP-{rangeAtrMultiple:0.#}xATR lower band ({lower:0.##}), RSI {rsiNow:0.#}";
                if (!rsiNeutral)
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bullish", $"{summary} - skipped, RSI outside the {rsiNeutralLow:0.#}-{rsiNeutralHigh:0.#} neutral band (momentum may be accelerating away, not just testing the range)"));
                else
                    EmitAt(bar.Time, true, summary, atrPctNow, volatileReasonPage[i]);
            }
            else if (prevBar.Close >= prevUpper && bar.Close < upper)
            {
                var summary = $"{regimeMinutes}M regime {regimeLabel} - close rejected back below the VWAP+{rangeAtrMultiple:0.#}xATR upper band ({upper:0.##}), RSI {rsiNow:0.#}";
                if (!rsiNeutral)
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bearish", $"{summary} - skipped, RSI outside the {rsiNeutralLow:0.#}-{rsiNeutralHigh:0.#} neutral band (momentum may be accelerating away, not just testing the range)"));
                else
                    EmitAt(bar.Time, false, summary, atrPctNow, volatileReasonPage[i]);
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }

    /// <summary>The Volatile-regime reason text for every page-timeframe bar, one entry per
    /// <paramref name="pageBars"/> index, null where none of the four signals fire - see this class's
    /// own doc comment for what each one means. Internal (not private) purely so
    /// RegimeAdaptiveStrategyTests can exercise this specific detection logic directly with small,
    /// hand-built candle sequences, rather than needing a full end-to-end cascade fixture that
    /// happens to also trip a price-action trigger at the exact volatile bar.</summary>
    internal static string?[] ComputeVolatileReasons(
        IReadOnlyList<Candle> pageBars, IReadOnlyList<decimal?> atrPage, IReadOnlyList<decimal?> atrPercentPage,
        decimal atrExtremePercent, int atrAverageLookbackBars, decimal atrExpansionRatio, decimal largeCandleRatio, decimal gapAtrMultiple)
    {
        var volatileReasonPage = new string?[pageBars.Count];
        for (var i = 0; i < pageBars.Count; i++)
        {
            var reasons = new List<string>();
            if (atrPercentPage[i] is { } atrPct && atrPct >= atrExtremePercent)
                reasons.Add($"ATR {atrPct:0.##}% of price >= the {atrExtremePercent:0.##}% Extreme cutoff");

            var windowStart = Math.Max(0, i - atrAverageLookbackBars + 1);
            var atrWindow = new List<decimal>();
            for (var j = windowStart; j <= i; j++) if (atrPage[j] is { } a) atrWindow.Add(a);
            if (atrPage[i] is { } atrNow && atrWindow.Count > 0)
            {
                var atrAvg = atrWindow.Average();
                if (atrAvg > 0 && atrNow >= atrAvg * atrExpansionRatio)
                    reasons.Add($"ATR expanded to {atrNow / atrAvg:0.##}x its own {atrAverageLookbackBars}-bar average");
            }

            var rangeWindow = new List<decimal>();
            for (var j = windowStart; j <= i; j++) rangeWindow.Add(pageBars[j].High - pageBars[j].Low);
            var rangeNow = pageBars[i].High - pageBars[i].Low;
            var rangeAvg = rangeWindow.Count > 0 ? rangeWindow.Average() : 0;
            if (rangeAvg > 0 && rangeNow >= rangeAvg * largeCandleRatio)
                reasons.Add($"candle range is {rangeNow / rangeAvg:0.##}x its own {atrAverageLookbackBars}-bar average (large candle)");

            if (i > 0 && atrPage[i] is { } atrForGap && atrForGap > 0)
            {
                var gap = Math.Abs(pageBars[i].Open - pageBars[i - 1].Close);
                if (gap >= atrForGap * gapAtrMultiple)
                    reasons.Add($"opening gap of {gap:0.##} points is {gap / atrForGap:0.##}x ATR");
            }

            volatileReasonPage[i] = reasons.Count > 0 ? string.Join("; ", reasons) : null;
        }
        return volatileReasonPage;
    }

    /// <summary>% change of <paramref name="series"/> over <paramref name="lookback"/> bars ending at
    /// <paramref name="index"/> - null if either end is missing or the base is exactly zero (a
    /// meaningless divisor, not a real "infinite slope").</summary>
    private static decimal? Slope(IReadOnlyList<decimal?> series, int index, int lookback)
    {
        if (index - lookback < 0) return null;
        if (series[index] is not { } now || series[index - lookback] is not { } past || past == 0) return null;
        return (now - past) / Math.Abs(past) * 100m;
    }

    private static List<Quote> ToQuotes(IReadOnlyList<Candle> bars) => bars.Select(c => new Quote
    {
        Date = c.Time.UtcDateTime,
        Open = c.Open,
        High = c.High,
        Low = c.Low,
        Close = c.Close,
        Volume = 0,
    }).ToList();

    /// <summary>Aligns a time-keyed running series (VWAP here, shaped like ObvCeSeries/CdvCeSeries) to
    /// <paramref name="targetBars"/> by index - "the last value KNOWN as of this target bar's own
    /// close" for every bar in one forward merge pass, rather than BacktestUtil.LastValueAtOrBefore's
    /// own per-call O(series length) scan repeated once per bar.
    ///
    /// <paramref name="sourcePointMinutes"/>/<paramref name="targetBucketMinutes"/> matter more than
    /// they look: a series point or a candle's own Time field is when its bucket OPENED, not when its
    /// value actually became knowable - a 15-minute candle timestamped 09:15 only finishes closing at
    /// 09:30, so comparing raw Open-times directly (as an earlier version of this method did) let a
    /// 1-minute bar sitting exactly on that boundary use a value that would not exist yet in a real,
    /// live run - textbook look-ahead bias, silently inflating a backtest's own results bar after bar
    /// at every 15/5/3-minute mark. Shifting BOTH sides to their own CLOSE instant
    /// (Time + their respective bucket span) before comparing is what actually fixes that: a source
    /// point only counts once it has closed at or before the target bar's own close.</summary>
    private static List<decimal?> AlignToTime(IReadOnlyList<ObvPoint> series, int sourcePointMinutes, IReadOnlyList<Candle> targetBars, int targetBucketMinutes)
    {
        var sourceSpan = TimeSpan.FromMinutes(sourcePointMinutes);
        var targetSpan = TimeSpan.FromMinutes(targetBucketMinutes);
        var result = new List<decimal?>(targetBars.Count);
        var pointer = 0;
        decimal? current = null;
        foreach (var bar in targetBars)
        {
            var targetKnownAt = bar.Time + targetSpan;
            while (pointer < series.Count && series[pointer].Time + sourceSpan <= targetKnownAt)
            {
                current = series[pointer].Obv;
                pointer++;
            }
            result.Add(current);
        }
        return result;
    }

    /// <summary>Generic counterpart to AlignToTime, same "compare CLOSE instants, not Open-times" fix
    /// and for the identical reason (see AlignToTime's own doc comment) - projects any timeframe's own
    /// per-bar series (<paramref name="sourceBars"/>/<paramref name="sourceValues"/>, e.g. the
    /// 15-minute regime direction) onto another timeframe's own bar times (<paramref
    /// name="targetBars"/>, e.g. the native 1-minute series - this is used in both directions, coarser
    /// onto finer AND finer onto coarser), so "what did the 15-minute regime say as of this bar" is a
    /// plain array lookup rather than a per-bar binary search. <paramref name="defaultValue"/> covers
    /// every target bar before the source series' own first CLOSED value.</summary>
    private static List<T> AlignStepToTime<T>(
        IReadOnlyList<Candle> sourceBars, IReadOnlyList<T> sourceValues, int sourceBucketMinutes,
        IReadOnlyList<Candle> targetBars, int targetBucketMinutes, T defaultValue)
    {
        var sourceSpan = TimeSpan.FromMinutes(sourceBucketMinutes);
        var targetSpan = TimeSpan.FromMinutes(targetBucketMinutes);
        var result = new List<T>(targetBars.Count);
        var pointer = 0;
        var current = defaultValue;
        foreach (var bar in targetBars)
        {
            var targetKnownAt = bar.Time + targetSpan;
            while (pointer < sourceBars.Count && sourceBars[pointer].Time + sourceSpan <= targetKnownAt)
            {
                current = sourceValues[pointer];
                pointer++;
            }
            result.Add(current);
        }
        return result;
    }
}
