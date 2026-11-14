// What the handoff card says (APC 0.10 section 4, TIN-893, TIN-901): the same words and numbers as the web card
// (`handoffView` in packages/web/src/handoff-card.ts). Pure, so it is tested (apps/desktop-tests).
using System.Globalization;

namespace PulseDesktop;

public enum HandoffPhase { Code, Connecting, Expired }

/// <summary>What the card shows now. `Code` is set only in the Code phase: past the stored expiry it is never shown.</summary>
public sealed record HandoffView(HandoffPhase Phase, string Title, string? Code, int Left, string Clock, string[] Lines);

public static class Handoff
{
    /// <summary>Seconds as m:ss; below zero is zero.</summary>
    public static string Clock(int seconds)
    {
        var s = Math.Max(0, seconds);
        return $"{s / 60}:{s % 60:00}";
    }

    /// <summary>Seconds until Pulse's stored expiry, never below zero. An expiry that cannot be read is as good as passed.</summary>
    public static int SecondsLeft(DockPairing pairing, DateTimeOffset now) =>
        DateTimeOffset.TryParse(pairing.expires_at, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var until)
            ? Math.Max(0, (int)Math.Ceiling((until - now).TotalSeconds))
            : 0;

    /// <summary>
    /// The card for a dock grant in handoff. Pulse's stored expiry is the truth: the countdown stops at zero and the code
    /// goes, with a note that the dock did not finish in time. No pairing means the dock took the code and is connecting.
    /// There is no "new code": a new code needs a new consent, so the person drags the agent again.
    /// </summary>
    public static HandoffView View(string host, DockPairing? pairing, DateTimeOffset now)
    {
        if (pairing is null)
            return new HandoffView(HandoffPhase.Connecting, $"Your dock at {host} is connecting", null, 0, Clock(0),
                ["Your dock took the code. If you didn't type a code there, the agent wasn't yours: Cancel."]);
        var left = SecondsLeft(pairing, now);
        if (left <= 0)
            return new HandoffView(HandoffPhase.Expired, "The pairing did not finish", null, 0, Clock(0),
                [$"The code ran out before your dock at {host} finished, so it no longer works.", "Drag the agent from the dock again."]);
        return new HandoffView(HandoffPhase.Code, $"Type this code in your dock at {host}", PairingCodes.FormatCode(pairing.code), left, Clock(left),
            ["Type it only in your own dock; never give it to anyone. Whoever types it gets this access.", "If your dock doesn't ask for this code, the agent wasn't yours: Cancel."]);
    }
}
