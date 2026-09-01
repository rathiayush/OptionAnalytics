namespace OptionAnalytics.Server.Models;

/// <summary>One strike/side CDV has tracked today, as served by GET /api/cdv/{underlying}/strikes -
/// purely a verification/debugging view onto CdvUnderlyingState's internal strike set, so a user can
/// confirm which contracts a displayed CE/PE total actually sums. IsActive is whether it's currently
/// inside the live ATM+-8 window (still being subscribed and ticked); a strike that rolled OUT of the
/// window earlier today still appears here (with IsActive=false) since its RunningCdv is still part
/// of the total - see CdvStrikeRuntime.RunningCdv's own doc comment for why entries are never
/// dropped.</summary>
public readonly record struct CdvStrikeInfo(uint SecurityId, decimal Strike, bool IsCall, bool IsActive, decimal RunningCdv);
