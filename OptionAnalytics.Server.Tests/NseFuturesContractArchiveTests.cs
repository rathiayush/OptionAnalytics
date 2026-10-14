using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Tests;

/// <summary>NSE's F&amp;O contract master (the source for expired futures) and Dhan's tick-size units.</summary>
public sealed class NseFuturesContractArchiveTests
{
    // Real rows from NSE_FO_contract_01102026.csv.gz: two index futures and one option (ignored).
    private const string Sample = """
FinInstrmId,UndrlygFinInstrmId,FinInstrmNm,TckrSymb,XpryDt,StrkPric,OptnTp,PrtdToTrad,MinLot,NewBrdLotQty,BidIntrvl,StartDt,EndDt,MtrtyDt,PdctStartDt,SrsId,AsstCd,UndrlygInstrmAsstClss,StockNm,SttlmMtd,BasePric,DelFlg,ExrcStartDt,ExrcEndDt,IssdCptl,MinPric,MaxPric,MktTpAndId,OffclCorpActnEvtId,AdmssnTp,IssePric,TradgStsNrmlMkt,ElgbltyNrmlMkt,TradgStsOddLotMkt,ElgbltyOddLotMkt,TradgStsSpotMkt,ElgbltySpotMkt,TradgStsAuctnMkt,ElgbltyAuctnMkt,MrgnPctg,MaxTradQty,WrngQty,AdmssnDt,RmvlDt,RadmssnDt,RcrdDt,NoDlvryStartDt,NoDlvryEndDt,SpclExDt,BookClsrStartDt,BookClsrEndDt,StockRcrdDt,TckrSelctn,OdOffclCorpActnEvtId,CdtRatg,Mtg,IntrstOrDvdd,RghtsOrBns,MinFillAllOrNn,AddtlInf,OptnExrcStyle,ExrcAllwd,ExrcRjctAllwd,PLAllwd,CorpAdjstmnt,UndrlygInstrm,DcmlstnPric,PartnIdr,UnqPdctIdr,CpctyGrpId,SctyId,Mltplr,SctyLngNm,UndrlygMkt,CtrctTp,FinInstrmPdctTpCd,FinInstrmTp,TradToTradInd,IndxFlg,Indx,IndxPrtcptnInd,ExtrnlDataSrcFlg,LastUpd,FinInstrmGnlAttrbts,AddtlUndrlygAttrbts,UndrlygAsst,OrgnlXpryDt,SgmtId,UnitOfMeasr,PricQtQty,PricRgTp,InitlMrgnTp,BuyInitlMrgnRate,MaxSnglTxnQty,MaxSnglTxnVal,AsstClss,NearMnthInstrmIdr,FarMnthInstrmIdr,PricNmrtr,Spcfctn,PricDnmtr,GnlNmrtr,GnlDnmtr,LotNmrtr,LotDnmtr,DcmlLctr,SttlmTp,ParVal,CorpActnRsn,FreeFltCptl,ISIN,SellInitlMrgnRate,RatgDtls,FinInstrmClssfctn,SpclMrgnTp,BuySpclMrgnRat,SellSpclMrgnRat,InitlMrgnSprdBnftFlg,InstrmEndDtTm,Ccy,PdctMnth,GrpId,MtchgCrit,SprdTp,ValMtd,SLBMElgblty,PricMtd,InstrmId,XpryPrcDt,MrgnInd,RglrBuyMrgn,RglrSellMrgn,SprdBnftAllwd,DlvryWght,DlvryUnit,Rsvd01,Rsvd02,Rsvd03,Rsvd04,Rsvd05,Rsvd06,Rsvd07,Rsvd08,Rsvd09,Rsvd10,Rsvd11,Rsvd12,Rsvd13,Rsvd14,Rsvd15
48699,26009,FUTIDX,BANKNIFTY,1477578600,-1,XX,0,30,30,20,1469750400,0,1477578600,,XX,,,BANKNIFTY26OCTFUT,C,5479480,N,0,0,1.000000E+12,4931540,6027420,1,0,0,0,6,1,2,0,2,0,3,0,0,1.441000E+03,0,1469750400,0,0,0,0,0,0,0,0,1475345401,15,1,            ,0,0,0,0,,E,N,N,N,N,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,
48704,26000,FUTIDX,NIFTY,1477578600,-1,XX,0,65,65,10,1469750400,0,1477578600,,XX,,,NIFTY26OCTFUT,C,2253030,N,0,0,1.000000E+12,2027730,2478330,1,0,0,0,6,1,2,0,2,0,3,0,0,3.511000E+03,0,1469750400,0,0,0,0,0,0,0,0,1475345401,15,1,            ,0,0,0,0,,E,N,N,N,N,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,
35008,26000,OPTIDX,NIFTY,1475764200,1735000,CE,1,65,65,5,1475280000,0,1475764200,,XX,,,NIFTY26O0617350CE,C,507760,N,1475712000,1475764200,1.000000E+12,451955,563565,1,0,0,0,2,1,2,0,2,0,3,0,0,3.511000E+03,0,1475280000,0,0,0,0,0,0,0,0,1475345412,15,1,            ,0,0,0,0,,E,N,N,N,N,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,
""";

    [Fact]
    public void Parse_ReadsIndexFuturesWithTheirTokensExpiriesLotsAndTicks()
    {
        var contracts = NseFuturesContractArchive.Parse(new StringReader(Sample));

        Assert.Equal(2, contracts.Count);
        var bank = contracts.Single(c => c.Underlying == "BANKNIFTY");
        Assert.Equal(48699u, bank.SecurityId);              // = Dhan's security id for BANKNIFTY-Oct2026-FUT
        Assert.Equal(new DateOnly(2026, 10, 27), bank.Expiry);
        Assert.Equal(30, bank.LotSize);
        Assert.Equal(0.20m, bank.TickSize);                  // BidIntrvl 20 paise
        Assert.Equal("BANKNIFTY-Oct2026-FUT", bank.TradingSymbol);
        Assert.Equal("NSE_FNO", bank.DhanSegment);
        var nifty = contracts.Single(c => c.Underlying == "NIFTY");
        Assert.Equal(48704u, nifty.SecurityId);
        Assert.Equal(0.10m, nifty.TickSize);
        Assert.Equal(65, nifty.LotSize);
    }

    [Theory]
    [InlineData(5, 0.05)]    // index option
    [InlineData(10, 0.10)]   // NIFTY futures, RELIANCE
    [InlineData(20, 0.20)]   // BANKNIFTY futures
    [InlineData(1, 0.01)]
    [InlineData(0, 0)]
    public void ScripMasterTickSize_IsInPaise(double paise, double rupees) =>
        Assert.Equal((decimal)rupees, DhanSymbology.TickSizeFromScripMaster((decimal)paise));

    [Fact]
    public void OnlyNseIndexUnderlyingsAreCovered()
    {
        Assert.True(NseFuturesContractArchive.Covers("nifty"));
        Assert.True(NseFuturesContractArchive.Covers("BANKNIFTY"));
        Assert.False(NseFuturesContractArchive.Covers("SENSEX"));
    }

    /// <summary>Serves the sample contract master for any date (gzip), counting downloads; the first `timeouts` calls
    /// time out the way HttpClient's own timeout does.</summary>
    private sealed class CountingNse(int timeouts = 0) : HttpMessageHandler
    {
        public int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (Interlocked.Increment(ref Calls) <= timeouts) throw new TaskCanceledException("The request was canceled due to the configured HttpClient.Timeout");
            var ms = new MemoryStream();
            using (var gz = new System.IO.Compression.GZipStream(ms, System.IO.Compression.CompressionLevel.Fastest, leaveOpen: true))
            using (var w = new StreamWriter(gz)) w.Write(Sample);
            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new ByteArrayContent(ms.ToArray()) });
        }
    }

    [Fact]
    public async Task ALongNewestFirstScan_KeepsEveryFile_NoDownloadTwice()
    {
        var nse = new CountingNse();
        var archive = new NseFuturesContractArchive(new HttpClient(nse), Microsoft.Extensions.Logging.Abstractions.NullLogger<NseFuturesContractArchive>.Instance);
        var days = Enumerable.Range(0, 120).Select(i => new DateOnly(2026, 10, 23).AddDays(-i)).Where(d => d.DayOfWeek is not (DayOfWeek.Saturday or DayOfWeek.Sunday)).ToList();
        foreach (var d in days) Assert.NotEmpty(await archive.ContractsOnAsync("NIFTY", d, CancellationToken.None));
        var first = nse.Calls;
        Assert.Equal(days.Count, first);
        // The same range again (a second tuning job, or the previous-session reads): all from the cache.
        foreach (var d in days) await archive.ContractsOnAsync("NIFTY", d, CancellationToken.None);
        Assert.Equal(first, nse.Calls);
    }

    [Fact]
    public async Task ATimeout_IsAPlainFailure_AndIsNotRemembered()
    {
        var nse = new CountingNse(timeouts: 1);
        var archive = new NseFuturesContractArchive(new HttpClient(nse), Microsoft.Extensions.Logging.Abstractions.NullLogger<NseFuturesContractArchive>.Instance);
        var day = new DateOnly(2026, 10, 1);
        // Not an OperationCanceledException: callers' "not a cancellation" catches see it (it used to escape as a 500).
        await Assert.ThrowsAsync<TimeoutException>(() => archive.ContractsOnAsync("NIFTY", day, CancellationToken.None));
        await Task.Delay(50); // the cache drops the failed download
        Assert.NotEmpty(await archive.ContractsOnAsync("NIFTY", day, CancellationToken.None));
        Assert.Equal(2, nse.Calls);
    }
}
