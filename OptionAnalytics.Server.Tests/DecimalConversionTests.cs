using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>.NET 11 keeps a double / float's exact binary value in (decimal)x - the app keeps the .NET 8 numbers.</summary>
public class DecimalConversionTests
{
    [Theory]
    [InlineData(12.34, "12.34")]
    [InlineData(0.1, "0.1")]
    [InlineData(25010.55, "25010.55")]
    [InlineData(1e-7, "0.0000001")]
    [InlineData(-98.05, "-98.05")]
    public void A_double_keeps_the_digits_it_was_written_with(double value, string expected) =>
        Assert.Equal(decimal.Parse(expected, System.Globalization.CultureInfo.InvariantCulture), DecimalConversion.FromDouble(value));

    [Fact]
    public void A_float_price_keeps_its_seven_digits() =>
        Assert.Equal(25010.55m, DecimalConversion.FromSingle(25010.55f));

    [Fact]
    public void A_feed_price_is_read_without_the_binary_tail()
    {
        var bytes = new byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteSingleLittleEndian(bytes, 24999.95f);
        Assert.Equal(24999.95m, DecimalConversion.FromSingle(System.Buffers.Binary.BinaryPrimitives.ReadSingleLittleEndian(bytes)));
    }
}
