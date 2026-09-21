using NiftyDataCollector.Collection;
using NiftyDataCollector.Db;
using NiftyDataCollector.Dhan;

var builder = Host.CreateApplicationBuilder(args);

// appsettings.Local.json (gitignored, same convention as OptionAnalytics.Server's own
// appsettings.Local.json) is where real Dhan credentials and the Postgres connection string
// belong - never committed.
builder.Configuration.AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: true);

builder.Services.Configure<DhanOptions>(builder.Configuration.GetSection(DhanOptions.SectionName));
builder.Services.Configure<CollectorOptions>(builder.Configuration.GetSection(CollectorOptions.SectionName));
builder.Services.Configure<RollingOptionOptions>(builder.Configuration.GetSection(RollingOptionOptions.SectionName));

builder.Services.AddSingleton<DhanSession>();

builder.Services.AddHttpClient<DhanApiClient>();
builder.Services.AddHttpClient<DhanSpotInstrumentMaster>();
builder.Services.AddHttpClient<DhanTotpAuthService>();

builder.Services.AddSingleton<DhanRateLimiter>();
builder.Services.AddSingleton<DhanOptionChainClient>();
builder.Services.AddSingleton<DhanHistoricalDataClient>();
builder.Services.AddSingleton<DhanRollingOptionClient>();
builder.Services.AddSingleton<TimescaleWriter>();

// No-op at startup when Dhan:Pin/Dhan:TotpSecret aren't set - see DhanTotpAutoRenewalHostedService's
// own doc comment. Registered before CollectorHostedService so TOTP login has a head start, though
// CollectorHostedService's own per-cycle error handling tolerates a not-yet-authenticated first
// cycle fine either way (it just logs and retries next cycle).
builder.Services.AddHostedService<DhanTotpAutoRenewalHostedService>();
builder.Services.AddHostedService<CollectorHostedService>();

// No-op at startup unless RollingOption:Enabled is true - see its own doc comment and the README
// for what turning this on involves (potentially thousands of Dhan API calls for a wide date range).
builder.Services.AddHostedService<RollingOptionBackfillHostedService>();

var host = builder.Build();

var dhanOptions = builder.Configuration.GetSection(DhanOptions.SectionName).Get<DhanOptions>() ?? new DhanOptions();
if (string.IsNullOrWhiteSpace(dhanOptions.ClientId) || (string.IsNullOrWhiteSpace(dhanOptions.AccessToken) && !dhanOptions.HasTotpCredentials))
{
    host.Services.GetRequiredService<ILogger<Program>>().LogError(
        "Dhan:ClientId is required, plus either Dhan:AccessToken (static token) or Dhan:Pin+Dhan:TotpSecret " +
        "(TOTP auto-login) - see appsettings.Local.json.example. Nothing is configured yet, so this collector has nothing to do.");
    return;
}

await host.RunAsync();
