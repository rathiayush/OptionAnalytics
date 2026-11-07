using System.IO.Compression;
using System.Net.Http.Headers;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>HttpCompression - the answers compressed (a backtest day's 2.6 MB of JSON was sent whole): JSON and CSV in
/// Brotli or gzip as the browser accepts, and the same bytes once undone; the hub, the sign-in endpoints and what is
/// already compressed (a zip) are left as they are; Program's pipeline compresses before the static files.</summary>
public sealed class HttpCompressionTests
{
    // A day's run in miniature - repetitive JSON, as the real one is.
    private static readonly string Json = "[" + string.Join(",", Enumerable.Range(0, 4000).Select(i => $"{{\"time\":\"2026-10-28T03:{i % 60:00}:00+00:00\",\"strike\":{25000 + i % 21 * 50},\"price\":{50 + i * 0.1:0.0},\"openInterest\":{2000 + i}}}")) + "]";

    private static async Task<IHost> Host() => await new HostBuilder().ConfigureWebHost(web => web.UseTestServer()
        .ConfigureServices(services => services.AddHttpCompression())
        .Configure(app =>
        {
            app.UseHttpCompression();
            app.Run(async context =>
            {
                var path = context.Request.Path.Value ?? "";
                context.Response.ContentType = path.EndsWith(".csv") ? "text/csv" : path.EndsWith(".zip") ? "application/zip" : "application/json";
                await context.Response.WriteAsync(Json);
            });
        })).StartAsync();

    private static async Task<(string? Encoding, byte[] Body)> Get(IHost host, string path, params string[] accept)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, path);
        foreach (var a in accept) request.Headers.AcceptEncoding.Add(new StringWithQualityHeaderValue(a));
        var response = await host.GetTestClient().SendAsync(request);
        return (response.Content.Headers.ContentEncoding.SingleOrDefault(), await response.Content.ReadAsByteArrayAsync());
    }

    private static string Undo(string? encoding, byte[] body)
    {
        using var input = new MemoryStream(body);
        using Stream stream = encoding switch
        {
            "br" => new BrotliStream(input, CompressionMode.Decompress),
            "gzip" => new GZipStream(input, CompressionMode.Decompress),
            _ => input,
        };
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    [Theory]
    [InlineData("/api/oi-replay/NIFTY/run", "br")]
    [InlineData("/api/signal-backtest/jobs/x/features.csv", "br")]
    [InlineData("/api/oi-replay/NIFTY/run", "gzip")]
    public async Task Json_and_csv_answers_are_compressed_and_come_back_the_same(string path, string accept)
    {
        using var host = await Host();
        var (encoding, body) = await Get(host, path, accept);
        Assert.Equal(accept, encoding);
        Assert.True(body.Length * 5 < Encoding.UTF8.GetByteCount(Json), $"{body.Length} bytes for {Json.Length}");
        Assert.Equal(Json, Undo(encoding, body));
    }

    [Theory]
    [InlineData("/hubs/spot")]                       // the hub: its own framing, a stream
    [InlineData("/api/auth/login")]                  // sign-in answers: never compressed (BREACH)
    [InlineData("/api/cache/everything.zip")]        // already compressed
    public async Task The_hub_sign_in_and_zips_are_left_as_they_are(string path)
    {
        using var host = await Host();
        var (encoding, body) = await Get(host, path, "br", "gzip");
        Assert.Null(encoding);
        Assert.Equal(Json, Encoding.UTF8.GetString(body));
    }

    [Fact]
    public async Task A_client_that_asks_for_none_gets_none()
    {
        using var host = await Host();
        var (encoding, body) = await Get(host, "/api/oi-replay/NIFTY/run");
        Assert.Null(encoding);
        Assert.Equal(Json, Encoding.UTF8.GetString(body));
    }

    [Fact]
    public void Programs_pipeline_compresses_before_the_static_files()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null && !File.Exists(Path.Combine(dir, "OptionAnalytics.Server", "Program.cs"))) dir = Path.GetDirectoryName(dir);
        Assert.NotNull(dir);
        var program = File.ReadAllText(Path.Combine(dir!, "OptionAnalytics.Server", "Program.cs"));
        Assert.Contains("builder.Services.AddHttpCompression();", program);
        var use = program.IndexOf("app.UseHttpCompression();", StringComparison.Ordinal);
        Assert.True(use > 0 && use < program.IndexOf("app.UseStaticFiles();", StringComparison.Ordinal));
    }
}
