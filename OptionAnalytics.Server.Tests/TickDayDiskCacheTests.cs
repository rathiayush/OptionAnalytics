using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Controllers;
using OptionAnalytics.Server.TrueData;
using Xunit;

namespace OptionAnalytics.Server.Tests;

public sealed class TickDayDiskCacheTests
{
    [Fact]
    public void AFuturesProfileDayRoundTripsThroughTheGzipFile_AndAFullDaySizeIsAFewTensOfKilobytes()
    {
        var root = Path.Combine(Path.GetTempPath(), "tickdays-" + Guid.NewGuid().ToString("N"));
        try
        {
            var disk = new TickDayDiskCache(root, NullLogger<TickDayDiskCache>.Instance);
            var rng = new Random(7);
            var day = new DateOnly(2026, 11, 20);
            var bars = new List<TickBar>();
            decimal price = 25000;
            for (var m = 0; m < 375; m++)
            {
                price += rng.Next(-6, 7);
                var levels = Enumerable.Range(0, 24).Select(k => new TickLevel(price + 12 - k, rng.Next(0, 600), rng.Next(0, 600))).ToList();
                bars.Add(new TickBar(new DateTimeOffset(2026, 11, 20, 9, 15, 0, TimeSpan.FromHours(5.5)).AddMinutes(m), price, price + 6, price - 6, price + 1, levels.Sum(l => l.Buy), levels.Sum(l => l.Sell), 90, levels));
            }
            var saved = new TickFlowController.FuturesProfileDay(65, 0.05m, bars);
            Assert.True(disk.Write("futures", "NIFTY", day, saved));
            var back = disk.Read<TickFlowController.FuturesProfileDay>("futures", "NIFTY", day)!;
            Assert.Equal(375, back.Bars.Count);
            Assert.Equal(bars[10].Levels[3], back.Bars[10].Levels[3]);
            Assert.Equal(65, back.LotSize);
            var size = new FileInfo(disk.FileOf("futures", "NIFTY", day)).Length;
            Assert.InRange(size, 1_000, 400_000);
        }
        finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
    }
}
