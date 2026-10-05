using Microsoft.Extensions.Options;
using TrueData_DotNet;

namespace OptionAnalytics.Server.TrueData;

/// <summary>TrueData's tick history for one symbol and time window, as the CSV their REST API returns
/// (a header row, then time,ltp,volume,oi,bid,bid_qty,ask,ask_qty). An interface so the day builder can
/// be tested without the network.</summary>
public interface ITrueDataHistoryApi
{
    /// <param name="fromIst">Window start, IST wall-clock time.</param>
    /// <param name="toIst">Window end, IST wall-clock time.</param>
    Task<string> GetTicksWithBidAskAsync(string symbol, DateTime fromIst, DateTime toIst, CancellationToken cancellationToken);
}

/// <summary>
/// ITrueDataHistoryApi over TrueData's official SDK (TrueData-DotNet, TDHistory): login() for a bearer
/// token, then GetTickHistory(symbol, bidask: true, from, to) - GET history.truedata.in/getticks with the
/// compressed payload the SDK unpacks. The SDK is synchronous and keeps one token, so calls are made one
/// at a time on the thread pool; a failed or empty-handed call logs in again once and retries.
/// Only created when TrueData:Enabled is true (see Program.cs).
/// </summary>
public sealed class TrueDataSdkHistoryApi : ITrueDataHistoryApi
{
    private readonly TrueDataOptions _options;
    private readonly ILogger<TrueDataSdkHistoryApi> _logger;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private TDHistory? _history;
    private DateTimeOffset _loggedInAt;
    private static readonly TimeSpan Relogin = TimeSpan.FromHours(6);

    public TrueDataSdkHistoryApi(IOptions<TrueDataOptions> options, ILogger<TrueDataSdkHistoryApi> logger)
    {
        _options = options.Value;
        _logger = logger;
    }

    public async Task<string> GetTicksWithBidAskAsync(string symbol, DateTime fromIst, DateTime toIst, CancellationToken cancellationToken)
    {
        if (!_options.IsConfigured) throw new InvalidOperationException("TrueData is not enabled or has no credentials (TrueData:Enabled / UserId / Password)");
        await _gate.WaitAsync(cancellationToken);
        try
        {
            for (var attempt = 1; attempt <= 2; attempt++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var history = await LoggedInAsync(force: attempt > 1, cancellationToken);
                string csv;
                try
                {
                    csv = await Task.Run(() => history.GetTickHistory(symbol, true, fromIst, toIst, true, true), cancellationToken) ?? "";
                }
                catch (Exception ex) when (attempt == 1 && ex is not OperationCanceledException)
                {
                    _logger.LogWarning(ex, "TrueData tick history for {Symbol} failed - logging in again.", symbol);
                    continue;
                }
                // An expired token comes back as an error text, not a CSV header - log in again once.
                if (attempt == 1 && LooksUnauthorized(csv)) continue;
                return csv;
            }
            return "";
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<TDHistory> LoggedInAsync(bool force, CancellationToken cancellationToken)
    {
        if (_history is not null && !force && DateTimeOffset.UtcNow - _loggedInAt < Relogin) return _history;
        var history = new TDHistory(_options.UserId, _options.Password, _options.AuthUrl, _options.HistoryUrl);
        var ok = await Task.Run(history.login, cancellationToken);
        if (!ok) throw new InvalidOperationException("TrueData login failed - check TrueData:UserId / Password and that the API subscription (with history) is active");
        _history = history;
        _loggedInAt = DateTimeOffset.UtcNow;
        _logger.LogInformation("Logged in to TrueData history.");
        return history;
    }

    internal static bool LooksUnauthorized(string text) =>
        text.Contains("unauthori", StringComparison.OrdinalIgnoreCase) || text.Contains("invalid token", StringComparison.OrdinalIgnoreCase)
        || text.Contains("401", StringComparison.Ordinal) && !text.Contains(',');
}
