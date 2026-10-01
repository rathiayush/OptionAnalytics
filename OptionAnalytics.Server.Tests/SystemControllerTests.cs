using OptionAnalytics.Server.Controllers;

namespace OptionAnalytics.Server.Tests;

/// <summary>SystemController.LoginsSurvivedRestart - the header's "logins reset at the last deploy"
/// warning. A key ring older than the server process was loaded from storage; one created after it
/// was generated at this start, invalidating every earlier login.</summary>
public sealed class SystemControllerTests
{
    private static readonly DateTimeOffset Started = new(2026, 10, 1, 4, 0, 0, TimeSpan.Zero);

    [Fact]
    public void KeyRingFromBeforeTheRestartMeansLoginsSurvived() =>
        Assert.True(SystemController.LoginsSurvivedRestart(Started.AddDays(-20), Started));

    [Fact]
    public void KeyRingGeneratedAfterStartMeansLoginsWereReset() =>
        Assert.False(SystemController.LoginsSurvivedRestart(Started.AddSeconds(40), Started));

    [Fact]
    public void KeyCreatedWithinTheClockSlackOfStartCountsAsReset() =>
        Assert.False(SystemController.LoginsSurvivedRestart(Started.AddSeconds(-30), Started));

    [Fact]
    public void NoKeysYetIsUnknown() =>
        Assert.Null(SystemController.LoginsSurvivedRestart(null, Started));
}
