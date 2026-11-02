using System.Text;

namespace OptionAnalytics.Server.Services.SignalStrategies;

/// <summary>
/// A small CSV table on disk - a header row, then one line a row (a value never spans lines: a line break in it becomes a
/// space), a cell quoted when it holds a comma or a quote, and a value starting like a formula (= + - @ tab) kept as
/// text with a leading apostrophe so a spreadsheet does not run it (read back without it). Written whole to a temporary
/// file and moved over the old one, so a reader never sees half a file.
/// </summary>
public static class CsvTable
{
    public static string Cell(string? value)
    {
        var v = (value ?? "").Replace("\r", " ").Replace('\n', ' ');
        if (v.Length > 0 && "=+-@\t".Contains(v[0]) && !LooksNumeric(v)) v = "'" + v;
        return v.IndexOfAny(new[] { ',', '"' }) >= 0 ? $"\"{v.Replace("\"", "\"\"")}\"" : v;
    }

    // A number (a negative P&L) is left as it is - it is no formula.
    private static bool LooksNumeric(string v) => double.TryParse(v, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out _);

    public static string Uncell(string v) => v.Length > 1 && v[0] == '\'' && "=+-@\t".Contains(v[1]) ? v[1..] : v;

    public static List<string> SplitRow(string line)
    {
        var fields = new List<string>();
        var field = new StringBuilder();
        var quoted = false;
        for (var i = 0; i < line.Length; i++)
        {
            var c = line[i];
            if (quoted)
            {
                if (c == '"' && i + 1 < line.Length && line[i + 1] == '"') { field.Append('"'); i++; }
                else if (c == '"') quoted = false;
                else field.Append(c);
            }
            else if (c == '"') quoted = true;
            else if (c == ',') { fields.Add(field.ToString()); field.Clear(); }
            else if (c != '\r') field.Append(c);
        }
        fields.Add(field.ToString());
        return fields;
    }

    /// <summary>The rows of a file as column -> value (by its own header); none when there is no file.</summary>
    public static List<Dictionary<string, string>> Read(string path)
    {
        var rows = new List<Dictionary<string, string>>();
        if (!File.Exists(path)) return rows;
        string[]? header = null;
        foreach (var line in File.ReadLines(path))
        {
            if (line.Length == 0) continue;
            var cells = SplitRow(line);
            if (header is null) { header = cells.ToArray(); continue; }
            var row = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (var i = 0; i < header.Length; i++) row[header[i]] = i < cells.Count ? Uncell(cells[i]) : "";
            rows.Add(row);
        }
        return rows;
    }

    /// <summary>Writes the whole table (the columns in this order).</summary>
    public static void Write(string path, IReadOnlyList<string> columns, IEnumerable<IReadOnlyDictionary<string, string?>> rows)
    {
        var text = new StringBuilder();
        text.AppendLine(string.Join(',', columns.Select(Cell)));
        foreach (var row in rows) text.AppendLine(string.Join(',', columns.Select(c => Cell(row.TryGetValue(c, out var v) ? v : null))));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + ".tmp";
        File.WriteAllText(temp, text.ToString());
        File.Move(temp, path, overwrite: true);
    }

    /// <summary>Adds rows at the end (the header first when the file is new).</summary>
    public static void Append(string path, IReadOnlyList<string> columns, IEnumerable<IReadOnlyDictionary<string, string?>> rows)
    {
        var text = new StringBuilder();
        if (!File.Exists(path)) text.AppendLine(string.Join(',', columns.Select(Cell)));
        foreach (var row in rows) text.AppendLine(string.Join(',', columns.Select(c => Cell(row.TryGetValue(c, out var v) ? v : null))));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.AppendAllText(path, text.ToString());
    }
}
