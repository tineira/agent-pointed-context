// What Pulse for desktop reads from Pulse's v2 deploy, and the targets it draws. The shapes follow the
// page's (apps/demo/src/web/api.ts) and the figures follow apps/demo/src/model/figures.ts.
using System.Text.Json;

namespace PulseDesktop;

public sealed record Customer(string id, string name, string plan, string region, string signup_month);
public sealed record Activity(string customer_id, string month, bool active, int seats, int events);
public sealed record Dataset(long seed, List<Customer> customers, List<Activity> activity);

public sealed record FocusRow(string grant_id, string kind, string? id, string? part, Dictionary<string, JsonElement>? @params, string pinned_at, string? seen_at)
{
    public bool Seen => seen_at is not null && string.CompareOrdinal(seen_at, pinned_at) >= 0;
}

public sealed record Grant(string id, string label, string? client_name, string? client_icon, string? client_title, string? agent_name, string? owner_name, List<string>? regions, FocusRow? pin)
{
    public string Name => owner_name ?? agent_name ?? client_title ?? client_name ?? label;
}

public sealed record HubLink(string hub, string agent, string grant_id);

public sealed record SandboxState(long seed, List<Grant> grants, bool? v2, List<HubLink>? hub_links);

/// <summary>A target, as the protocol names one (packages/protocol): kind, id, part, params.</summary>
public sealed record Target(string Kind, string? Id, string? Part, SortedDictionary<string, string>? Params)
{
    public static Target Customer(string id) => new("customer", id, null, null);

    public static Target Figure(string key, string month, string? part = null) =>
        new("figure", null, part, new SortedDictionary<string, string>(StringComparer.Ordinal) { ["key"] = key, ["month"] = month });

    /// <summary>One string per target, param order aside: what a pin and a target are compared by.</summary>
    public string Canonical => JsonSerializer.Serialize(new object?[] { Kind, Id, Part, Params });

    public static string CanonicalOf(FocusRow row)
    {
        SortedDictionary<string, string>? p = null;
        if (row.@params is { } raw)
        {
            p = new SortedDictionary<string, string>(StringComparer.Ordinal);
            foreach (var (k, v) in raw) p[k] = v.ValueKind == JsonValueKind.String ? v.GetString()! : v.ToString();
        }
        return new Target(row.kind, row.id, row.part, p).Canonical;
    }

    public object ToJson() => new Dictionary<string, object?> { ["kind"] = Kind, ["id"] = Id, ["part"] = Part, ["params"] = Params };
}

/// <summary>The figures the desktop app draws, computed the way apps/demo/src/model/figures.ts does.</summary>
public static class Figures
{
    public static readonly string[] BridgeSteps = ["start", "new", "reactivated", "churned", "end"];

    public static List<string> Months(Dataset d) => d.activity.Select(a => a.month).Distinct().OrderBy(m => m, StringComparer.Ordinal).ToList();

    public static Dictionary<string, int> Bridge(Dataset d, string month)
    {
        var months = Months(d);
        var i = months.IndexOf(month);
        var prev = i > 0 ? months[i - 1] : null;
        var at = d.activity.ToDictionary(a => (a.customer_id, a.month));
        var counts = BridgeSteps.ToDictionary(s => s, _ => 0);
        foreach (var c in d.customers)
        {
            at.TryGetValue((c.id, prev ?? ""), out var before);
            at.TryGetValue((c.id, month), out var now);
            if (before?.active == true) counts["start"]++;
            if (now?.active == true)
            {
                counts["end"]++;
                if (before is null) counts["new"]++;
                else if (!before.active) counts["reactivated"]++;
            }
            else if (before?.active == true) counts["churned"]++;
        }
        return counts;
    }

    public static List<(string Month, int Active)> ActiveSeries(Dataset d) =>
        Months(d).Select(m => (m, d.activity.Count(a => a.month == m && a.active))).ToList();
}
