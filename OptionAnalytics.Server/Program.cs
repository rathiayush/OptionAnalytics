using System.Reflection;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Authorization;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Hubs;
using OptionAnalytics.Server.Services;
using OptionAnalytics.Server.Services.Backtesting;
using OptionAnalytics.Server.Telegram;

var builder = WebApplication.CreateBuilder(args);

// Local-only credentials overlay, gitignored (see .gitignore) - not one of ASP.NET Core's
// automatically-loaded file names, so it needs adding explicitly. Lets a real Dhan:ClientId/
// AccessToken pair live on disk for local runs without ever being committed; layered after
// appsettings.{Environment}.json so it wins, and reloads if edited while the app is running.
builder.Configuration.AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: true);

builder.Services.Configure<DhanOptions>(builder.Configuration.GetSection(DhanOptions.SectionName));
builder.Services.Configure<TelegramOptions>(builder.Configuration.GetSection(TelegramOptions.SectionName));
builder.Services.Configure<AuthOptions>(builder.Configuration.GetSection(AuthOptions.SectionName));
builder.Services.AddHttpClient<TelegramAlertService>();

builder.Services.AddSingleton<AuthService>();

// Persists the Data Protection key ring that encrypts/signs the login cookie below to the same
// volume strategy-triggers.json already lives on (see docker-compose.yml). Without this, ASP.NET
// Core generates a fresh, in-memory-only key ring every time the container starts - which silently
// invalidates every outstanding "oa_session" cookie on the very next redeploy, forcing everyone to
// log in again regardless of the 14-day ExpireTimeSpan below. Keeping the key ring on disk is what
// actually makes a login survive a redeploy; the cookie itself was never the problem.
var dataProtectionKeysPath = builder.Configuration["Storage:DataProtectionKeysPath"];
if (string.IsNullOrWhiteSpace(dataProtectionKeysPath))
    dataProtectionKeysPath = Path.Combine(builder.Environment.ContentRootPath, "dataprotection-keys");
Directory.CreateDirectory(dataProtectionKeysPath);
builder.Services.AddDataProtection()
    .SetApplicationName("OptionAnalytics")
    .PersistKeysToFileSystem(new DirectoryInfo(dataProtectionKeysPath));

// Cookie sign-in for the app's two fixed accounts (AuthController/AuthService) - this app has no
// user database, so no need for anything heavier. OnRedirectToLogin/OnRedirectToAccessDenied are
// overridden to plain 401/403 status codes: the framework's own default behaviour for both is a
// 302 redirect to a login PAGE, which is wrong for a pure API + SPA - a fetch() would just follow
// the redirect and read back index.html as if the call had succeeded.
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Cookie.Name = "oa_session";
        options.Cookie.HttpOnly = true;
        options.Cookie.SameSite = SameSiteMode.Lax;
        // SameAsRequest, not Always: Dokploy/Traefik terminates TLS and proxies plain HTTP to this
        // container (see docker-compose.yml - Kestrel binds http://+:8080), and without forwarded-
        // header handling in front of this app, ASP.NET Core has no way to know the ORIGINAL
        // request was HTTPS. CookieSecurePolicy.Always would refuse to set the cookie at all in
        // that case, since it only ever sees a plain HTTP request - silently breaking login in
        // production. SameAsRequest matches whatever scheme the request actually arrived on.
        options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
        options.ExpireTimeSpan = TimeSpan.FromDays(14);
        options.SlidingExpiration = true;
        options.Events.OnRedirectToLogin = context =>
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        };
        options.Events.OnRedirectToAccessDenied = context =>
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return Task.CompletedTask;
        };
    });

// Fallback policy: every endpoint requires SOME signed-in account by default, unless it opts out
// with [AllowAnonymous] (AuthController's own login/logout/me, plus /health and /api/version below
// - both hit by Docker's HEALTHCHECK/redeploy checks with no session at all). AdminOnly is the
// extra bar TriggersController and CdvController's two Contracts-page endpoints add on top - see
// each controller's own doc comment for why those specifically are gated.
builder.Services.AddAuthorization(options =>
{
    options.FallbackPolicy = new AuthorizationPolicyBuilder()
        .RequireAuthenticatedUser()
        .Build();
});

builder.Services.AddSingleton<DhanSession>();
builder.Services.AddHttpClient<DhanApiClient>();
builder.Services.AddHttpClient<DhanSpotInstrumentMaster>();
builder.Services.AddHttpClient<DhanTotpAuthService>();
builder.Services.AddSingleton<DhanHistoricalDataService>();
builder.Services.AddSingleton<DhanMarketFeedClient>();
// AddHttpClient<DhanOptionChainMaster>() (the pattern every other typed client here uses) registers
// it TRANSIENT - a brand new instance, with its own empty in-memory dictionary, for every distinct
// injection site. That is invisible for a stateless client, but DhanOptionChainMaster holds the
// loaded scrip master itself as instance state (_byKey), and only CdvHostedService ever calls
// EnsureLoadedAsync on the copy it was given. StrategyTriggerHostedService's OWN separately-injected
// copy was therefore NEVER loaded - every live order's contract lookup (BuildOrderPlanAsync's
// _optionChainMaster.Find) was reading an empty dictionary for the app's entire lifetime, not
// intermittently: this is the actual cause of "not listed... the master holds 0 contract(s)" on
// every live trigger, always, regardless of what CdvHostedService's own copy (and so the
// dashboard/Contracts page, which reads through it) was showing. Registered as an explicit
// singleton instead, built from IHttpClientFactory so it still gets a pooled, properly-configured
// HttpClient - now there is exactly one shared, actually-loaded instance for every consumer.
builder.Services.AddSingleton<DhanOptionChainMaster>(sp => new DhanOptionChainMaster(
    sp.GetRequiredService<IHttpClientFactory>().CreateClient(nameof(DhanOptionChainMaster)),
    sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<DhanOptions>>(),
    sp.GetRequiredService<ILogger<DhanOptionChainMaster>>()));
// Goes through DhanApiClient like every other REST call, so it needs no HttpClient of its own -
// it only decorates the dashboard's strike picker with live premium/OI (see DhanOptionChainQuotes).
builder.Services.AddSingleton<DhanOptionChainQuotes>();
// Also goes through DhanApiClient, no HttpClient of its own - see DhanSuperOrderClient's own doc
// comment. Registered now as scaffolding; nothing calls it yet until the Strategy Trigger
// integration (quantity/order-type/dry-run design) is settled.
builder.Services.AddSingleton<DhanSuperOrderClient>();
// Same pattern - the account's actual position book, which StrategyTriggerHostedService checks
// before placing a live order so a trigger never doubles up on a contract it already holds.
builder.Services.AddSingleton<DhanPositionsClient>();
// Same pattern again - a PLAIN order (no attached target/stop-loss legs), the one thing a Super
// Order can't do: close an existing position early at a configured square-off time. See
// DhanOrderClient's own doc comment and StrategyTriggerHostedService.SquareOffIfDueAsync.
builder.Services.AddSingleton<DhanOrderClient>();

// No-op when Dhan:Pin/Dhan:TotpSecret aren't set (see DhanTotpAutoRenewalHostedService) - safe to
// always register rather than branching on config here.
builder.Services.AddHostedService<DhanTotpAutoRenewalHostedService>();

// Owns the one shared WS connection's run loop - SpotFeedHostedService and CdvHostedService both
// subscribe/unsubscribe tokens on the same DhanMarketFeedClient singleton rather than each
// opening their own connection.
builder.Services.AddHostedService<DhanMarketFeedHostedService>();

// SpotFeedHostedService is both the hosted background loop AND the read model the REST
// controller queries (its per-underlying candle/price state) - registered as a singleton and
// then handed to AddHostedService so both consumers share the exact same instance.
builder.Services.AddSingleton<SpotFeedHostedService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<SpotFeedHostedService>());

// Same pattern as SpotFeedHostedService - CdvController reads CdvHostedService's per-underlying
// state directly.
builder.Services.AddSingleton<CdvHostedService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<CdvHostedService>());

// No-op (logs at Debug and returns) when Telegram:Enabled/BotToken/ChatId aren't set - see
// TelegramAlertService.
builder.Services.AddHostedService<EmaCrossoverAlertService>();

// Same singleton+hosted pattern as SpotFeedHostedService/CdvHostedService - AlertsController reads
// its recent-alert history directly.
builder.Services.AddSingleton<ConfluenceAlertService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<ConfluenceAlertService>());

// Every registered IBacktestStrategy is picked up automatically by BacktestService's
// IEnumerable<IBacktestStrategy> constructor param - add a new strategy by implementing the
// interface and adding one more AddSingleton line here, nothing else needs to change.
builder.Services.AddSingleton<IBacktestStrategy, FiveEmaStrategy>();
builder.Services.AddSingleton<IBacktestStrategy, FiveEmaV2Strategy>();
builder.Services.AddSingleton<IBacktestStrategy, EmaCrossAtmFlowStrategy>();

// Stateless - reads SpotFeedHostedService/CdvHostedService's in-memory history fresh on every
// request, nothing to run in the background. See BacktestController/BacktestService.
builder.Services.AddSingleton<BacktestService>();

// Saved strategy triggers: the store persists them to a small JSON file (they are configuration,
// not market data - see StrategyTriggerStore), and the hosted service watches each enabled one and
// sends Telegram when its strategy produces a new entry signal.
builder.Services.AddSingleton<StrategyTriggerStore>();
// Every order-pipeline outcome a live trigger produces (placed/filled/failed/cancelled/skipped),
// persisted alongside the trigger itself - see TriggerOrderHistoryStore for why this exists
// separately from the Telegram message that also reports each one.
builder.Services.AddSingleton<TriggerOrderHistoryStore>();
builder.Services.AddHostedService<StrategyTriggerHostedService>();

builder.Services.AddSignalR();
builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

// Dev-only: the Vite dev server runs on its own port and needs cross-origin + credentialed
// access to the SignalR hub. The production build is served from this app's own wwwroot (see
// the static-file fallback below), so no CORS is needed there - relative '/api'/'/hubs' paths
// already resolve to the same origin.
const string DevCorsPolicy = "DevClient";
if (builder.Environment.IsDevelopment())
{
    builder.Services.AddCors(options =>
    {
        options.AddPolicy(DevCorsPolicy, policy => policy
            .WithOrigins("http://localhost:5173", "https://localhost:5173")
            .AllowAnyHeader()
            .AllowAnyMethod()
            .AllowCredentials());
    });
}

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
    app.UseCors(DevCorsPolicy);
}

app.UseDefaultFiles();
app.UseStaticFiles();

app.UseAuthentication();
app.UseAuthorization();

// Container liveness, for Docker's HEALTHCHECK and Dokploy/Traefik. Deliberately says nothing
// about Dhan: the feed is legitimately unauthenticated outside market hours or while a token
// renews, and a container killed for that would never finish starting - the 15-day backfill of ~68
// option contracts alone takes minutes. This answers "is the web app up", nothing more.
// AllowAnonymous: HEALTHCHECK never carries a session cookie, and the authorization fallback
// policy below requires one on every endpoint by default.
app.MapGet("/health", () => Results.Ok(new { status = "ok" })).AllowAnonymous();

// Answers "what am I actually running right now" - the AssemblyMetadata stamp the csproj writes
// fresh on every `dotnet publish` (see its own comment there), read back via reflection. The
// dashboard's own footer surfaces this so a redeploy can be CONFIRMED from the running app itself
// rather than inferred from behavior, which is what repeatedly caused confusion this session: a
// merged fix that looked unapplied because the server simply hadn't been redeployed yet.
app.MapGet("/api/version", () =>
{
    var buildTimeUtc = Assembly.GetExecutingAssembly()
        .GetCustomAttributes<AssemblyMetadataAttribute>()
        .FirstOrDefault(a => a.Key == "BuildTimeUtc")?.Value;
    return Results.Ok(new { buildTimeUtc });
})
    // AllowAnonymous: reveals nothing but a build timestamp, and letting it be curled directly
    // (no session needed) matches /health's own "check this from the outside" purpose.
    .AllowAnonymous();

app.MapControllers();
app.MapHub<SpotHub>("/hubs/spot");
// AllowAnonymous: this is the SPA shell itself, not a piece of app data - React Router paths like
// /backtest or /triggers don't exist as physical files, so a direct visit or refresh on one of them
// falls through to here rather than being served by UseStaticFiles above (which already bypasses
// auth entirely for "/" and every real asset, since it runs before UseAuthentication/
// UseAuthorization and is terminal for a match). Without this, that fallback request hit the
// authorization fallback policy's RequireAuthenticatedUser() and an unauthenticated visitor got a
// bare 401 instead of index.html - a blank page instead of App.jsx's own LoginPage, which is what's
// supposed to handle "not signed in" client-side. The real access control is unaffected: this only
// hands out the empty shell, and every API call the shell then makes is still gated normally.
app.MapFallbackToFile("index.html").AllowAnonymous();

app.Run();
