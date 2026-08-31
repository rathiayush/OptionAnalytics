using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Hubs;
using OptionAnalytics.Server.Services;
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

app.MapControllers();
app.MapHub<SpotHub>("/hubs/spot");
app.MapFallbackToFile("index.html");

app.Run();
