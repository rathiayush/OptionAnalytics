using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Auth;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers AuthService.TryAuthenticate - the only decision AuthController relies on for
/// whether to sign someone in and as which role.</summary>
public sealed class AuthServiceTests
{
    private static AuthService Service(string adminPassword = "adminpass", string userPassword = "userpass") =>
        new(Options.Create(new AuthOptions
        {
            AdminEmail = "admin@backtest.com",
            AdminPassword = adminPassword,
            UserEmail = "user@backtest.com",
            UserPassword = userPassword,
        }));

    [Fact]
    public void TryAuthenticate_CorrectAdminCredentials_ReturnsAdminRole()
    {
        var role = Service().TryAuthenticate("admin@backtest.com", "adminpass");

        Assert.Equal(AuthRoles.Admin, role);
    }

    [Fact]
    public void TryAuthenticate_CorrectUserCredentials_ReturnsUserRole()
    {
        var role = Service().TryAuthenticate("user@backtest.com", "userpass");

        Assert.Equal(AuthRoles.User, role);
    }

    [Fact]
    public void TryAuthenticate_EmailIsCaseInsensitive()
    {
        var role = Service().TryAuthenticate("ADMIN@BackTest.com", "adminpass");

        Assert.Equal(AuthRoles.Admin, role);
    }

    [Fact]
    public void TryAuthenticate_WrongPassword_ReturnsNull()
    {
        var role = Service().TryAuthenticate("admin@backtest.com", "wrong");

        Assert.Null(role);
    }

    [Fact]
    public void TryAuthenticate_UnknownEmail_ReturnsNull()
    {
        var role = Service().TryAuthenticate("nobody@backtest.com", "adminpass");

        Assert.Null(role);
    }

    [Fact]
    public void TryAuthenticate_BlankConfiguredPassword_NeverMatchesEvenABlankSubmission()
    {
        // The default before Auth__AdminPassword/Auth__UserPassword are actually set - a fresh
        // deploy must fail closed, not silently accept an empty password as valid.
        var role = Service(adminPassword: "").TryAuthenticate("admin@backtest.com", "");

        Assert.Null(role);
    }

    [Fact]
    public void TryAuthenticate_EmptySubmittedCredentials_ReturnsNull()
    {
        Assert.Null(Service().TryAuthenticate("", ""));
        Assert.Null(Service().TryAuthenticate(null, null));
    }
}
