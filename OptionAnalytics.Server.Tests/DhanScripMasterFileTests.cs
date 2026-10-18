using System.Net;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Tests;

/// <summary>DhanScripMasterFile: the scrip master is downloaded once, kept on disk and shared - not once per instrument master and again
/// after every restart; a failed download falls back to the copy kept.</summary>
public sealed class DhanScripMasterFileTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), $"scrip-{Guid.NewGuid():N}");

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    private sealed class Dhan(bool fail = false) : HttpMessageHandler
    {
        public int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref Calls);
            return Task.FromResult(fail ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("SEM_SMST_SECURITY_ID,X\\n13,NIFTY\\n") });
        }
    }

    private static async Task<string> ReadAll(Stream s) { using (s) using (var r = new StreamReader(s)) return await r.ReadToEndAsync(); }

    [Fact]
    public async Task DownloadedOnce_SharedByEveryOpen_AndReadAfterARestart()
    {
        var dhan = new Dhan();
        var http = new HttpClient(dhan);
        for (var i = 0; i < 3; i++)   // the spot, futures and option-chain masters
            Assert.Contains("NIFTY", await ReadAll(await DhanScripMasterFile.OpenAsync(http, "https://x/scrip.csv", NullLogger.Instance, CancellationToken.None, _dir, TimeSpan.FromHours(4))));
        Assert.Equal(1, dhan.Calls);

        // Too old: downloaded again - and when that fails, the copy kept is used.
        var down = new Dhan(fail: true);
        Assert.Contains("NIFTY", await ReadAll(await DhanScripMasterFile.OpenAsync(new HttpClient(down), "https://x/scrip.csv", NullLogger.Instance, CancellationToken.None, _dir, TimeSpan.Zero)));
        Assert.Equal(1, down.Calls);
    }

    [Fact]
    public async Task WithNoDirectory_EveryOpenDownloads_AsBefore()
    {
        var dhan = new Dhan();
        var http = new HttpClient(dhan);
        await ReadAll(await DhanScripMasterFile.OpenAsync(http, "https://x/scrip.csv", NullLogger.Instance, CancellationToken.None, null, TimeSpan.FromHours(4)));
        await ReadAll(await DhanScripMasterFile.OpenAsync(http, "https://x/scrip.csv", NullLogger.Instance, CancellationToken.None, null, TimeSpan.FromHours(4)));
        Assert.Equal(2, dhan.Calls);
    }
}
