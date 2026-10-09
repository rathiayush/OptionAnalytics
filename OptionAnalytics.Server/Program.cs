using Microsoft.AspNetCore.RateLimiting;
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
builder.Services.Configure<HistoricalDataPrefetchOptions>(builder.Configuration.GetSection(HistoricalDataPrefetchOptions.SectionName));
builder.Services.Configure<ExpiredOptionDataPrefetchOptions>(builder.Configuration.GetSection(ExpiredOptionDataPrefetchOptions.SectionName));
builder.Services.Configure<AppEnvironmentOptions>(builder.Configuration.GetSection(AppEnvironmentOptions.SectionName));
builder.Services.AddSingleton<AppEnvironment>();
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
// The server-side scanner (ScannerRunnerHostedService) signs in with its own per-start key instead of a
// cookie: a request carrying the X-Runner-Key header goes to that scheme, everything else to the cookie.
builder.Services.AddSingleton<OptionAnalytics.Server.Auth.ScannerRunnerKey>();
builder.Services.AddAuthentication(options =>
    {
        options.DefaultScheme = "AppAuth";
        options.DefaultChallengeScheme = CookieAuthenticationDefaults.AuthenticationScheme;
    })
    .AddPolicyScheme("AppAuth", "Cookie or the scanner runner's key", options => options.ForwardDefaultSelector = context =>
        context.Request.Headers.ContainsKey(OptionAnalytics.Server.Auth.ScannerRunnerKey.Header)
            ? OptionAnalytics.Server.Auth.ScannerRunnerKey.Scheme
            : CookieAuthenticationDefaults.AuthenticationScheme)
    .AddScheme<Microsoft.AspNetCore.Authentication.AuthenticationSchemeOptions, OptionAnalytics.Server.Auth.ScannerRunnerAuthenticationHandler>(
        OptionAnalytics.Server.Auth.ScannerRunnerKey.Scheme, _ => { })
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

// Login attempts per client IP: 10 per 5 minutes - the admin account places real orders, so its
// password must not be guessable by brute force. A rejected attempt gets 429 (LoginPage shows it).
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy("login", context => System.Threading.RateLimiting.RateLimitPartition.GetFixedWindowLimiter(
        context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new System.Threading.RateLimiting.FixedWindowRateLimiterOptions { PermitLimit = 10, Window = TimeSpan.FromMinutes(5), QueueLimit = 0 }));
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
// AddHttpClient<DhanSpotInstrumentMaster>() (the pattern every other typed client here uses)
// registers it TRANSIENT - the same bug DhanOptionChainMaster had (see that registration's own
// comment below): a brand new instance, with its own empty in-memory list, for every distinct
// injection site. SpotFeedHostedService's own copy loads fine at startup, but
// ExpiredOptionBacktestService's separately-injected copy was NEVER loaded - FindSpot on it
// returns null forever, which is the actual cause of "Could not resolve NIFTY's Dhan security id
// yet" on every single Expired Backtest run, not just an occasional race at startup. Registered as
// an explicit singleton instead, built from IHttpClientFactory so it still gets a pooled, properly-
// configured HttpClient - now there is exactly one shared, actually-loaded instance for every
// consumer.
builder.Services.AddSingleton<DhanSpotInstrumentMaster>(sp => new DhanSpotInstrumentMaster(
    sp.GetRequiredService<IHttpClientFactory>().CreateClient(nameof(DhanSpotInstrumentMaster)),
    sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<DhanOptions>>(),
    sp.GetRequiredService<ILogger<DhanSpotInstrumentMaster>>()));
builder.Services.AddHttpClient<DhanTotpAuthService>();
// Shared across DhanHistoricalDataService and DhanRollingOptionDataService below - see its own
// doc comment for why this must be one singleton rather than one per service (Dhan's Data API
// limit is account-wide, not per-endpoint).
builder.Services.AddSingleton<DhanDataApiRateLimiter>();
builder.Services.AddSingleton<DhanHistoricalDataService>();
builder.Services.AddSingleton<DhanRollingOptionDataService>();
// Reads NiftyDataCollector's own TimescaleDB instead of calling Dhan live - inert (never even
// tries to connect) when ConnectionStrings:NiftyDataCollectorTimescale is blank, which it always
// is in production (see docker-compose.yml, which deliberately does not set it) - see
// StoredRollingOptionDataService's own doc comment.
builder.Services.AddSingleton<StoredRollingOptionDataService>();
// Same idea, for spot instead of the option premium side - see StoredSpotDataService's own doc
// comment for why this needed adding separately (useStoredData previously never reached spot at
// all).
builder.Services.AddSingleton<StoredSpotDataService>();
// Backs the OI Replay page - stored-data-first for spot/options, with a live Dhan fallback outside
// local development, and futures ALWAYS a live Dhan call (see its own doc comment for all three).
builder.Services.AddSingleton<OiReplayService>();
// Backs the Strike Data page's own OI/IV columns - stored-only (NiftyDataCollectorTimescale), no
// live Dhan fallback, and unavailable for SENSEX - see its own doc comment for why.
builder.Services.AddSingleton<StrikeOiIvHistoryService>();
// Same "must be an explicit singleton, not AddHttpClient<T>()'s transient default" reasoning as
// DhanSpotInstrumentMaster/DhanOptionChainMaster just above/below - this also holds the loaded
// scrip master as instance state (_byUnderlying), so a transient registration would give
// OiReplayService its own never-loaded copy.
builder.Services.AddSingleton<DhanFuturesInstrumentMaster>(sp => new DhanFuturesInstrumentMaster(
    sp.GetRequiredService<IHttpClientFactory>().CreateClient(nameof(DhanFuturesInstrumentMaster)),
    sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<DhanOptions>>(),
    sp.GetRequiredService<ILogger<DhanFuturesInstrumentMaster>>()));
// The futures listed on PAST dates, expired ones included (Dhan's scrip master has live contracts only)
// - see NseFuturesContractArchive. A singleton: it caches the parsed NSE files.
builder.Services.AddSingleton(sp => new NseFuturesContractArchive(
    sp.GetRequiredService<IHttpClientFactory>().CreateClient(nameof(NseFuturesContractArchive)),
    sp.GetRequiredService<ILogger<NseFuturesContractArchive>>()));
// An expired futures contract's past day from NSE's chart data (Dhan has no intraday history for
// expired contracts) - see NseChartHistory. Keeps NSE's cookies, like the chart page does.
builder.Services.AddHttpClient(nameof(NseChartHistory))
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
    {
        UseCookies = true,
        CookieContainer = new System.Net.CookieContainer(),
        AutomaticDecompression = System.Net.DecompressionMethods.All,
    });
builder.Services.AddSingleton(sp => new NseChartHistory(
    sp.GetRequiredService<IHttpClientFactory>().CreateClient(nameof(NseChartHistory)),
    sp.GetRequiredService<ILogger<NseChartHistory>>()));
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

// Coalesces per-tick CDV/option/futures pushes into one SignalR send per 300ms - see its doc
// comment. Singleton + hosted, same shared-instance pattern as the services below.
builder.Services.AddSingleton<LiveBroadcastBatcher>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<LiveBroadcastBatcher>());

// SpotFeedHostedService is both the hosted background loop AND the read model the REST
// controller queries (its per-underlying candle/price state) - registered as a singleton and
// then handed to AddHostedService so both consumers share the exact same instance.
builder.Services.AddSingleton<SpotFeedHostedService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<SpotFeedHostedService>());

// Same pattern as SpotFeedHostedService - CdvController reads CdvHostedService's per-underlying
// state directly.
builder.Services.AddSingleton<CdvHostedService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<CdvHostedService>());

// Same singleton+hosted pattern as SpotFeedHostedService/CdvHostedService - AlertsController reads
// its recent-alert history directly.
builder.Services.AddSingleton<ConfluenceAlertService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<ConfluenceAlertService>());

// The on-disk cache HistoricalSpotDataPrefetchHostedService fills once per deployment and
// ExpiredOptionBacktestService reads from afterward - a plain singleton (not hosted itself) since
// both of those consume it directly.
builder.Services.AddSingleton<HistoricalSpotDataStore>();
builder.Services.AddHostedService<HistoricalSpotDataPrefetchHostedService>();

// Same pattern, for the rolling-option (CE/PE premium) side ExpiredOptionBacktestService.
// FetchAcrossSegmentsAsync reads from - see ExpiredOptionDataStore/
// ExpiredOptionDataPrefetchHostedService's own doc comments.
builder.Services.AddSingleton<ExpiredOptionDataStore>();
// The strategy scanner's record as two CSV files - signals.csv and trades.csv, every day in each -
// Storage:ScannerLogPath; see ScannerLogStore.
builder.Services.AddSingleton<ScannerLogStore>();
builder.Services.AddHostedService<ExpiredOptionDataPrefetchHostedService>();

// Every registered IBacktestStrategy is picked up automatically by BacktestService's
// IEnumerable<IBacktestStrategy> constructor param - add a strategy by implementing the
// interface and adding one AddSingleton line here, nothing else needs to change.
builder.Services.AddSingleton<IBacktestStrategy, SrFlowSellStrategy>();
builder.Services.AddSingleton<IBacktestStrategy, EmaCrossoverRetestStrategy>();
builder.Services.AddSingleton<IBacktestStrategy, FiveEmaStrategy>();
builder.Services.AddSingleton<IBacktestStrategy, KathyLienEma20Ema200Strategy>();
builder.Services.AddSingleton<IBacktestStrategy, CdvObvFlowStrategy>();
builder.Services.AddSingleton<IBacktestStrategy, OrbOrderBlockStrategy>();
builder.Services.AddSingleton<IBacktestStrategy, DailyBiasSweepFvgStrategy>();
builder.Services.AddSingleton<IBacktestStrategy, SweepIfvgTrendlineBreakStrategy>();

// Stateless - reads SpotFeedHostedService/CdvHostedService's in-memory history fresh on every
// request, nothing to run in the background. See BacktestController/BacktestService.
builder.Services.AddSingleton<BacktestService>();
builder.Services.AddSingleton<ExpiredOptionBacktestService>();

// Saved strategy triggers: the store persists them to a small JSON file (they are configuration,
// not market data - see StrategyTriggerStore), and the hosted service watches each enabled one and
// sends Telegram when its strategy produces a new entry signal.
builder.Services.AddSingleton<StrategyTriggerStore>();
// Every order-pipeline outcome a live trigger produces (placed/filled/failed/cancelled/skipped),
// persisted alongside the trigger itself - see TriggerOrderHistoryStore for why this exists
// separately from the Telegram message that also reports each one.
builder.Services.AddSingleton<TriggerOrderHistoryStore>();
builder.Services.AddHostedService<StrategyTriggerHostedService>();

// Real-money manual trading from the OI Replay trade panel's Live mode, and the account's live
// positions with event-driven P&L - see LiveTradingService. The order-update socket is what tells it
// a position changed (fill, target/stop-loss hit) without polling Dhan's REST API.
builder.Services.AddSingleton<DhanOrderUpdateFeed>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<DhanOrderUpdateFeed>());
// The live trades the server closes itself at a set time (the scanner's time stop / 15:10), kept on disk.
builder.Services.AddSingleton<LiveTimeExitStore>();
builder.Services.AddSingleton<LiveTradingService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<LiveTradingService>());

// Order flow (footprint, delta, depth heatmap, icebergs) for each underlying's nearest futures - see
// OrderFlowService. DhanDepthFeedClient is Dhan's separate 20-level depth socket.
builder.Services.AddSingleton<DhanDepthFeedClient>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<DhanDepthFeedClient>());
// Dhan's 200-level depth (one socket per instrument) for NIFTY/BANKNIFTY futures, and the last few
// order flow days kept in memory (never on disk) for replay.
builder.Services.AddSingleton<DhanTwoHundredDepthClient>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<DhanTwoHundredDepthClient>());
builder.Services.AddSingleton<OptionAnalytics.Server.Services.OrderFlow.OrderFlowDayStore>();
// TrueData (OFF by default): with TrueData:Enabled true an Order Flow day the server did not record is
// rebuilt from TrueData's tick history; with it false nothing TrueData is registered or called and
// OrderFlowHistory runs exactly as before (its TrueData step is null). See TrueDataOptions.
OptionAnalytics.Server.TrueData.TrueDataRegistration.AddTrueDataIfEnabled(builder.Services, builder.Configuration);
builder.Services.AddSingleton<OptionAnalytics.Server.Services.OrderFlow.OrderFlowHistory>();
builder.Services.AddSingleton<OptionAnalytics.Server.Services.OrderFlow.OrderFlowService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<OptionAnalytics.Server.Services.OrderFlow.OrderFlowService>());

// Keeps OI Replay's own "today, live" mode genuinely live over the same shared Dhan WS feed -
// see OiReplayLiveFeedService's own doc comment.
// Price falls / rises for 3 minutes while the nearest strike's OI does not give way -> Telegram + a
// notification on the OI Replay page, with or without a browser open. See OiDivergenceMonitor.
builder.Services.AddSingleton<OiDivergenceMonitor>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<OiDivergenceMonitor>());
builder.Services.AddHostedService<OiReplayLiveFeedService>();

// The strategy scanner run on the server for NIFTY, BANKNIFTY and SENSEX (alerts + paper trades), with or
// without a browser open - a Node process started and watched here. See ScannerRunnerHostedService.
builder.Services.AddSingleton<ScannerRunnerStore>();
// Lots, SL / target / trail, slippage, server scanner on/off per index - trade-settings.csv (TradeSettingsStore).
builder.Services.AddSingleton<TradeSettingsStore>();
// The daily loss limit (default ₹20,000) - Dhan's P&L based exit set every day, plus a watch here that exits
// everything and turns Dhan's kill switch on at the limit (KillSwitchService; risk-settings.csv).
builder.Services.AddSingleton<RiskSettingsStore>();
// GoCharting's per-bar order flow, posted by a Lipi alert's webhook (GoChartingStore / GoChartingController).
builder.Services.AddSingleton<GoChartingStore>();
// The strategy tuning job (scanner-runner/tune.mjs) - StrategyTuningService / StrategyTuningController.
builder.Services.AddSingleton<StrategyTuningService>();
builder.Services.AddSingleton<DhanTradersControlClient>();
builder.Services.AddSingleton<KillSwitchService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<KillSwitchService>());
builder.Services.AddHostedService<ScannerRunnerHostedService>();

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
app.UseRateLimiter();

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
