using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The server's responses COMPRESSED (Brotli, else gzip, at their fastest level) - asked about: "all the data is cached,
/// why is it taking time?". A Signal backtest day (GET /api/oi-replay/{u}/run - spot, 42 option series, futures) is about
/// 2.6 MB of JSON read from the disk cache in ~0.1 s, and was sent whole: a phone downloaded 150 MB+ for a 60-day run. JSON
/// compresses ~8 - 30x; the page's scripts, the CSVs and every other API answer too. Not compressed: the SignalR hub
/// (/hubs - its own framing, a stream) and /api/auth (a sign-in answer is never compressed with anything a request can
/// steer - BREACH); already-compressed types (zip, gzip, images) are not in <see cref="MimeTypes"/>.
/// </summary>
public static class HttpCompression
{
    /// <summary>What is compressed: ASP.NET's defaults (JSON, JavaScript, CSS, HTML, plain text, XML, wasm) and CSV / SVG.</summary>
    public static readonly string[] MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(new[] { "text/csv", "image/svg+xml" }).ToArray();

    /// <summary>Whether a request's answer may be compressed: everything but the hub and the sign-in endpoints.</summary>
    public static bool Applies(HttpContext context) =>
        !context.Request.Path.StartsWithSegments("/hubs") && !context.Request.Path.StartsWithSegments("/api/auth");

    public static IServiceCollection AddHttpCompression(this IServiceCollection services)
    {
        services.AddResponseCompression(options =>
        {
            // Behind Traefik the app sees plain HTTP, but say so for a direct HTTPS start too.
            options.EnableForHttps = true;
            options.Providers.Add<BrotliCompressionProvider>();
            options.Providers.Add<GzipCompressionProvider>();
            options.MimeTypes = MimeTypes;
        });
        services.Configure<BrotliCompressionProviderOptions>(o => o.Level = CompressionLevel.Fastest);
        services.Configure<GzipCompressionProviderOptions>(o => o.Level = CompressionLevel.Fastest);
        return services;
    }

    /// <summary>Compresses the answers of every request <see cref="Applies"/> to - before the static files, so the page's
    /// scripts are compressed too.</summary>
    public static IApplicationBuilder UseHttpCompression(this IApplicationBuilder app) =>
        app.UseWhen(Applies, branch => branch.UseResponseCompression());
}
