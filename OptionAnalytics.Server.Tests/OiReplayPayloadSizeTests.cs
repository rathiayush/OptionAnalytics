using System.IO.Compression;
using System.Text.Json;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Tests;

/// <summary>Why the API answers are compressed (Program.cs, AddResponseCompression): one OI Replay day is about 16,000 option points of JSON -
/// megabytes on the wire, which on a phone's mobile connection is most of the page's load time - and it shrinks several times over.</summary>
public sealed class OiReplayPayloadSizeTests
{
    [Fact]
    public void OneDaysOptionPoints_AreMegabytesOfJson_AndCompressWell()
    {
        var t0 = new DateTimeOffset(2026, 10, 13, 3, 45, 0, TimeSpan.Zero);
        var rng = new Random(1);
        var points = new List<OiReplayPoint>();
        for (var strike = 0; strike < 42; strike++)   // 21 strikes x CE / PE
            for (var m = 0; m < 375; m++)
                points.Add(new OiReplayPoint(t0.AddMinutes(m), 22500 + (strike % 21 - 10) * 50, 1_000_000 + rng.Next(50_000),
                    12.5m + rng.Next(100) / 100m, 80 + rng.Next(4000) / 100m, 80 + rng.Next(4000) / 100m, 85 + rng.Next(4000) / 100m, 79 + rng.Next(4000) / 100m, rng.Next(50_000)));
        var json = JsonSerializer.SerializeToUtf8Bytes(points, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.True(json.Length > 2_000_000, $"{json.Length} bytes of JSON");

        using var packed = new MemoryStream();
        using (var gzip = new GZipStream(packed, CompressionLevel.Fastest, leaveOpen: true)) gzip.Write(json);
        Assert.True(packed.Length * 3 < json.Length, $"{json.Length} -> {packed.Length} bytes");
    }
}
