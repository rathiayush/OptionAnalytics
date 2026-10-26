using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>The OI Replay page's option CDV / OBV (optionFlow.js) is the dashboard's (CdvUnderlyingState) worked out from
/// a day's 1-minute bars: one fixed day - 12 minutes, three strikes a side - run through the server here and through the
/// page in tests/option-flow.test.mjs, both held to the same numbers.</summary>
public sealed class CdvParityTests
{
    internal static readonly DateTimeOffset Open = new(2026, 10, 21, 9, 15, 0, IstClock.Offset);
    internal const int Minutes = 12;
    internal static readonly decimal[] Strikes = { 24950, 25000, 25050 };
    internal static decimal SpotAt(int m) => 25000 + 7 * m;

    internal static CandleWithVolume Bar(int m, int k, bool isCall)
    {
        var kk = k + (isCall ? 0 : 5);
        decimal open = 100 + (m * 7 + kk * 3) % 11;
        var close = open + (m + kk) % 5 - 2;
        var high = Math.Max(open, close) + 1 + m % 3;
        var low = Math.Min(open, close) - 1 - kk % 2;
        return new CandleWithVolume(Open.AddMinutes(m), open, high, low, close, 1000 + 37 * m + 101 * kk);
    }

    internal static CdvUnderlyingState ServerDay()
    {
        var state = new CdvUnderlyingState("NIFTY");
        var spotByTime = Enumerable.Range(0, Minutes).ToDictionary(m => Open.AddMinutes(m), SpotAt);
        state.BeginCdvBackfill(Open.AddMinutes(Minutes));
        uint id = 1;
        foreach (var isCall in new[] { true, false })
            for (var k = 0; k < Strikes.Length; k++, id++)
            {
                state.EnsureTracked(id, Strikes[k], isCall);
                var bars = Enumerable.Range(0, Minutes).Select(m => Bar(m, k, isCall)).ToList();
                state.SeedStrikeHistory(id, bars, bars, SpotAt(Minutes - 1), includeInCdvHistory: true, spotByTime);
            }
        state.FinalizeCdvBackfill();
        state.LastSpot = SpotAt(Minutes - 1);
        return state;
    }

    // The numbers tests/option-flow.test.mjs holds optionFlow.js to - the server's own, for this day.
    internal static readonly double[] CeCdv = { -252.1249, -513.8863, -785.3058, -559.6423, -988.7175, -1950.8907, -1698.6543, -1628.8060, -2159.8439, -2221.5383, -3052.6319, -3798.2198 };
    internal static readonly double[] PeCdv = { -129.9693, -380.5086, -576.2997, 67.8517, -370.1882, -1450.8951, -967.9904, -640.2681, -1069.0456, -1007.7816, -1802.0634, -2610.5553 };
    internal static readonly double[] CeObv = { 0.0000, 483.7485, -19.0549, -725.0121, -1356.8044, -1916.7724, -2678.0134, -3366.0298, -1506.7890, -2165.3687, -2525.2418, -3271.2723 };
    internal static readonly double[] PeObv = { 0.0000, -2433.1978, -1718.0746, -2451.1429, -3431.2414, -4315.9133, -5102.8170, -6138.6317, -3629.8998, -4487.6836, -5392.2167, -5893.8227 };

    [Fact]
    public void The_dashboards_CDV_and_OBV_of_the_fixed_day_are_the_numbers_the_page_is_held_to()
    {
        var state = ServerDay();
        var cdv = state.GetSeries();
        Assert.Equal(Enumerable.Range(0, Minutes).Select(m => Open.AddMinutes(m)), cdv.Select(p => p.Time));
        void Same(double[] expected, IEnumerable<decimal> actual) =>
            Assert.All(expected.Zip(actual), pair => Assert.True(Math.Abs(pair.First - (double)pair.Second) < 1e-3, $"{pair.First} vs {pair.Second}"));
        Same(CeCdv, cdv.Select(p => p.CeCdv));
        Same(PeCdv, cdv.Select(p => p.PeCdv));
        // OBV: every bar weighted at the LATEST spot (LastSpot), rebased to the day's first minute, EMA(9).
        Same(CeObv, state.GetObvSeries(true).Select(p => p.Obv));
        Same(PeObv, state.GetObvSeries(false).Select(p => p.Obv));
        Assert.Equal(Minutes, state.GetObvSeries(true).Count);
    }
}
