using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Hubs;
using OptionAnalytics.Server.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.Configure<DhanOptions>(builder.Configuration.GetSection(DhanOptions.SectionName));

builder.Services.AddSingleton<DhanSession>();
builder.Services.AddHttpClient<DhanApiClient>();
builder.Services.AddHttpClient<DhanSpotInstrumentMaster>();
builder.Services.AddSingleton<DhanHistoricalDataService>();
builder.Services.AddSingleton<DhanMarketFeedClient>();

// SpotFeedHostedService is both the hosted background loop AND the read model the REST
// controller queries (its per-underlying candle/price state) - registered as a singleton and
// then handed to AddHostedService so both consumers share the exact same instance.
builder.Services.AddSingleton<SpotFeedHostedService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<SpotFeedHostedService>());

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
