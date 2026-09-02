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
builder.Services.AddHttpClient<TelegramAlertService>();

builder.Services.AddSingleton<DhanSession>();
builder.Services.AddHttpClient<DhanApiClient>();
builder.Services.AddHttpClient<DhanSpotInstrumentMaster>();
builder.Services.AddHttpClient<DhanTotpAuthService>();
builder.Services.AddSingleton<DhanHistoricalDataService>();
builder.Services.AddSingleton<DhanMarketFeedClient>();
builder.Services.AddHttpClient<DhanOptionChainMaster>();
// Goes through DhanApiClient like every other REST call, so it needs no HttpClient of its own -
// it only decorates the dashboard's strike picker with live premium/OI (see DhanOptionChainQuotes).
builder.Services.AddSingleton<DhanOptionChainQuotes>();
// Also goes through DhanApiClient, no HttpClient of its own - see DhanSuperOrderClient's own doc
// comment. Registered now as scaffolding; nothing calls it yet until the Strategy Trigger
// integration (quantity/order-type/dry-run design) is settled.
builder.Services.AddSingleton<DhanSuperOrderClient>();

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
builder.Services.AddSingleton<IBacktestStrategy, OtmConfluenceStrategy>();
builder.Services.AddSingleton<IBacktestStrategy, EmaSurgeStrategy>();
builder.Services.AddSingleton<IBacktestStrategy, FiveEmaStrategy>();
builder.Services.AddSingleton<IBacktestStrategy, FiveEmaV2Strategy>();

// Stateless - reads SpotFeedHostedService/CdvHostedService's in-memory history fresh on every
// request, nothing to run in the background. See BacktestController/BacktestService.
builder.Services.AddSingleton<BacktestService>();

// Saved strategy triggers: the store persists them to a small JSON file (they are configuration,
// not market data - see StrategyTriggerStore), and the hosted service watches each enabled one and
// sends Telegram when its strategy produces a new entry signal.
builder.Services.AddSingleton<StrategyTriggerStore>();
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

app.UseAuthorization();

// Container liveness, for Docker's HEALTHCHECK and Dokploy/Traefik. Deliberately says nothing
// about Dhan: the feed is legitimately unauthenticated outside market hours or while a token
// renews, and a container killed for that would never finish starting - the 15-day backfill of ~68
// option contracts alone takes minutes. This answers "is the web app up", nothing more.
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

app.MapControllers();
app.MapHub<SpotHub>("/hubs/spot");
app.MapFallbackToFile("index.html");

app.Run();
