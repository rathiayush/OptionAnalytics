using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Tests;

/// <summary>NSE's participant-wise open interest (the GEX sign's data): the file read, the latest day BEFORE a session,
/// kept on disk, holidays stepped over, NSE not answering.</summary>
public sealed class NseParticipantOiTests
{
    // NSE's own file of 13 Nov 2026 (fao_participant_oi_13112026.csv), as served.
    private const string Sample = "\"Participant wise Open Interest (no. of contracts) in Equity Derivatives as on Nov 13, 2026\",,,,,,,,,,,,,,\n"
        + "Client Type,Future Index Long,Future Index Short,Future Stock Long,Future Stock Short       ,Option Index Call Long,Option Index Put Long,Option Index Call Short,Option Index Put Short,Option Stock Call Long,Option Stock Put Long,Option Stock Call Short,Option Stock Put Short,Total Long Contracts      ,Total Short Contracts\n"
        + "Client,172887,110311,3183726,382317,3780052,3498034,3648876,3942456,2261843,1262217,1227217,1215762,14158760,10526939\n"
        + "DII,54379,28098,350882,4303788,2363,104506,1350,1200,2956,40262,461468,32903,555348,4828807\n"
        + "FII,62546,118466,3586466,2585271,755197,1137053,972780,749988,337709,419459,450575,335393,6298430,5212472\n"
        + "Pro,25143,58080,746396,596094,1321341,1162085,1235947,1208034,1361239,1121512,1824487,1259392,5737715,6182034\n"
        + "TOTAL,314955,314955,7867470,7867470,5858953,5901678,5858953,5901678,3963747,2843450,3963747,2843450,26750253,26750253\n";

    [Fact]
    public void Parse_ReadsEachGroupsIndexOptionAndFuturePositions()
    {
        var rows = NseParticipantOi.Parse(new StringReader(Sample));
        Assert.Equal(new[] { "Client", "DII", "FII", "Pro", "TOTAL" }, rows.Select(r => r.Type));
        Assert.Equal(new ParticipantOiRow("Pro", 25143, 58080, 1321341, 1162085, 1235947, 1208034), rows[3]);
        Assert.Equal(new ParticipantOiRow("Client", 172887, 110311, 3780052, 3498034, 3648876, 3942456), rows[0]);
        // Every long has a short: the groups' longs add up to their shorts.
        var groups = rows.Take(4).ToList();
        Assert.Equal(groups.Sum(r => r.CallLong), groups.Sum(r => r.CallShort));
        Assert.Equal(groups.Sum(r => r.PutLong), groups.Sum(r => r.PutShort));
        Assert.Empty(NseParticipantOi.Parse(new StringReader("<html>blocked</html>")));
    }

    /// <summary>Serves the sample for the days given, 404 for any other; counts what was asked.</summary>
    private sealed class FakeNse(params string[] daysWithFile) : HttpMessageHandler
    {
        public readonly List<string> Asked = new();
        public bool Fail;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var name = request.RequestUri!.Segments[^1];
            lock (Asked) Asked.Add(name);
            if (Fail) throw new HttpRequestException("no route");
            var has = daysWithFile.Any(d => name == $"fao_participant_oi_{d}.csv");
            return Task.FromResult(has
                ? new HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new StringContent(Sample) }
                : new HttpResponseMessage(System.Net.HttpStatusCode.NotFound));
        }
    }

    private static NseParticipantOi New(HttpMessageHandler nse, string? dir = null) =>
        new(new HttpClient(nse), NullLogger<NseParticipantOi>.Instance, new NseDayStore(dir));

    [Fact]
    public async Task ASessionReadsTheLatestFileBeforeItsOwnDay_NeverItsOwn_SteppingOverWeekendsAndHolidays()
    {
        // Mon 16 Nov 2026: Friday the 13th's file. Its own day's file exists too and must not be read.
        var nse = new FakeNse("13112026", "16112026", "10112026");
        var source = New(nse);
        var monday = await source.LatestBeforeAsync(new DateOnly(2026, 11, 16), CancellationToken.None);
        Assert.Equal(new DateOnly(2026, 11, 13), monday!.Date);
        Assert.Equal(new[] { "fao_participant_oi_13112026.csv" }, nse.Asked);
        // Fri 13 Nov: Thursday the 12th and Wednesday the 11th have no file (holidays) - Tuesday the 10th's.
        var friday = await source.LatestBeforeAsync(new DateOnly(2026, 11, 13), CancellationToken.None);
        Assert.Equal(new DateOnly(2026, 11, 10), friday!.Date);
        // Asked again: nothing goes to NSE.
        var asked = nse.Asked.Count;
        await source.LatestBeforeAsync(new DateOnly(2026, 11, 13), CancellationToken.None);
        await source.LatestBeforeAsync(new DateOnly(2026, 11, 16), CancellationToken.None);
        Assert.Equal(asked, nse.Asked.Count);
        // Nothing within the days looked back: none.
        Assert.Null(await New(new FakeNse()).LatestBeforeAsync(new DateOnly(2026, 11, 13), CancellationToken.None));
    }

    [Fact]
    public async Task ADaysFileIsKeptOnDisk_AndReadAfterARestart_WithNoNseCall()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"nse-poi-{Guid.NewGuid():N}");
        try
        {
            var day = new DateOnly(2026, 11, 13);
            var first = await New(new FakeNse("10112026"), dir).LatestBeforeAsync(day, CancellationToken.None);
            var second = new FakeNse();
            var again = await New(second, dir).LatestBeforeAsync(day, CancellationToken.None);
            Assert.Equal(first!.Date, again!.Date);
            Assert.Equal(first.Rows, again.Rows);
            Assert.Empty(second.Asked); // the two holidays before it were kept too
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task NseNotAnswering_GivesNone_AndIsNotAskedAgainRightAway()
    {
        var nse = new FakeNse("13112026") { Fail = true };
        var source = New(nse);
        Assert.Null(await source.LatestBeforeAsync(new DateOnly(2026, 11, 16), CancellationToken.None));
        Assert.Single(nse.Asked);
        await Task.Delay(50);
        nse.Fail = false;
        Assert.Null(await source.LatestBeforeAsync(new DateOnly(2026, 11, 16), CancellationToken.None)); // backing off
        Assert.Single(nse.Asked);
        source.Backoff.Answered();
        Assert.NotNull(await source.LatestBeforeAsync(new DateOnly(2026, 11, 16), CancellationToken.None));
    }
}
