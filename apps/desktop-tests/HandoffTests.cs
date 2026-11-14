using Avalonia.Controls;
using PulseDesktop;
using Xunit;

public class HandoffTests
{
    static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-11-14T10:00:00.000Z");
    static DockPairing Pairing(int secondsAhead) => new("K7M4P2", Now.AddSeconds(secondsAhead).ToString("o"));

    [Fact]
    public void Shows_the_code_formatted_with_the_time_left()
    {
        var v = Handoff.View("apc.tineira.com", Pairing(100), Now);
        Assert.Equal(HandoffPhase.Code, v.Phase);
        Assert.Equal("K7M-4P2", v.Code);
        Assert.Equal(100, v.Left);
        Assert.Equal("1:40", v.Clock);
        Assert.Contains("apc.tineira.com", v.Title);
        Assert.Contains(v.Lines, l => l.Contains("never give it to anyone"));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(900)]
    public void At_and_past_the_stored_expiry_the_countdown_stays_at_zero_and_the_code_goes(int secondsPast)
    {
        var v = Handoff.View("dock.test", Pairing(100), Now.AddSeconds(100 + secondsPast));
        Assert.Equal(HandoffPhase.Expired, v.Phase);
        Assert.Null(v.Code);
        Assert.Equal(0, v.Left);
        Assert.Equal("0:00", v.Clock);
        Assert.Contains(v.Lines, l => l.Contains("no longer works"));
        Assert.Contains(v.Lines, l => l.Contains("Drag the agent from the dock again"));
        Assert.DoesNotContain(v.Lines.Append(v.Title), s => s.Contains("K7M"));
    }

    [Fact]
    public void An_expiry_that_cannot_be_read_counts_as_passed()
    {
        var v = Handoff.View("dock.test", new DockPairing("K7M4P2", "not a time"), Now);
        Assert.Equal(HandoffPhase.Expired, v.Phase);
        Assert.Null(v.Code);
    }

    [Fact]
    public void With_no_pairing_the_dock_took_the_code_and_is_connecting()
    {
        var v = Handoff.View("dock.test", null, Now);
        Assert.Equal(HandoffPhase.Connecting, v.Phase);
        Assert.Null(v.Code);
    }

    [Theory]
    [InlineData(120, "2:00")]
    [InlineData(61, "1:01")]
    [InlineData(9, "0:09")]
    [InlineData(-5, "0:00")]
    public void Clock_is_minutes_and_seconds(int seconds, string expected) => Assert.Equal(expected, Handoff.Clock(seconds));

    [Fact]
    public void A_tick_updates_the_card_in_place_and_never_rebuilds_its_controls()
    {
        var card = new HandoffCard("g_1", _ => Task.CompletedTask);
        var cancel = card.Cancel;
        var panel = Assert.IsType<StackPanel>(card.Root.Child);
        card.Update(Handoff.View("dock.test", Pairing(100), Now), Now);
        var before = panel.Children.ToArray();
        // Each second, and through the expiry: the same controls (a Tab stop or a held click survives), and the code goes at zero.
        for (var t = 1; t <= 101; t++)
        {
            var at = Now.AddSeconds(t);
            card.Update(Handoff.View("dock.test", Pairing(100), at), at);
            Assert.Equal(before, panel.Children.ToArray());
            Assert.Same(cancel, card.Cancel);
        }
    }
}
