namespace OptionAnalytics.Server;

/// <summary>
/// Whether a folder survives a redeploy. In a container, a folder that is not on a mounted volume lives in the container's
/// own file system (overlay) and is gone when a deploy replaces the container - then every saved Dhan answer (DhanDataCache,
/// TodayDiskStore) is lost and asked of Dhan again. Read from /proc/self/mountinfo (Linux): the mount the folder is on is
/// persistent unless it is the container's overlay (or memory - tmpfs). Null where it cannot be told (no mountinfo -
/// Windows / macOS development).
/// </summary>
public static class StorageVolume
{
    private static readonly HashSet<string> NotKept = new(StringComparer.Ordinal) { "overlay", "aufs", "tmpfs", "ramfs" };

    /// <summary>Whether `path` is on a mount kept across a redeploy; `mountInfo` the text of /proc/self/mountinfo (read when
    /// not given - for the tests).</summary>
    public static bool? IsPersistent(string path, string? mountInfo = null)
    {
        mountInfo ??= TryRead("/proc/self/mountinfo");
        if (string.IsNullOrEmpty(mountInfo)) return null;
        var full = Path.GetFullPath(path).TrimEnd('/');
        if (full.Length == 0) full = "/";
        string? bestPoint = null, bestType = null;
        foreach (var line in mountInfo.Split('\n'))
        {
            // "36 35 98:0 /mnt1 /app/data rw,noatime master:1 - ext4 /dev/sda1 rw": the mount point is the 5th field, the
            // file system type the first after " - ".
            var sep = line.IndexOf(" - ", StringComparison.Ordinal);
            if (sep < 0) continue;
            var left = line[..sep].Split(' ');
            var right = line[(sep + 3)..].Split(' ');
            if (left.Length < 5 || right.Length < 1) continue;
            var point = Unescape(left[4]);
            if (!IsUnder(full, point)) continue;
            // The deepest mount holding the folder - a later one at the same point covers an earlier one.
            if (bestPoint is null || point.Length >= bestPoint.Length) { bestPoint = point; bestType = right[0]; }
        }
        return bestType is null ? null : !NotKept.Contains(bestType);
    }

    private static bool IsUnder(string path, string mountPoint) =>
        mountPoint == "/" || path == mountPoint || path.StartsWith(mountPoint.TrimEnd('/') + "/", StringComparison.Ordinal);

    // mountinfo writes a space as \040, a tab \011, a newline \012 and a backslash \134.
    private static string Unescape(string s) => s.Replace("\\040", " ").Replace("\\011", "\t").Replace("\\012", "\n").Replace("\\134", "\\");

    private static string? TryRead(string path)
    {
        try { return File.Exists(path) ? File.ReadAllText(path) : null; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
    }
}
