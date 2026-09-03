namespace OptionAnalytics.Server.Models;

/// <summary>One listed contract and what the app currently knows about it - the row the contracts
/// page shows. Deliberately reports three separate facts that used to be conflated into a single
/// "no data": whether the SCRIP MASTER lists it, whether the feed is SUBSCRIBED to it, and whether
/// it has actually TICKED. A contract listed but unsubscribed is a tracking-window question; one
/// subscribed but never ticked is a feed question; one not listed at all is a scrip-master
/// question - and each has a completely different fix.</summary>
public sealed record ContractRow(
    uint SecurityId,
    string TradingSymbol,
    decimal Strike,
    string OptionType,
    int LotSize,
    decimal TickSize,
    bool Subscribed,
    bool Tracked,
    decimal? LastPrice,
    long? Volume,
    DateTimeOffset? LastTickUtc);

/// <summary>Every listed contract for one underlying/expiry, plus the health of the two things that
/// have to be working for any of it to matter: the scrip master and the feed subscription.</summary>
public sealed record ContractsResponse(
    string Underlying,
    DateOnly? Expiry,
    IReadOnlyList<DateOnly> ListedExpiries,
    IReadOnlyList<DateOnly> TrackedExpiries,
    /// <summary>Total contracts the scrip master holds across every underlying. ZERO is the
    /// failure that reads downstream as every strike being "not listed".</summary>
    int MasterContractCount,
    DateTimeOffset? MasterLoadedUtc,
    /// <summary>Total instruments subscribed on the websocket, across every underlying/expiry.</summary>
    int SubscribedCount,
    IReadOnlyList<ContractRow> Contracts);
