using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services.OrderFlow;

namespace OptionAnalytics.Server.Tests;

/// <summary>The order flow's handling of Dhan's 1-second SNAPSHOTS (Dhan's market feed is not a packet a trade): the LTQ +
/// book comparison rule (OrderFlowEngine.LtqBookDelta - only the last trade takes the bars' side, the rest of the second
/// split by what was taken off each side of the 5-level book, else by the price's move, else half and half), shown on the
/// Delta rules card and kept with the day (a day saved before it shows the older rules and none for it); and a trade with
/// no side known yet - before any had one - booked neutral, not as a buy.</summary>
public sealed class OrderFlowLtqBookTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 5, 4, 0, 0, TimeSpan.Zero); // 09:30 IST

    private static DepthLevel L(decimal price, long qty) => new(price, qty, 5);

    private static OrderFlowEngine NewEngine() => new("NIFTY", 35001, "NIFTY-Oct2026-FUT", "NSE_FNO", 0.05m, 75);

    private static SpotTick Tick(decimal price, long volume, DepthLevel[] bids, DepthLevel[] asks, int ltq = 0, DateTimeOffset? at = null) =>
        new(35001, price, 0, 0, 0, 0, volume, bids.Length > 0 ? bids[0].Price : 0, asks.Length > 0 ? asks[0].Price : 0, 0, at ?? T0)
        {
            Bids = bids,
            Asks = asks,
            LastTradedQty = ltq,
        };

    [Fact]
    public void The_book_taken_is_the_levels_the_best_price_moved_past_and_the_drop_at_it()
    {
        var asks = new[] { L(100.05m, 750), L(100.10m, 600), L(100.15m, 900) };
        // Buyers swept 100.05 and 100.10 and took 300 of 100.15.
        Assert.Equal(750 + 600 + 300, OrderFlowEngine.BookTaken(asks, new[] { L(100.15m, 600), L(100.20m, 800) }, ask: true));
        // The best ask unmoved: what its level lost; a level that grew counts nothing.
        Assert.Equal(150, OrderFlowEngine.BookTaken(asks, new[] { L(100.05m, 600), L(100.10m, 600) }, ask: true));
        Assert.Equal(0, OrderFlowEngine.BookTaken(asks, new[] { L(100.05m, 900) }, ask: true));
        // Bids, the mirror: sellers hit 100.00 and 99.95 and took 100 of 99.90.
        var bids = new[] { L(100.00m, 500), L(99.95m, 400), L(99.90m, 700) };
        Assert.Equal(500 + 400 + 100, OrderFlowEngine.BookTaken(bids, new[] { L(99.90m, 600), L(99.85m, 300) }, ask: false));
        // New bids over the old best (buyers stepping up) are not sells.
        Assert.Equal(0, OrderFlowEngine.BookTaken(bids, new[] { L(100.05m, 300), L(100.00m, 500) }, ask: false));
        // No book on either side: nothing known.
        Assert.Equal(0, OrderFlowEngine.BookTaken(null, bids, ask: false));
        Assert.Equal(0, OrderFlowEngine.BookTaken(bids, Array.Empty<DepthLevel>(), ask: false));
    }

    [Fact]
    public void Only_the_last_trade_takes_the_rules_side_the_rest_of_the_second_is_split_by_the_book()
    {
        DepthLevel[] Bid(long q) => new[] { L(100.00m, q) };
        DepthLevel[] Ask(long q) => new[] { L(100.05m, q) };
        // A second that traded both ways at an unmoved book: 600 off the bid, 900 off the ask; 1,500 traded, the last trade
        // a 75 sell. The rules in use call all 1,500 sold; this one: -75, then 1,425 split 60 / 40 to the buyers.
        Assert.Equal(-75 + 855 - 570, OrderFlowEngine.LtqBookDelta(-1, 1500, 75, 100.00m, 100.00m, Bid(1500), Ask(1500), Bid(900), Ask(600)));
        // A sweep up through the asks: every unit bought.
        var asks = new[] { L(100.05m, 750), L(100.10m, 750), L(100.15m, 750) };
        Assert.Equal(3000, OrderFlowEngine.LtqBookDelta(1, 3000, 150, 100.15m, 100.00m, Bid(500), asks, new[] { L(100.10m, 500) }, new[] { L(100.20m, 750) }));
        // Nothing taken off the book (pulled and replaced): by the price's move - up, the rest bought; down, sold.
        Assert.Equal(1000, OrderFlowEngine.LtqBookDelta(1, 1000, 100, 100.05m, 100.00m, null, null, null, null));
        Assert.Equal(-1000, OrderFlowEngine.LtqBookDelta(-1, 1000, 100, 99.95m, 100.00m, null, null, null, null));
        // ... unchanged: half and half - only the last trade leans.
        Assert.Equal(100, OrderFlowEngine.LtqBookDelta(1, 1000, 100, 100.00m, 100.00m, null, null, null, null));
        // One trade in the second (its LTQ is the whole volume): the same as the rules in use.
        Assert.Equal(-75, OrderFlowEngine.LtqBookDelta(-1, 75, 75, 100.00m, 100.00m, Bid(1500), Ask(1500), Bid(1425), Ask(1500)));
        // An LTQ over the volume is held to it; none (0) leaves it all to the book; no side for the last trade, none for it.
        Assert.Equal(75, OrderFlowEngine.LtqBookDelta(1, 75, 900, 100.00m, 100.00m, null, null, null, null));
        Assert.Equal(-600, OrderFlowEngine.LtqBookDelta(1, 600, 0, 100.00m, 100.00m, Bid(1500), Ask(1500), Bid(900), Ask(1500)));
        Assert.Equal(0, OrderFlowEngine.LtqBookDelta(0, 200, 100, 100.00m, 100.00m, null, null, null, null));
        Assert.Equal(0, OrderFlowEngine.LtqBookDelta(1, 0, 75, 100.00m, 100.00m, null, null, null, null));
    }

    [Fact]
    public void The_engine_tallies_it_per_candle_beside_the_other_rules_and_keeps_it_with_the_day()
    {
        var engine = NewEngine();
        engine.OnTick(Tick(100.05m, 10_000, new[] { L(100.00m, 1500) }, new[] { L(100.05m, 1500) }), T0);
        // One second: 1,500 traded both ways at an unmoved book (600 off the bid, 900 off the ask), the last trade a sell at 100.00.
        engine.OnTick(Tick(100.00m, 11_500, new[] { L(100.00m, 900) }, new[] { L(100.05m, 600) }, ltq: 75), T0.AddSeconds(1));

        var row = Assert.Single(engine.DeltaRules(1));
        Assert.Equal(-1500, row.Delta);                                    // the rule in use: the whole second sold
        Assert.Equal(-75 + 855 - 570, row.LtqBook);                        // the last trade sold, the rest split by the book
        // The footprint itself is still the rule in use - this is a comparison until it is chosen.
        var bar = Assert.Single(engine.Snapshot(rowSize: 0, minTradeQty: 1, heatmapColumns: 10).Bars);
        Assert.Equal((0L, 1500L), (bar.Buy, bar.Sell));
        // Kept with the day (a deploy, a past day replayed).
        Assert.Equal(engine.DeltaRules(1), OrderFlowEngine.FromDay(engine.ExportDay()!).DeltaRules(1));
    }

    [Fact]
    public void A_day_saved_with_the_three_older_rules_shows_them_and_none_for_the_new_one()
    {
        var engine = NewEngine();
        engine.OnTick(Tick(100.00m, 1000, new[] { L(100.00m, 750) }, new[] { L(100.05m, 750) }), T0);
        engine.OnTick(Tick(100.05m, 1150, new[] { L(100.00m, 750) }, new[] { L(100.05m, 600) }, ltq: 150), T0.AddMilliseconds(500));
        var day = engine.ExportDay()!;
        for (var i = 0; i < day.Bars.Count; i++) day.Bars[i] = day.Bars[i] with { Rules = day.Bars[i].Rules![..3] };   // as saved before

        var restored = OrderFlowEngine.FromDay(day);
        var row = Assert.Single(restored.DeltaRules(1));
        Assert.Equal((150L, 150L, 150L), (row.DepthBook!.Value, row.OwnPacket!.Value, row.TickRule!.Value));
        Assert.Null(row.LtqBook);
        // Today restored from such a checkpoint and traded on in the same minute: no half-minute comparison, no failure.
        restored.OnTick(Tick(100.05m, 1150, new[] { L(100.00m, 750) }, new[] { L(100.05m, 600) }), T0.AddSeconds(1));
        restored.OnTick(Tick(100.05m, 1225, new[] { L(100.00m, 750) }, new[] { L(100.05m, 525) }, ltq: 75), T0.AddSeconds(2));
        var after = Assert.Single(restored.DeltaRules(1));
        Assert.Equal(225, after.Delta);
        Assert.Null(after.TickRule);
        Assert.Null(after.LtqBook);
    }

    [Fact]
    public void A_trade_with_no_side_known_yet_is_neutral_not_a_buy()
    {
        var engine = NewEngine();
        var none = Array.Empty<DepthLevel>();
        // No quote at all, the price unchanged: no rule can tell - the first trade has no side.
        engine.OnTick(Tick(100.00m, 1000, none, none), T0);
        engine.OnTick(Tick(100.00m, 1150, none, none), T0.AddSeconds(1));
        var bar = Assert.Single(engine.Snapshot(rowSize: 0, minTradeQty: 1, heatmapColumns: 10).Bars);
        Assert.Equal((75L, 75L), (bar.Buy, bar.Sell));                                  // half each way - it used to be 150 bought
        Assert.Empty(engine.Tape(null, 10, 1));                                         // no aggressor - no print
        // Once one has a side, an unchanged price keeps it (the tick rule).
        engine.OnTick(Tick(100.05m, 1225, none, none), T0.AddSeconds(2));               // up: bought
        engine.OnTick(Tick(100.05m, 1300, none, none), T0.AddSeconds(3));               // unchanged: bought
        bar = Assert.Single(engine.Snapshot(rowSize: 0, minTradeQty: 1, heatmapColumns: 10).Bars);
        Assert.Equal((225L, 75L), (bar.Buy, bar.Sell));
        Assert.Equal(2, engine.Tape(null, 10, 1).Count);
    }
}
