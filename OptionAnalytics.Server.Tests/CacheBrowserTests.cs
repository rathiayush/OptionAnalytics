using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Controllers;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>CacheBrowser / CacheController - the admin Cache page: each cache's folders and files with their sizes, a file
/// or a whole folder deleted (everything in a cache only when asked in so many words), nothing outside a cache's folder ever
/// reached - no "..", nothing absolute, no symlink followed (one inside a folder being deleted goes itself, what it points at
/// stays) - and admin only.</summary>
public sealed class CacheBrowserTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "oa-cache-" + Guid.NewGuid().ToString("n"));
    private string Dhan => Path.Combine(_dir, "dhan-cache");
    private string Flow => Path.Combine(_dir, "order-flow");
    private string Outside => Path.Combine(_dir, "outside");
    private int _afterDhan;
    private int _afterFlow;

    public CacheBrowserTests()
    {
        Write(Dhan, "v1/charts-intraday/days/2026-10/05/2026-10-05-aaa.json.gz", 100);
        Write(Dhan, "v1/charts-intraday/days/2026-10/05/2026-10-05-bbb.json.gz", 50);
        Write(Dhan, "v1/charts-intraday/days/2026-10/06/2026-10-06-ccc.json.gz", 30);
        Write(Dhan, "v1/charts-rollingoption/days/2026-10/05/2026-10-05-ddd.json.gz", 20);
        Write(Dhan, "scrip-master/api-scrip-master.csv", 1000);
        Write(Flow, "NIFTY/35001/2026-10-05.json.gz", 400);
        Write(Flow, "NIFTY/35001/2026-11-07.json.gz", 70);
        File.WriteAllText(Path.Combine(Flow, "NIFTY/35001/contract.json"), "{\"contractSymbol\":\"NIFTY-Nov2026-FUT\",\"expiry\":\"2026-11-25\"}");
        Write(Outside, "precious.csv", 5);
    }

    private static void Write(string root, string rel, int bytes)
    {
        var path = Path.Combine(root, rel);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, new byte[bytes]);
    }

    private CacheBrowser Browser() => new(new[]
    {
        new CacheRoot("dhan", "Dhan data cache", Dhan, "Dhan's past days", () => _afterDhan++),
        new CacheRoot("order-flow", "Order Flow days", Flow, "Recorded days", () => _afterFlow++),
        new CacheRoot("historical", "Historical spot CSVs", null, "Not kept here", null),
    }, NullLogger.Instance) { Today = () => "2026-11-07" };

    [Fact]
    public void Each_cache_and_each_folder_is_listed_with_its_files_and_size()
    {
        var browser = Browser();
        var roots = browser.Roots();
        Assert.Equal(new[] { "dhan", "order-flow", "historical" }, roots.Select(r => r.Id));
        Assert.Equal((5L, 1200L), (roots[0].Totals.Files, roots[0].Totals.Bytes));
        Assert.Equal(3L, roots[1].Totals.Files);                                                    // contract.json counts too
        Assert.False(roots[2].Exists);

        // The top: folders first, each with everything under it.
        var top = browser.List("dhan", "").Listing!;
        Assert.Equal(new[] { "scrip-master", "v1" }, top.Entries.Select(e => e.Name));
        var v1 = top.Entries.Single(e => e.Name == "v1");
        Assert.Equal((true, 4L, 200L, "v1"), (v1.Folder, v1.Files, v1.Bytes, v1.Path));
        Assert.Contains("one gzip file per instrument and day", v1.About);
        // A day's folder: its files with their sizes; paths stay relative to the cache.
        var day = browser.List("dhan", "v1/charts-intraday/days/2026-10/05").Listing!;
        Assert.Equal(new[] { ("2026-10-05-aaa.json.gz", 100L), ("2026-10-05-bbb.json.gz", 50L) }, day.Entries.Select(e => (e.Name, e.Bytes)));
        Assert.Equal("v1/charts-intraday/days/2026-10/05/2026-10-05-aaa.json.gz", day.Entries[0].Path);
        Assert.Equal(150L, day.Totals.Bytes);
        // Order Flow: a contract folder says which contract; today's day says it comes back.
        var nifty = browser.List("order-flow", "NIFTY").Listing!;
        Assert.Equal("NIFTY-Nov2026-FUT · expiry 25 Nov 2026", Assert.Single(nifty.Entries).About);
        var days = browser.List("order-flow", "NIFTY/35001").Listing!;
        Assert.Contains("next checkpoint", days.Entries.Single(e => e.Name == "2026-11-07.json.gz").About);
        Assert.Null(days.Entries.Single(e => e.Name == "2026-10-05.json.gz").About);
        // A file is not a folder; a folder not there says so; a cache not on disk says so.
        Assert.Contains("file", browser.List("dhan", "scrip-master/api-scrip-master.csv").Error);
        Assert.StartsWith("Not found", browser.List("dhan", "v2").Error);
        Assert.Contains("not kept on disk", browser.List("historical", "").Error);
        Assert.Equal("No such cache.", browser.List("preferences", "").Error);
    }

    [Theory]
    [InlineData("..")]
    [InlineData("../outside")]
    [InlineData("v1/../../outside")]
    [InlineData("/etc")]
    [InlineData("./v1")]
    [InlineData("C:/Windows")]
    [InlineData("v1/\0")]
    public void Nothing_outside_a_caches_folder_is_reached(string path)
    {
        var browser = Browser();
        Assert.Equal("Not a path inside this cache.", browser.List("dhan", path).Error);
        Assert.Equal("Not a path inside this cache.", browser.Delete("dhan", path, "me").Error);
        Assert.True(File.Exists(Path.Combine(Outside, "precious.csv")));
        Assert.Equal(5L, browser.Roots()[0].Totals.Files);
    }

    [Fact]
    public void A_symlink_is_never_followed()
    {
        Directory.CreateSymbolicLink(Path.Combine(Dhan, "sneaky"), Outside);
        File.CreateSymbolicLink(Path.Combine(Dhan, "v1", "sneaky.csv"), Path.Combine(Outside, "precious.csv"));
        var browser = Browser();
        // Not listed, not counted, not opened, not a way through.
        Assert.DoesNotContain(browser.List("dhan", "").Listing!.Entries, e => e.Name == "sneaky");
        Assert.Equal(5L, browser.Roots()[0].Totals.Files);
        Assert.Contains("link", browser.List("dhan", "sneaky").Error);
        Assert.Contains("link", browser.Delete("dhan", "sneaky/precious.csv", "me").Error);
        // Deleting the folder that holds a link removes the link itself - what it points at stays.
        Assert.Null(browser.Delete("dhan", "v1", "me").Error);
        Assert.False(File.Exists(Path.Combine(Dhan, "v1", "sneaky.csv")));
        Assert.True(File.Exists(Path.Combine(Outside, "precious.csv")));
        // Emptying the cache: its own link goes, the folder outside stays whole.
        Assert.Null(browser.Delete("dhan", "", "me").Error);
        Assert.False(Directory.Exists(Path.Combine(Dhan, "sneaky")));
        Assert.True(File.Exists(Path.Combine(Outside, "precious.csv")));
    }

    [Fact]
    public void A_file_a_folder_or_everything_in_a_cache_is_deleted_and_counted()
    {
        var browser = Browser();
        Assert.Equal((5L, 1200L), (browser.Roots()[0].Totals.Files, browser.Roots()[0].Totals.Bytes));
        // A file.
        var one = browser.Delete("dhan", "v1/charts-intraday/days/2026-10/05/2026-10-05-aaa.json.gz", "me").Result!;
        Assert.Equal((1L, 100L, 0), (one.Files, one.Bytes, one.Failed));
        Assert.Equal(1, _afterDhan);                                                                  // counted again
        Assert.Equal(4L, browser.Roots()[0].Totals.Files);                                            // the totals follow at once
        // A folder and all in it - it goes too.
        var month = browser.Delete("dhan", "v1/charts-intraday/days/2026-10", "me").Result!;
        Assert.Equal((2L, 80L), (month.Files, month.Bytes));
        Assert.False(Directory.Exists(Path.Combine(Dhan, "v1/charts-intraday/days/2026-10")));
        Assert.True(Directory.Exists(Path.Combine(Dhan, "v1/charts-intraday/days")));
        // Not there any more.
        Assert.StartsWith("Not found", browser.Delete("dhan", "v1/charts-intraday/days/2026-10", "me").Error);
        // Everything in a cache: its folder stays, empty; the other cache is untouched and told nothing.
        var all = browser.Delete("dhan", "", "me").Result!;
        Assert.Equal((2L, 1020L), (all.Files, all.Bytes));
        Assert.True(Directory.Exists(Dhan));
        Assert.Empty(Directory.EnumerateFileSystemEntries(Dhan));
        Assert.Equal(0, _afterFlow);
        Assert.Equal(3L, browser.Roots()[1].Totals.Files);
        // Order Flow: a day deleted drops its read-back copies.
        browser.Delete("order-flow", "NIFTY/35001/2026-10-05.json.gz", "me");
        Assert.Equal(1, _afterFlow);
    }

    [Fact]
    public void The_endpoints_are_admin_only_and_everything_in_a_cache_needs_all_true()
    {
        Assert.Equal(AuthRoles.Admin, typeof(CacheController).GetCustomAttribute<AuthorizeAttribute>()!.Roles);
        Assert.All(typeof(CacheController).GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly),
            m => Assert.Null(m.GetCustomAttribute<AllowAnonymousAttribute>()));
        var controller = new CacheController(Browser())
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
        };
        // A request that lost its path never empties a cache.
        Assert.IsType<BadRequestObjectResult>(controller.Delete("dhan", null));
        Assert.IsType<BadRequestObjectResult>(controller.Delete("dhan", "  "));
        Assert.Equal(5L, Browser().Roots()[0].Totals.Files);
        Assert.IsType<NotFoundObjectResult>(controller.Delete("dhan", "v9"));
        Assert.IsType<BadRequestObjectResult>(controller.Delete("dhan", "../outside"));
        Assert.IsType<NotFoundObjectResult>(controller.List("nope", ""));
        Assert.IsType<OkObjectResult>(controller.Delete("dhan", null, all: true));
        Assert.Equal(0L, Browser().Roots()[0].Totals.Files);
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { /* best effort */ }
    }
}
