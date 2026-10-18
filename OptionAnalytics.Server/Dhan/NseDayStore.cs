using System.IO.Compression;
using System.Text.Json;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// What NSE answered for a PAST day, kept on disk (gzip JSON) so it is asked of NSE once - not again after every restart or redeploy,
/// when the in-memory copies are gone. A past day's contract list or 1-minute bars never change. Used by NseFuturesContractArchive and
/// NseChartHistory; <see cref="Directory"/> null (the tests) keeps nothing.
/// </summary>
public sealed class NseDayStore(string? directory)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public string? Directory { get; } = directory;

    private string? PathOf(string kind, string name) => Directory is { Length: > 0 } d ? Path.Combine(d, kind, $"{name}.json.gz") : null;

    /// <summary>Whether anything is kept under this name.</summary>
    public bool Has(string kind, string name) => PathOf(kind, name) is { } p && File.Exists(p);

    /// <summary>The value kept, else default (also for a file that cannot be read - it is deleted and asked again).</summary>
    public T? Read<T>(string kind, string name)
    {
        if (PathOf(kind, name) is not { } path || !File.Exists(path)) return default;
        try
        {
            using var file = File.OpenRead(path);
            using var gz = new GZipStream(file, CompressionMode.Decompress);
            return JsonSerializer.Deserialize<T>(gz, Json);
        }
        catch (Exception ex) when (ex is IOException or JsonException or InvalidDataException or UnauthorizedAccessException)
        {
            try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            return default;
        }
    }

    /// <summary>Keeps a value (written to a temp file, then moved into place). A disk problem is swallowed - it is only a cache.</summary>
    public void Write<T>(string kind, string name, T value)
    {
        if (PathOf(kind, name) is not { } path) return;
        var tmp = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            System.IO.Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            using (var file = File.Create(tmp))
            using (var gz = new GZipStream(file, CompressionLevel.Fastest))
                JsonSerializer.Serialize(gz, value, Json);
            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}

/// <summary>
/// After NSE does not answer (a timeout, a network error, NSE blocking the server's address), it is not asked again for a few minutes:
/// every page load and every endpoint used to wait out the full 20 - 30 s timeout again, one after another, for an answer that was not
/// coming - and only then fall back. While NSE is "down" the callers fall back at once.
/// </summary>
public sealed class NseBackoff
{
    public static readonly TimeSpan Pause = TimeSpan.FromMinutes(10);
    private long _downUntilTicks;

    public bool IsDown(out DateTimeOffset until)
    {
        until = new DateTimeOffset(Interlocked.Read(ref _downUntilTicks), TimeSpan.Zero);
        return until > DateTimeOffset.UtcNow;
    }

    public void Failed() => Interlocked.Exchange(ref _downUntilTicks, (DateTimeOffset.UtcNow + Pause).UtcTicks);

    public void Answered() => Interlocked.Exchange(ref _downUntilTicks, 0);
}
