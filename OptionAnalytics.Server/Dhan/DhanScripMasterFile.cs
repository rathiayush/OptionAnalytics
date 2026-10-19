namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// Dhan's scrip master (api-scrip-master.csv, tens of MB) kept as ONE file on disk and shared. The spot, futures and option-chain
/// masters each used to download it themselves - three downloads after every start (and every redeploy), with the first page load
/// waiting on them. With <see cref="Directory"/> set (Program.cs: under the Dhan cache, the persistent volume) the file is downloaded
/// once, kept for <see cref="MaxAge"/>, and every master reads it from disk; a failed download falls back to the copy kept (however
/// old) rather than failing. Without a directory (the tests) every caller downloads, exactly as before.
/// </summary>
public static class DhanScripMasterFile
{
    /// <summary>Where the file is kept; null = no disk copy.</summary>
    public static string? Directory { get; set; }

    /// <summary>How old the kept copy may be before it is downloaded again. The masters refresh every 12 h on top of this, so a contract
    /// listed today is seen within about half a day, as before.</summary>
    public static TimeSpan MaxAge { get; set; } = TimeSpan.FromHours(4);

    private static readonly SemaphoreSlim Gate = new(1, 1);

    /// <summary>The scrip master as a stream - from the kept file (downloaded first when it is missing or older than MaxAge), or straight
    /// from Dhan when no directory is set. The caller disposes it.</summary>
    public static Task<Stream> OpenAsync(HttpClient http, string url, ILogger logger, CancellationToken cancellationToken) =>
        OpenAsync(http, url, logger, cancellationToken, Directory, MaxAge);

    /// <summary>The same with the directory and age given (the tests - the static settings are the app's).</summary>
    internal static async Task<Stream> OpenAsync(HttpClient http, string url, ILogger logger, CancellationToken cancellationToken, string? directory, TimeSpan maxAge)
    {
        if (directory is not { Length: > 0 } dir) return await DownloadStreamAsync(http, url, cancellationToken);
        var path = Path.Combine(dir, "api-scrip-master.csv");
        await Gate.WaitAsync(cancellationToken);
        try
        {
            var fresh = File.Exists(path) && DateTime.UtcNow - File.GetLastWriteTimeUtc(path) < maxAge;
            if (!fresh)
            {
                var tmp = $"{path}.{Guid.NewGuid():N}.tmp";
                try
                {
                    System.IO.Directory.CreateDirectory(dir);
                    await using (var source = await DownloadStreamAsync(http, url, cancellationToken))
                    await using (var file = File.Create(tmp))
                        await source.CopyToAsync(file, cancellationToken);
                    File.Move(tmp, path, overwrite: true);
                    logger.LogInformation("Dhan scrip master downloaded to {Path} ({Size:0.0} MB) - shared by every instrument master.", path, new FileInfo(path).Length / 1048576d);
                }
                catch (Exception ex) when (ex is not OperationCanceledException && File.Exists(path))
                {
                    logger.LogWarning(ex, "Dhan scrip master download failed - using the copy kept at {Path} ({Age:0.0} h old).", path, (DateTime.UtcNow - File.GetLastWriteTimeUtc(path)).TotalHours);
                }
                finally
                {
                    try { if (File.Exists(tmp)) File.Delete(tmp); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                }
            }
        }
        finally
        {
            Gate.Release();
        }
        return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16, useAsync: true);
    }

    private static async Task<Stream> DownloadStreamAsync(HttpClient http, string url, CancellationToken cancellationToken)
    {
        var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        try
        {
            response.EnsureSuccessStatusCode();
            return new ResponseOwningStream(await response.Content.ReadAsStreamAsync(cancellationToken), response);
        }
        catch
        {
            response.Dispose();
            throw;
        }
    }

    /// <summary>A response body that disposes its response with it.</summary>
    private sealed class ResponseOwningStream(Stream inner, HttpResponseMessage response) : Stream
    {
        public override bool CanRead => inner.CanRead;
        public override bool CanSeek => inner.CanSeek;
        public override bool CanWrite => false;
        public override long Length => inner.Length;
        public override long Position { get => inner.Position; set => inner.Position = value; }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => inner.Read(buffer, offset, count);
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) => inner.ReadAsync(buffer, offset, count, cancellationToken);
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => inner.ReadAsync(buffer, cancellationToken);
        public override long Seek(long offset, SeekOrigin origin) => inner.Seek(offset, origin);
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing)
        {
            if (disposing) { inner.Dispose(); response.Dispose(); }
            base.Dispose(disposing);
        }
    }
}
