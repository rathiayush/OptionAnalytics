using System.IO.Compression;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>DataFilesService - the admin's Data files page: the server's places listed, folders browsed, files read
/// (gzip too) and nothing outside a place or that looks like a secret ever reached.</summary>
public sealed class DataFilesServiceTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "oa-data-files-" + Guid.NewGuid().ToString("n"));

    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Tests";
        public string ContentRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = null!;
    }

    private DataFilesService Service()
    {
        Directory.CreateDirectory(_dir);
        return new DataFilesService(new FakeHostEnvironment { ContentRootPath = _dir }, new ConfigurationBuilder().Build());
    }

    private string Write(string rel, string text)
    {
        var full = Path.Combine(_dir, rel.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllText(full, text);
        return full;
    }

    [Fact]
    public void ThePlaces_AreListed_WithTheirFilesAndSize()
    {
        Write("scanner-log/signals.csv", "a,b\n1,2\n");
        Write("scanner-log/2026/trades.csv", "x\n");
        Write("trade-settings.csv", "underlying\nNIFTY\n");
        var places = Service().Places();
        var log = places.Single(p => p.Key == "scanner-log");
        Assert.True(log.Exists && log.IsDirectory);
        Assert.Equal(2, log.Files);
        Assert.Equal(10, log.Bytes);
        Assert.True(places.Single(p => p.Key == "trade-settings").Exists);
        Assert.False(places.Single(p => p.Key == "live-list").Exists);
        Assert.Contains(places, p => p.Key == "scanner-runner" && p.What.Contains("cache"));
    }

    [Fact]
    public void AFolder_IsBrowsed_FoldersFirst_AndSecretsAreNeverShown()
    {
        Write("scanner-runner-data/tuning/cache/v3/NIFTY-2026-10-09.json.gz", "x");
        Write("scanner-runner-data/config.json", "{}");
        Write("scanner-runner-data/appsettings.Local.json", "{\"Dhan\":{}}");
        Write("scanner-runner-data/api-token.txt", "secret");
        var s = Service();
        var (top, error) = s.List("scanner-runner", null);
        Assert.Null(error);
        Assert.Equal(new[] { "tuning", "config.json" }, top!.Select(e => e.Name));
        Assert.True(top[0].IsDirectory && top[0].Files == 1);
        var (cache, _) = s.List("scanner-runner", "tuning/cache/v3");
        Assert.Equal("tuning/cache/v3/NIFTY-2026-10-09.json.gz", Assert.Single(cache!).Path);
        Assert.Null(s.File("scanner-runner", "appsettings.Local.json").FullPath);
        Assert.Null(s.File("scanner-runner", "api-token.txt").FullPath);
    }

    [Fact]
    public void NothingOutsideAPlace_IsReached()
    {
        Write("secret.txt", "outside");
        Write("scanner-log/signals.csv", "a\n");
        var s = Service();
        foreach (var bad in new[] { "../secret.txt", "..\\secret.txt", "/etc/passwd", "a/../../secret.txt", "./signals.csv", "" })
            Assert.Null(s.File("scanner-log", bad).FullPath);
        Assert.Null(s.List("scanner-log", "..").Entries);
        Assert.Null(s.File("nope", "signals.csv").FullPath);
        Assert.NotNull(s.File("scanner-log", "signals.csv").FullPath);
    }

    [Fact]
    public void AFile_IsRead_AsCsvJsonOrText_GzipUnzipped_AndCutAtTheLimit()
    {
        var s = Service();
        var csv = Write("scanner-log/signals.csv", "time,strategy\n10:00,wallBreak\n");
        var p = DataFilesService.Preview(csv, "signals.csv", 4096);
        Assert.Equal(("csv", false), (p.Kind, p.Truncated));
        Assert.Contains("wallBreak", p.Text);

        var json = Write("live-list.json", "{\"a\":[1,2]}");
        Assert.Contains("\n", DataFilesService.Preview(json, "", 4096).Text);

        var gz = Path.Combine(_dir, "scanner-runner-data", "day.json.gz");
        Directory.CreateDirectory(Path.GetDirectoryName(gz)!);
        using (var f = File.Create(gz))
        using (var z = new GZipStream(f, CompressionLevel.Fastest))
            z.Write(Encoding.UTF8.GetBytes("{\"bars\":[" + string.Join(",", Enumerable.Range(0, 3000)) + "]}"));
        var zipped = DataFilesService.Preview(gz, "day.json.gz", 2048);
        Assert.True(zipped.Gzip && zipped.Truncated && zipped.Kind == "json");
        Assert.StartsWith("{\"bars\":[0,1,2", zipped.Text);
        Assert.Equal(1024 * 2, Encoding.UTF8.GetByteCount(zipped.Text!));

        var bin = Path.Combine(_dir, "scanner-log", "x.bin");
        File.WriteAllBytes(bin, new byte[] { 1, 0, 2 });
        Assert.Equal("binary", DataFilesService.Preview(bin, "x.bin", 4096).Kind);
        Assert.NotNull(s.File("scanner-log", "x.bin").FullPath);
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch { /* best effort */ }
    }
}
