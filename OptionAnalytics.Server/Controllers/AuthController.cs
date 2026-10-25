using Microsoft.AspNetCore.RateLimiting;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Services.Visitors;

namespace OptionAnalytics.Server.Controllers;

/// <summary>Cookie sign-in for the app's two fixed accounts (AuthOptions/AuthService) - login/
/// logout/"who am I". [AllowAnonymous] on the whole controller since Program.cs's authorization
/// fallback policy requires an authenticated user EVERYWHERE by default; Login has to be reachable
/// before anyone is signed in, and Me/Logout both handle "not currently signed in" as a normal,
/// harmless case rather than needing the framework to block the request first.</summary>
[ApiController]
[Route("api/auth")]
[AllowAnonymous]
public sealed class AuthController : ControllerBase
{
    private readonly AuthService _auth;
    private readonly ILogger<AuthController> _logger;
    private readonly VisitRecorder? _visits;

    public AuthController(AuthService auth, ILogger<AuthController> logger, VisitRecorder? visits = null)
    {
        _auth = auth;
        _logger = logger;
        _visits = visits;
    }

    public sealed record LoginRequest(string? Email, string? Password);

    [HttpPost("login")]
    [EnableRateLimiting("login")]
    public async Task<IActionResult> Login([FromBody] LoginRequest request)
    {
        var role = _auth.TryAuthenticate(request.Email, request.Password);
        if (role is null)
        {
            // Never says which of email/password was wrong - see AuthService's own doc comment.
            _logger.LogWarning("Failed login attempt for {Email}.", request.Email);
            _visits?.Record(HttpContext, "login-failed", account: VisitorLog.CleanTyped(request.Email));
            return Unauthorized(new { error = "Invalid email or password." });
        }

        var email = request.Email!.Trim();
        var identity = new ClaimsIdentity(
            new[] { new Claim(ClaimTypes.Name, email), new Claim(ClaimTypes.Role, role) },
            CookieAuthenticationDefaults.AuthenticationScheme);

        // IsPersistent: survives closing the browser (within CookieAuthenticationOptions.
        // ExpireTimeSpan/SlidingExpiration - see Program.cs) rather than only for this tab session,
        // since re-entering a password every time the browser restarts is friction with no real
        // security upside for a personal trading tool with exactly two accounts.
        await HttpContext.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, new ClaimsPrincipal(identity),
            new AuthenticationProperties { IsPersistent = true });

        _logger.LogInformation("{Email} logged in as {Role}.", email, role);
        _visits?.Record(HttpContext, "login", account: email, role: role);
        return Ok(new { email, role });
    }

    [HttpPost("logout")]
    public async Task<IActionResult> Logout()
    {
        if (User.Identity?.IsAuthenticated == true) _visits?.Record(HttpContext, "logout");
        await HttpContext.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
        return Ok();
    }

    public sealed record VisitRequest(string? Page, string? Visitor);

    /// <summary>POST /api/auth/visit - the page a browser is on (every account, and visitors not signed in - the
    /// login screen too), for the admin Visitors page (VisitorLog). Only the page path and the browser's random
    /// visitor id are taken from the body; the place comes from the connection and the address is not kept.</summary>
    [HttpPost("visit")]
    [EnableRateLimiting("visit")]
    public IActionResult Visit([FromBody] VisitRequest? request)
    {
        var page = VisitorLog.CleanPage(request?.Page);
        if (page is not null) _visits?.Record(HttpContext, "page", page, VisitorLog.CleanVisitor(request?.Visitor));
        return NoContent();
    }

    [HttpGet("me")]
    public IActionResult Me()
    {
        if (User.Identity?.IsAuthenticated != true) return Unauthorized();
        return Ok(new { email = User.Identity.Name, role = User.FindFirstValue(ClaimTypes.Role) });
    }
}
