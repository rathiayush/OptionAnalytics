using System.Collections.Concurrent;
using System.Globalization;

namespace OptionAnalytics.Server.Dhan;

/// <summary>One participant group's open positions in NSE's index derivatives at a day's close, in contracts.</summary>
public sealed record ParticipantOiRow(string Type, long FutureLong, long FutureShort, long CallLong, long PutLong, long CallShort, long PutShort);

/// <summary>NSE's participant-wise open interest of one day: Client, DII, FII, Pro (and TOTAL).</summary>
public sealed record ParticipantOiDay(DateOnly Date, IReadOnlyList<ParticipantOiRow> Rows);

/// <summary>
/// NSE's daily "participant wise open interest" (fao_participant_oi_{ddMMyyyy}.csv on nsearchives): how many index option
/// calls and puts Clients, DIIs, FIIs and Pro (proprietary desks) hold LONG and SHORT at the close - the only public record
/// of who holds what. OI Replay's GEX reads it to sign the dealers' positions from data instead of assuming "long every
/// call, short every put". All NSE index options together (NIFTY, BANKNIFTY, ... every expiry), not per strike or index.
///
/// NO LOOK-AHEAD: a day's file is published that evening, so a session reads the latest file BEFORE its own day
/// (<see cref="LatestBeforeAsync"/>). A past day's file never changes: kept on disk (NseDayStore, "participant-oi" - a day
/// with no file, a holiday, kept empty), so NSE is asked once a day; after NSE does not answer it is not asked again for a
/// few minutes (NseBackoff). A page load / click only - nothing polls.
/// </summary>
public sealed class NseParticipantOi
{
    public const string UrlFormat = "https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_{0}.csv";
    private const string Kind = "participant-oi";
    public const int MaxDaysBack = 10;

    private readonly HttpClient _http;
    private readonly ILogger<NseParticipantOi> _logger;
    private readonly NseDayStore _disk;
    private readonly NseBackoff _backoff = new();
    private readonly ConcurrentDictionary<DateOnly, Task<ParticipantOiDay?>> _days = new();
    internal NseBackoff Backoff => _backoff;

    public NseParticipantOi(HttpClient http, ILogger<NseParticipantOi> logger, NseDayStore? disk = null)
    {
        _http = http;
        _logger = logger;
        _disk = disk ?? new NseDayStore(null);
        if (_http.DefaultRequestHeaders.UserAgent.Count == 0)
            _http.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (X11; Linux x86_64) OptionAnalytics");
        _http.Timeout = TimeSpan.FromSeconds(20);
    }

    /// <summary>The latest day's positions published BEFORE <paramref name="day"/> (at most <see cref="MaxDaysBack"/> days
    /// back); null when NSE has none there or cannot be reached.</summary>
    public async Task<ParticipantOiDay?> LatestBeforeAsync(DateOnly day, CancellationToken cancellationToken)
    {
        var today = IstClock.Today();
        for (var back = 1; back <= MaxDaysBack; back++)
        {
            var d = day.AddDays(-back);
            if (d >= today || d.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) continue;
            ParticipantOiDay? found;
            try { found = await DayAsync(d, cancellationToken); }
            catch (Exception ex) when (ex is HttpRequestException or TimeoutException) { return null; }
            if (found is { Rows.Count: > 0 }) return found;
            if (found is null) return null; // NSE not answering: no older day passed off as the latest
        }
        return null;
    }

    // A day's file: its rows, an EMPTY day when NSE has no file for it (a holiday), null when NSE cannot be asked now.
    private Task<ParticipantOiDay?> DayAsync(DateOnly day, CancellationToken cancellationToken)
    {
        var name = $"{day:yyyy-MM-dd}";
        if (!_days.ContainsKey(day) && _disk.Has(Kind, name) && _disk.Read<ParticipantOiDay>(Kind, name) is { } kept)
            _days[day] = Task.FromResult<ParticipantOiDay?>(kept);
        if (!_days.ContainsKey(day) && _backoff.IsDown(out _)) return Task.FromResult<ParticipantOiDay?>(null);
        var task = _days.GetOrAdd(day, DownloadAsync);
        // Only an answer is remembered: a failure, NSE blocking us, or yesterday's file not out yet is asked again later.
        var recent = day >= IstClock.Today().AddDays(-1);
        _ = task.ContinueWith(t => { if (t.IsFaulted || t.IsCanceled || t.Result is null || (recent && t.Result.Rows.Count == 0)) _days.TryRemove(day, out _); }, TaskScheduler.Default);
        return task.WaitAsync(cancellationToken);
    }

    private async Task<ParticipantOiDay?> DownloadAsync(DateOnly day)
    {
        var url = string.Format(CultureInfo.InvariantCulture, UrlFormat, day.ToString("ddMMyyyy", CultureInfo.InvariantCulture));
        HttpResponseMessage responseMessage;
        try
        {
            responseMessage = await _http.GetAsync(url);
        }
        catch (TaskCanceledException ex)
        {
            _backoff.Failed();
            throw new TimeoutException($"NSE participant OI {day:yyyy-MM-dd} did not answer within {_http.Timeout.TotalSeconds:0} s.", ex);
        }
        catch (HttpRequestException)
        {
            _backoff.Failed();
            throw;
        }
        using var response = responseMessage;
        if (response.StatusCode is System.Net.HttpStatusCode.Forbidden) { _backoff.Failed(); return null; } // NSE blocking this address
        _backoff.Answered();
        var empty = new ParticipantOiDay(day, Array.Empty<ParticipantOiRow>());
        if (response.StatusCode is System.Net.HttpStatusCode.NotFound)
        {
            // No file: a holiday - kept, unless it is yesterday's (published late in the evening; asked again).
            if (day < IstClock.Today().AddDays(-1)) _disk.Write(Kind, $"{day:yyyy-MM-dd}", empty);
            return empty;
        }
        response.EnsureSuccessStatusCode();
        var rows = Parse(new StringReader(await response.Content.ReadAsStringAsync()));
        if (rows.Count == 0) return empty; // not the file expected (a page instead): nothing kept
        var result = new ParticipantOiDay(day, rows);
        _logger.LogInformation("NSE participant OI {Day}: {Count} row(s).", day, rows.Count);
        _disk.Write(Kind, $"{day:yyyy-MM-dd}", result);
        return result;
    }

    /// <summary>The rows of NSE's file: a title line, a header naming the columns, then Client / DII / FII / Pro / TOTAL.</summary>
    internal static List<ParticipantOiRow> Parse(TextReader reader)
    {
        var result = new List<ParticipantOiRow>();
        string[]? header = null;
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            var cells = line.Split(',').Select(c => c.Trim().Trim('"').Trim()).ToArray();
            if (header is null)
            {
                if (cells[0].Equals("Client Type", StringComparison.OrdinalIgnoreCase)) header = cells;
                continue;
            }
            int Col(string name) => Array.FindIndex(header, h => h.Equals(name, StringComparison.OrdinalIgnoreCase));
            long At(string name) => Col(name) is var i && i >= 0 && i < cells.Length
                && long.TryParse(cells[i], NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : -1;
            long callLong = At("Option Index Call Long"), putLong = At("Option Index Put Long"), callShort = At("Option Index Call Short"), putShort = At("Option Index Put Short");
            if (cells[0].Length == 0 || callLong < 0 || putLong < 0 || callShort < 0 || putShort < 0) continue;
            result.Add(new ParticipantOiRow(cells[0], Math.Max(0, At("Future Index Long")), Math.Max(0, At("Future Index Short")), callLong, putLong, callShort, putShort));
        }
        return result;
    }
}
