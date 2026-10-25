// An agent dragged from the dock, read from an OS drag (TIN-396). The dock (a web page, or the
// installed dock) sets one custom type, application/x-apc-agent, carrying { v: 1, agent, hub, ticket }
// and never a secret (packages/web/src/pinning.ts). A browser does not hand a custom type to a native
// app under its own name: Chrome and Edge pack every custom type of a drag into one clipboard format,
// "Chromium Web Custom MIME Data Format", a Chromium pickle. This reads it.
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PulseDesktop;

public sealed record AgentDrag(string Agent, string? Hub, string? Ticket)
{
    public const string Type = "application/x-apc-agent";
    public const string ChromiumCustomFormat = "Chromium Web Custom MIME Data Format";
    /// <summary>The same pickle under the name Chromium gives it on Linux (X11 and Wayland), for TIN-399.</summary>
    public const string ChromiumCustomMime = "chromium/x-web-custom-data";

    static readonly Regex Handle = new(@"^[\w.:-]{1,128}$");
    static readonly Regex HubOrigin = new(@"^https?://[a-z0-9.-]+(:\d{1,5})?$");
    static readonly Regex TicketRe = new(@"^[\w.-]{16,200}$");

    /// <summary>The payload, as the dock's parseAgentDrag reads it: a malformed hub or ticket is dropped, not the drag.</summary>
    public static AgentDrag? Parse(string? text)
    {
        if (string.IsNullOrEmpty(text) || text.Length > 2048) return null;
        try
        {
            using var doc = JsonDocument.Parse(text);
            var o = doc.RootElement;
            if (o.ValueKind != JsonValueKind.Object || !o.TryGetProperty("v", out var v) || v.ValueKind != JsonValueKind.Number || v.GetInt32() != 1) return null;
            if (!o.TryGetProperty("agent", out var a) || a.ValueKind != JsonValueKind.String || !Handle.IsMatch(a.GetString()!)) return null;
            string? hub = o.TryGetProperty("hub", out var h) && h.ValueKind == JsonValueKind.String ? h.GetString() : null;
            string? ticket = o.TryGetProperty("ticket", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
            var paired = hub is not null && hub.Length <= 200 && HubOrigin.IsMatch(hub) && ticket is not null && TicketRe.IsMatch(ticket);
            return new AgentDrag(a.GetString()!, paired ? hub : null, paired ? ticket : null);
        }
        catch (JsonException) { return null; }
        catch (InvalidOperationException) { return null; }
        catch (FormatException) { return null; }
    }

    /// <summary>
    /// Chromium's custom data pickle (ui/base/clipboard/custom_data_helper.cc): a uint32 payload size,
    /// a uint32 count, then per entry two string16 (int32 length in UTF-16 units, the units, padding to
    /// four bytes): the type, then its data. Returns the types and their data, or an empty map.
    /// </summary>
    public static Dictionary<string, string> ReadChromiumCustomData(byte[] bytes)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        try
        {
            var pos = 0;
            int Int()
            {
                if (pos + 4 > bytes.Length) throw new FormatException();
                var v = BitConverter.ToInt32(bytes, pos);
                pos += 4;
                return v;
            }
            string String16()
            {
                var units = Int();
                if (units < 0 || units > 1_000_000 || pos + units * 2 > bytes.Length) throw new FormatException();
                var s = Encoding.Unicode.GetString(bytes, pos, units * 2);
                pos += (units * 2 + 3) & ~3;
                return s;
            }
            var payload = Int();
            if (payload < 0 || payload + 4 > bytes.Length) return map;
            var count = Int();
            if (count < 0 || count > 64) return map;
            for (var i = 0; i < count; i++)
            {
                var type = String16();
                map[type] = String16();
            }
        }
        catch (FormatException) { }
        return map;
    }

    /// <summary>The agent in a drag, from whichever form the source gave it.</summary>
    public static AgentDrag? From(Func<string, object?> get, IEnumerable<string> formats)
    {
        var list = formats.ToList();
        foreach (var f in list)
        {
            if (f == Type && AsText(get(f)) is { } direct && Parse(direct) is { } d1) return d1;
            if ((f == ChromiumCustomFormat || f == ChromiumCustomMime) && get(f) is byte[] pickle && ReadChromiumCustomData(pickle).TryGetValue(Type, out var json) && Parse(json) is { } d2) return d2;
        }
        return null;
    }

    /// <summary>Whether a drag may carry an agent, before it is dropped (the data is read on drop).</summary>
    public static bool MayCarry(IEnumerable<string> formats) => formats.Any(f => f == Type || f == ChromiumCustomFormat || f == ChromiumCustomMime);

    static string? AsText(object? data) => data switch
    {
        string s => s,
        byte[] b => Encoding.UTF8.GetString(b).TrimEnd('\0'),
        _ => null,
    };
}
