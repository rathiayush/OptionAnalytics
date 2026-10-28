using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Controllers;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Each account's page preferences kept on the server (UserPreferencesStore) - a refresh, a restart / deploy or
/// another browser opens the pages as they were left; they used to live in one browser's localStorage only.</summary>
public sealed class UserPreferencesStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "preferences-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    private UserPreferencesStore Store() => new(_dir, NullLogger<UserPreferencesStore>.Instance);

    private static Dictionary<string, string?> Values(params (string Key, string? Value)[] pairs) => pairs.ToDictionary(p => p.Key, p => p.Value);

    [Fact]
    public void Saved_preferences_come_back_after_a_restart_in_any_browser()
    {
        var store = Store();
        Assert.Equal(0, store.Get("a@x.in").Version);   // nothing saved yet: the browser sends what it has

        var (saved, error) = store.Change("a@x.in", Values(
            ("optionanalytics.oiReplay.gridLayout", "[{\"i\":\"gex\",\"x\":0,\"y\":0,\"w\":6,\"h\":12}]"),
            ("optionanalytics.sideNavCollapsed", "true")));
        Assert.Null(error);
        Assert.Equal(1, saved!.Version);

        var again = Store().Get(" A@X.in ");             // a fresh store (a restart), the same account however it is typed
        Assert.Equal(1, again.Version);
        Assert.Equal("true", again.Values["optionanalytics.sideNavCollapsed"]);
        Assert.Equal("[{\"i\":\"gex\",\"x\":0,\"y\":0,\"w\":6,\"h\":12}]", again.Values["optionanalytics.oiReplay.gridLayout"]);
    }

    [Fact]
    public void A_change_sets_and_removes_keys_and_leaves_the_rest()
    {
        var store = Store();
        store.Change("a@x.in", Values(("optionanalytics.a", "1"), ("optionanalytics.b", "2")));
        var (after, error) = store.Change("a@x.in", Values(("optionanalytics.a", "10"), ("optionanalytics.b", null)));
        Assert.Null(error);
        Assert.Equal(2, after!.Version);
        Assert.Equal(new Dictionary<string, string> { ["optionanalytics.a"] = "10" }, after.Values);
        // The same values again: nothing written, the version stays.
        Assert.Equal(2, store.Change("a@x.in", Values(("optionanalytics.a", "10"))).Result!.Version);
    }

    [Fact]
    public void Accounts_never_see_each_others()
    {
        var store = Store();
        store.Change("a@x.in", Values(("optionanalytics.a", "mine")));
        Assert.Empty(store.Get("b@x.in").Values);
    }

    [Theory]
    [InlineData("other.key")]                       // not a page preference
    [InlineData("optionanalytics.")]                // the prefix alone
    [InlineData("optionanalytics.\nx")]             // control characters
    public void Only_page_preferences_are_kept(string key)
    {
        var (result, error) = Store().Change("a@x.in", Values((key, "1")));
        Assert.Null(result);
        Assert.NotNull(error);
    }

    [Fact]
    public void The_limits_keep_a_runaway_page_from_filling_the_disk()
    {
        var store = Store();
        var tooLongKey = "optionanalytics." + new string('k', UserPreferencesStore.MaxKeyLength);
        Assert.NotNull(store.Change("a@x.in", Values((tooLongKey, "1"))).Error);
        Assert.NotNull(store.Change("a@x.in", Values(("optionanalytics.big", new string('x', UserPreferencesStore.MaxValueBytes + 1)))).Error);

        var many = Enumerable.Range(0, UserPreferencesStore.MaxKeys + 1).ToDictionary(i => $"optionanalytics.k{i}", _ => (string?)"1");
        Assert.NotNull(store.Change("a@x.in", many).Error);
        Assert.Equal(0, store.Get("a@x.in").Version);    // a refused change applies nothing

        var heavy = Enumerable.Range(0, 20).ToDictionary(i => $"optionanalytics.h{i}", _ => (string?)new string('x', UserPreferencesStore.MaxValueBytes - 10));
        Assert.NotNull(store.Change("a@x.in", heavy).Error);   // 20 x 64 KB is over the 1 MB an account keeps
        Assert.NotNull(store.Change("a@x.in", null).Error);
        Assert.NotNull(store.Change("", Values(("optionanalytics.a", "1"))).Error);
    }

    [Fact]
    public void A_damaged_file_reads_as_nothing_saved()
    {
        var store = Store();
        store.Change("a@x.in", Values(("optionanalytics.a", "1")));
        foreach (var file in Directory.EnumerateFiles(_dir, "*.json")) File.WriteAllText(file, "{ not json");
        Assert.Equal(0, Store().Get("a@x.in").Version);
    }

    [Fact]
    public void Only_signed_in_staff_reach_them_and_never_the_external_account()
    {
        var roles = typeof(PreferencesController).GetCustomAttribute<AuthorizeAttribute>()!.Roles!.Split(',');
        Assert.Equal(new[] { AuthRoles.Admin, AuthRoles.User }, roles);
        Assert.False(ExternalAccess.Allows(new PathString("/api/preferences")));
    }
}
