using PulseDesktop;
using Xunit;

public class HubPairTests
{
    [Theory]
    [InlineData("connect_requested")]
    [InlineData("native_first_pairing_unsupported")]
    public void First_pairing_status_explains_the_native_deferral(string status)
    {
        var result = new HubPairResult(true, null, null, status, null, null, null, null);
        Assert.Contains("can't make a first pairing yet", result.FirstPairingMessage);
        Assert.Contains("pulse.apc.tineira.com", result.FirstPairingMessage);
        Assert.Contains("agents already paired here keep working", result.FirstPairingMessage);
    }

    [Theory]
    [InlineData("paired")]
    [InlineData("pending")]
    [InlineData("connecting")]
    public void Existing_pairing_status_does_not_show_the_first_pairing_message(string status)
    {
        Assert.Null(new HubPairResult(true, null, "grant", status, null, null, null, null).FirstPairingMessage);
    }
}
