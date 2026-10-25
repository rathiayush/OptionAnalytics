using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using MaxMind.Db;

namespace OptionAnalytics.Server.Services.Visitors;

public sealed record GeoPlace(string? City, string? Region, string? Country);

/// <summary>Where a connection comes from - city, region, country - looked up in a database kept on this server
/// (DB-IP's free "IP to City Lite", CC BY 4.0: https://db-ip.com), so a visitor's address is never sent anywhere.
/// The address is only used for the lookup and then dropped: the visitor log keeps the place, never the address.
/// GeoDbUpdater downloads the database (about 130 MB) to Storage:GeoDbPath and refreshes it monthly; until it is
/// there, places are unknown.</summary>
public sealed class GeoLocator : IDisposable
{
    public const string FileName = "dbip-city-lite.mmdb";
    private Reader? _reader;
    private readonly object _swap = new();

    public GeoLocator(IHostEnvironment environment, IConfiguration configuration) : this(ResolveDir(environment, configuration))
    {
    }

    internal GeoLocator(string dir)
    {
        Dir = dir;
        Directory.CreateDirectory(Dir);
        TryLoad(Path.Combine(Dir, FileName));
    }

    public string Dir { get; }
    public string DbPath => Path.Combine(Dir, FileName);
    public bool Ready => _reader is not null;

    private static string ResolveDir(IHostEnvironment environment, IConfiguration configuration)
    {
        var configured = configuration["Storage:GeoDbPath"];
        var path = string.IsNullOrWhiteSpace(configured) ? "geo" : configured;
        return Path.IsPathRooted(path) ? path : Path.Combine(environment.ContentRootPath, path);
    }

    /// <summary>Opens `file` as the database (replacing the one in use); false if it is not a readable database.</summary>
    public bool TryLoad(string file)
    {
        if (!File.Exists(file)) return false;
        try
        {
            var reader = new Reader(file, FileAccessMode.MemoryMapped);
            lock (_swap)
            {
                var old = _reader;
                _reader = reader;
                old?.Dispose();
            }
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>The place of `address`: "Local network" for a private one, null when unknown.</summary>
    public GeoPlace? Locate(IPAddress? address)
    {
        if (address is null) return null;
        if (ClientAddress.IsPrivate(address)) return new GeoPlace(null, null, "Local network");
        lock (_swap)
        {
            if (_reader is null) return null;
            try
            {
                var found = _reader.Find<Dictionary<string, object>>(address);
                if (found is null) return null;
                return new GeoPlace(NameOf(found, "city"), NameOf(First(found, "subdivisions")), NameOf(found, "country"));
            }
            catch (Exception)
            {
                return null;
            }
        }
    }

    private static string? NameOf(Dictionary<string, object> found, string key) =>
        found.TryGetValue(key, out var part) && part is Dictionary<string, object> d ? NameOf(d) : null;

    private static string? NameOf(Dictionary<string, object>? part) =>
        part is not null && part.TryGetValue("names", out var names) && names is Dictionary<string, object> n && n.TryGetValue("en", out var en) ? en as string : null;

    private static Dictionary<string, object>? First(Dictionary<string, object> found, string key) =>
        found.TryGetValue(key, out var list) && list is List<object> { Count: > 0 } l ? l[0] as Dictionary<string, object> : null;

    public void Dispose()
    {
        lock (_swap) { _reader?.Dispose(); _reader = null; }
    }
}

/// <summary>Keeps GeoLocator's database: downloads DB-IP's monthly "IP to City Lite" file when it is missing or more
/// than RefreshAfter old (this month's, else last month's), unzips it next to the old one and swaps it in. A failed
/// download is tried again later at a slowing pace (1 h doubling to 24 h), never in a loop. Not a Dhan call.</summary>
public sealed class GeoDbUpdater : BackgroundService
{
    internal static readonly TimeSpan RefreshAfter = TimeSpan.FromDays(32);
    private static readonly TimeSpan CheckEvery = TimeSpan.FromHours(12);
    private readonly GeoLocator _geo;
    private readonly IHttpClientFactory _http;
    private readonly ILogger<GeoDbUpdater> _logger;
    private readonly bool _enabled;

    public GeoDbUpdater(GeoLocator geo, IHttpClientFactory http, IConfiguration configuration, ILogger<GeoDbUpdater> logger)
    {
        _geo = geo;
        _http = http;
        _logger = logger;
        _enabled = configuration.GetValue("Visitors:GeoDownload", true);
    }

    internal static string UrlFor(DateOnly month) => $"https://download.db-ip.com/free/dbip-city-lite-{month:yyyy-MM}.mmdb.gz";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_enabled) return;
        var failures = 0;
        while (!stoppingToken.IsCancellationRequested)
        {
            var wait = CheckEvery;
            var file = new FileInfo(_geo.DbPath);
            if (!file.Exists || DateTime.UtcNow - file.LastWriteTimeUtc > RefreshAfter || !_geo.Ready)
            {
                if (await DownloadAsync(stoppingToken)) failures = 0;
                else wait = RetryBackoff.After(++failures, TimeSpan.FromHours(1), TimeSpan.FromHours(24));
            }
            try { await Task.Delay(wait, stoppingToken); } catch (OperationCanceledException) { return; }
        }
    }

    private async Task<bool> DownloadAsync(CancellationToken ct)
    {
        var thisMonth = DateOnly.FromDateTime(DateTime.UtcNow);
        foreach (var month in new[] { thisMonth, thisMonth.AddMonths(-1) })
        {
            var temp = _geo.DbPath + ".download";
            try
            {
                using var client = _http.CreateClient(nameof(GeoDbUpdater));
                client.Timeout = TimeSpan.FromMinutes(10);
                using var response = await client.GetAsync(UrlFor(month), HttpCompletionOption.ResponseHeadersRead, ct);
                if (response.StatusCode == HttpStatusCode.NotFound) continue;
                response.EnsureSuccessStatusCode();
                await using (var body = await response.Content.ReadAsStreamAsync(ct))
                await using (var unzip = new GZipStream(body, CompressionMode.Decompress))
                await using (var output = File.Create(temp))
                    await unzip.CopyToAsync(output, ct);
                File.Move(temp, _geo.DbPath, overwrite: true);
                if (!_geo.TryLoad(_geo.DbPath)) throw new InvalidDataException("the downloaded file is not a readable database");
                _logger.LogInformation("Visitor location database updated ({Month:yyyy-MM}).", month);
                return true;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return false;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Could not download the visitor location database for {Month:yyyy-MM}.", month);
                return false;
            }
            finally
            {
                try { if (File.Exists(temp)) File.Delete(temp); } catch (IOException) { }
            }
        }
        return false;
    }
}

/// <summary>The address a request really came from - only for the location lookup and the visit beacon's rate
/// limit, never stored. Behind the reverse proxy (Traefik - the request arrives from a private address) it is the
/// address the proxy saw: X-Real-IP, else the last X-Forwarded-For hop (the one the proxy added; earlier hops are
/// whatever the client claimed). A request arriving straight from a public address is that address - its headers
/// are not trusted.</summary>
public static class ClientAddress
{
    public static IPAddress? Of(HttpContext context)
    {
        var peer = Normal(context.Connection.RemoteIpAddress);
        if (peer is null || !IsPrivate(peer)) return peer;
        if (IPAddress.TryParse(context.Request.Headers["X-Real-IP"].ToString().Trim(), out var real)) return Normal(real);
        var forwarded = context.Request.Headers["X-Forwarded-For"].ToString();
        var last = forwarded.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).LastOrDefault();
        return last is not null && IPAddress.TryParse(last, out var hop) ? Normal(hop) : peer;
    }

    private static IPAddress? Normal(IPAddress? address) => address is { IsIPv4MappedToIPv6: true } ? address.MapToIPv4() : address;

    public static bool IsPrivate(IPAddress address)
    {
        address = Normal(address)!;
        if (IPAddress.IsLoopback(address)) return true;
        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            var b = address.GetAddressBytes();
            return b[0] == 10 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254)
                || (b[0] == 100 && b[1] >= 64 && b[1] <= 127);
        }
        if (address.AddressFamily == AddressFamily.InterNetworkV6)
            return address.IsIPv6LinkLocal || address.IsIPv6SiteLocal || (address.GetAddressBytes()[0] & 0xFE) == 0xFC;
        return false;
    }
}
