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

builder.Services.AddHttpClient<DhanApiClient>();
builder.Services.AddHttpClient<DhanSpotInstrumentMaster>();

builder.Services.AddSingleton<DhanRateLimiter>();
builder.Services.AddSingleton<DhanOptionChainClient>();
builder.Services.AddSingleton<DhanHistoricalDataClient>();
builder.Services.AddSingleton<TimescaleWriter>();

builder.Services.AddHostedService<CollectorHostedService>();

var host = builder.Build();

var dhanOptions = builder.Configuration.GetSection(DhanOptions.SectionName).Get<DhanOptions>() ?? new DhanOptions();
if (!dhanOptions.HasSession)
{
    host.Services.GetRequiredService<ILogger<Program>>().LogError(
        "Dhan:ClientId/Dhan:AccessToken are not configured (see appsettings.Local.json.example) - " +
        "this collector never logs in on its own (see DhanOptions' own doc comment), so it has nothing to do until a token is provided.");
    return;
}

await host.RunAsync();
