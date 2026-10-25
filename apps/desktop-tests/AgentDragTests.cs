using System.Text;
using PulseDesktop;
using Xunit;

public class AgentDragTests
{
    /// <summary>A drag's custom types packed the way Chromium packs them for the OS (custom_data_helper.cc).</summary>
    static byte[] Pickle(params (string Type, string Data)[] entries)
    {
        var body = new List<byte>();
        void Int(int v) => body.AddRange(BitConverter.GetBytes(v));
        void String16(string s)
        {
            Int(s.Length);
            body.AddRange(Encoding.Unicode.GetBytes(s));
            while (body.Count % 4 != 0) body.Add(0);
        }
        Int(entries.Length);
        foreach (var (t, d) in entries)
        {
            String16(t);
            String16(d);
        }
        return [.. BitConverter.GetBytes(body.Count), .. body];
    }

    const string Payload = "{\"v\":1,\"agent\":\"ag_1a2b3c4d\",\"hub\":\"https://v2.apc.tineira.com\",\"ticket\":\"0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef\"}";

    [Fact]
    public void Reads_the_agent_out_of_Chromiums_custom_data()
    {
        var bytes = Pickle(("text/x-other", "x"), (AgentDrag.Type, Payload));
        Assert.Equal(Payload, AgentDrag.ReadChromiumCustomData(bytes)[AgentDrag.Type]);
        var drag = AgentDrag.From(f => f == AgentDrag.ChromiumCustomFormat ? bytes : null, ["Text", AgentDrag.ChromiumCustomFormat]);
        Assert.Equal(new AgentDrag("ag_1a2b3c4d", "https://v2.apc.tineira.com", "0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef"), drag);
    }

    /// <summary>
    /// What a real Chromium (Playwright's, headed under Xvfb) wrote for a copy that set the dock's payload under
    /// application/x-apc-agent and text/x-other as "x": its "chromium/x-web-custom-data" clipboard entry, the
    /// pickle Chrome also puts in a Windows drag as "Chromium Web Custom MIME Data Format". Captured with xclip.
    /// </summary>
    const string RealChromiumPickle = "fAEAAAIAAAAXAAAAYQBwAHAAbABpAGMAYQB0AGkAbwBuAC8AeAAtAGEAcABjAC0AYQBnAGUAbgB0AAAAjQAAAHsAIgB2ACIAOgAxACwAIgBhAGcAZQBuAHQAIgA6ACIAYQBnAF8AMQBhADIAYgAzAGMANABkACIALAAiAGgAdQBiACIAOgAiAGgAdAB0AHAAcwA6AC8ALwB2ADIALgBhAHAAYwAuAHQAaQBuAGUAaQByAGEALgBjAG8AbQAiACwAIgB0AGkAYwBrAGUAdAAiADoAIgAwADEAMgAzADQANQA2ADcAOAA5AGEAYgBjAGQAZQBmADAAMQAyADMANAA1ADYANwA4ADkAYQBiAGMAZABlAGYALgAwADEAMgAzADQANQA2ADcAOAA5AGEAYgBjAGQAZQBmADAAMQAyADMANAA1ADYANwA4ADkAYQBiAGMAZABlAGYAIgB9AAAADAAAAHQAZQB4AHQALwB4AC0AbwB0AGgAZQByAAEAAAB4AAAA";

    [Fact]
    public void Reads_a_pickle_a_real_Chromium_wrote()
    {
        var map = AgentDrag.ReadChromiumCustomData(Convert.FromBase64String(RealChromiumPickle));
        Assert.Equal(Payload, map[AgentDrag.Type]);
        Assert.Equal("x", map["text/x-other"]);
    }

    [Fact]
    public void Odd_lengths_are_padded_to_four_bytes()
    {
        var bytes = Pickle(("a", "b"), (AgentDrag.Type, "{\"v\":1,\"agent\":\"g_1\"}"));
        Assert.Equal("{\"v\":1,\"agent\":\"g_1\"}", AgentDrag.ReadChromiumCustomData(bytes)[AgentDrag.Type]);
    }

    [Fact]
    public void Junk_and_truncated_data_read_as_nothing()
    {
        Assert.Empty(AgentDrag.ReadChromiumCustomData([]));
        Assert.Empty(AgentDrag.ReadChromiumCustomData([1, 2, 3]));
        var cut = Pickle((AgentDrag.Type, Payload))[..20];
        Assert.False(AgentDrag.ReadChromiumCustomData(cut).ContainsKey(AgentDrag.Type));
    }

    [Fact]
    public void The_payload_is_read_as_the_dock_reads_it()
    {
        Assert.Null(AgentDrag.Parse("g_1"));
        Assert.Null(AgentDrag.Parse("{\"v\":2,\"agent\":\"g_1\"}"));
        Assert.Null(AgentDrag.Parse("{\"v\":1,\"agent\":\"https://evil.example/mcp/x\"}"));
        Assert.Equal(new AgentDrag("g_1", null, null), AgentDrag.Parse("{\"v\":1,\"agent\":\"g_1\",\"hub\":\"javascript:alert(1)\",\"ticket\":\"0123456789abcdef0\"}"));
        Assert.Equal(new AgentDrag("g_1", null, null), AgentDrag.Parse("{\"v\":1,\"agent\":\"g_1\",\"hub\":\"https://v2.apc.tineira.com\",\"ticket\":\"short\"}"));
    }

    [Fact]
    public void A_drag_without_the_type_carries_no_agent()
    {
        Assert.False(AgentDrag.MayCarry(["Text", "FileDrop"]));
        Assert.True(AgentDrag.MayCarry([AgentDrag.ChromiumCustomFormat]));
        Assert.Null(AgentDrag.From(_ => "hello", ["Text"]));
    }
}

public class FigureTests
{
    static Dataset Data()
    {
        var customers = new List<Customer> { new("cus_0001", "A", "team", "na", "2026-01"), new("cus_0002", "B", "starter", "latam", "2026-01"), new("cus_0003", "C", "team", "emea", "2026-02") };
        var activity = new List<Activity>
        {
            new("cus_0001", "2026-01", true, 5, 10), new("cus_0001", "2026-02", true, 5, 10),
            new("cus_0002", "2026-01", true, 2, 3), new("cus_0002", "2026-02", false, 0, 0),
            new("cus_0003", "2026-02", true, 7, 9),
        };
        return new Dataset(1, customers, activity);
    }

    [Fact]
    public void The_bridge_counts_as_Pulse_does()
    {
        var b = Figures.Bridge(Data(), "2026-02");
        Assert.Equal(2, b["start"]);
        Assert.Equal(1, b["new"]);
        Assert.Equal(0, b["reactivated"]);
        Assert.Equal(1, b["churned"]);
        Assert.Equal(2, b["end"]);
    }

    [Fact]
    public void A_pin_and_its_target_compare_by_canonical_form()
    {
        var t = Target.Figure("customer_bridge", "2026-02", "step:churned");
        var row = new FocusRow("g", "figure", null, "step:churned", new Dictionary<string, System.Text.Json.JsonElement>
        {
            ["month"] = System.Text.Json.JsonDocument.Parse("\"2026-02\"").RootElement,
            ["key"] = System.Text.Json.JsonDocument.Parse("\"customer_bridge\"").RootElement,
        }, "2026-10-25T00:00:00.000Z", null);
        Assert.Equal(t.Canonical, Target.CanonicalOf(row));
    }
}
