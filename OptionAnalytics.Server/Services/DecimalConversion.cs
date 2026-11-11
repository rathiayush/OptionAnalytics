using System.Globalization;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// double / float to decimal the way .NET 8 did it. Since .NET 11 a plain <c>(decimal)aDouble</c> keeps the
/// binary value EXACTLY (12.34 becomes 12.339999999999999857891452848, a float price 25010.55 becomes
/// 25010.55078125); .NET 8 rounded to 15 significant digits for a double and 7 for a float. Every price, IV and
/// indicator value that reaches a decimal from a binary float goes through here, so the app keeps the numbers
/// it always had (OptionAnalytics.Server.Tests/DecimalConversionTests.cs).
/// </summary>
public static class DecimalConversion
{
    public static decimal FromDouble(double value) =>
        decimal.Parse(value.ToString("G15", CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture);

    public static decimal FromSingle(float value) =>
        decimal.Parse(value.ToString("G7", CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture);
}
