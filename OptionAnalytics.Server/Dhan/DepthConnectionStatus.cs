namespace OptionAnalytics.Server.Dhan;

/// <summary>A market depth connection as the Order Flow page reports it: whether the socket is open,
/// when a book last arrived on it, and the last error Dhan gave (a disconnect code, a close, a failed
/// connect) - cleared once books arrive again.</summary>
public sealed record DepthConnectionStatus(bool Connected, DateTimeOffset? LastBookAt, string? LastError)
{
    /// <summary>A connection failure in a line: an HTTP status from the WebSocket handshake (401/403 =
    /// the account is not allowed this feed) or the exception's message.</summary>
    public static string Describe(Exception ex)
    {
        var message = ex is System.Net.WebSockets.WebSocketException { InnerException: { } inner } ? $"{ex.Message} ({inner.Message})" : ex.Message;
        return message.Length > 200 ? message[..200] : message;
    }
}
