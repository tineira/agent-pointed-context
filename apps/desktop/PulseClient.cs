// Pulse for desktop's line to Pulse's v2 deploy: the same owner API the page uses, with the session
// cookie kept on disk so the app reopens its sandbox, and the page's WebSocket heartbeat, so agents
// know the person is on Pulse (their wait_for_focus keeps waiting) and the app hears every change.
using System.Net;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace PulseDesktop;

/// <summary>What a dock agent's drop answers (apps/demo/src/worker/sandbox.ts, PairHubAnswer).</summary>
public sealed record HubPairResult(bool Ok, string? Error, string? GrantId, string? Status, string? Consent, string? PairingCode, DockPairing? Pairing);

public sealed class PulseClient : IDisposable
{
    public static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
    readonly CookieContainer cookies = new();
    readonly HttpClient http;
    readonly string cookieFile;
    CancellationTokenSource? socketStop;

    public Uri Origin { get; }
    public string? Sid { get; private set; }
    /// <summary>Raised on every message from the sandbox (a pin, a read, a new agent): refresh.</summary>
    public event Action? Changed;

    public PulseClient(Uri origin)
    {
        Origin = origin;
        http = new HttpClient(new HttpClientHandler { CookieContainer = cookies, UseCookies = true }) { BaseAddress = origin, Timeout = TimeSpan.FromSeconds(30) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("PulseDesktop/0.1");
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PulseDesktop");
        Directory.CreateDirectory(dir);
        cookieFile = Path.Combine(dir, $"session-{origin.Host}.txt");
        try
        {
            var saved = File.ReadAllText(cookieFile).Trim();
            if (saved.Length > 0) cookies.Add(origin, new Cookie("apc_session", saved, "/"));
        }
        catch (IOException) { }
    }

    /// <summary>The origin of a Pulse link (an old dock's world link, ?seed= and all), or null for anything else.</summary>
    public static string? OriginOf(string? link) =>
        Uri.TryCreate(link?.Trim(), UriKind.Absolute, out var url) && (url.Scheme == "https" || url.Scheme == "http") ? url.GetLeftPart(UriPartial.Authority) : null;

    /// <summary>Open (or reopen) the sandbox. Its data is the demo's one world, the same as on the web (TIN-621).</summary>
    public async Task OpenAsync()
    {
        var res = await http.PostAsJsonAsync("/api/session", new { });
        res.EnsureSuccessStatusCode();
        var json = await res.Content.ReadFromJsonAsync<JsonElement>();
        Sid = json.GetProperty("sid").GetString();
        var cookie = cookies.GetCookies(Origin)["apc_session"]?.Value;
        if (cookie is not null) await File.WriteAllTextAsync(cookieFile, cookie);
        StartSocket();
    }

    string Base => $"/api/s/{Sid}";

    public async Task<SandboxState> StateAsync() =>
        (await http.GetFromJsonAsync<SandboxState>($"{Base}/state", JsonOptions))!;

    public async Task<Dataset> DatasetAsync() =>
        (await http.GetFromJsonAsync<Dataset>($"{Base}/dataset", JsonOptions))!;

    public async Task<(bool Ok, string? Error, string? GrantId)> PostAsync(string path, object body)
    {
        var res = await http.PostAsJsonAsync($"{Base}{path}", body);
        var json = await res.Content.ReadFromJsonAsync<JsonElement>();
        var ok = json.TryGetProperty("ok", out var o) && o.ValueKind == JsonValueKind.True;
        var error = json.TryGetProperty("error", out var e) ? e.GetString() : null;
        var grant = json.TryGetProperty("grant_id", out var g) ? g.GetString() : null;
        return (ok || (res.IsSuccessStatusCode && error is null), error, grant);
    }

    /// <summary>
    /// A dock agent dropped here: every drop goes to Pulse, which decides (TIN-606). An agent Pulse holds no grant for
    /// comes back consent_required with the nonce and the pairing code to show (APC 0.9); the Allow sends the nonce
    /// back (`consent`). A paired agent is pinned once its dock confirms (TIN-389); one still waiting for its code in
    /// the dock comes back with `pairing`.
    /// </summary>
    public async Task<HubPairResult> HubPairAsync(AgentDrag drag, Target target, string? region, string? consent)
    {
        var res = await http.PostAsJsonAsync($"{Base}/hub/pair", new { hub = drag.Hub, agent = drag.Agent, ticket = drag.Ticket, region, target = target.ToJson(), consent });
        var json = await res.Content.ReadFromJsonAsync<JsonElement>();
        string? Str(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        var ok = json.ValueKind == JsonValueKind.Object && json.TryGetProperty("ok", out var o) && o.ValueKind == JsonValueKind.True;
        DockPairing? pairing = null;
        if (json.ValueKind == JsonValueKind.Object && json.TryGetProperty("pairing", out var p) && Str(p, "code") is { } code && Str(p, "expires_at") is { } until) pairing = new DockPairing(code, until);
        return new HubPairResult(ok, Str(json, "error"), Str(json, "grant_id"), Str(json, "status"), Str(json, "consent"), Str(json, "pairing_code"), pairing);
    }

    /// <summary>Revoke from the app (APC 0.2): also Cancel on a grant still waiting for its pairing code (APC 0.9).</summary>
    public Task<(bool Ok, string? Error, string? GrantId)> RevokeAsync(string grantId) => PostAsync($"/grants/{grantId}/revoke", new { });

    public Task<(bool Ok, string? Error, string? GrantId)> UnpinAsync(string grantId) => PostAsync("/unpin", new { grant_id = grantId });

    public Task ReportViewAsync(string screen, string month, string? customer) =>
        PostAsync("/view", new { screen, @params = new { month }, selection = customer is null ? null : new { kind = "customer", id = customer } });

    /// <summary>The page's heartbeat: "ping" every 30 s, so Pulse counts this app as the person's open page.</summary>
    void StartSocket()
    {
        socketStop?.Cancel();
        socketStop = new CancellationTokenSource();
        var stop = socketStop.Token;
        _ = Task.Run(async () =>
        {
            var delay = TimeSpan.FromSeconds(2);
            while (!stop.IsCancellationRequested)
            {
                try
                {
                    using var ws = new ClientWebSocket();
                    ws.Options.Cookies = cookies;
                    var scheme = Origin.Scheme == "https" ? "wss" : "ws";
                    await ws.ConnectAsync(new Uri($"{scheme}://{Origin.Authority}{Base}/ws"), stop);
                    delay = TimeSpan.FromSeconds(2);
                    var ping = Encoding.UTF8.GetBytes("ping");
                    await ws.SendAsync(ping, WebSocketMessageType.Text, true, stop);
                    var beat = Task.Run(async () =>
                    {
                        while (ws.State == WebSocketState.Open && !stop.IsCancellationRequested)
                        {
                            await Task.Delay(TimeSpan.FromSeconds(30), stop);
                            await ws.SendAsync(ping, WebSocketMessageType.Text, true, stop);
                        }
                    }, stop);
                    var buffer = new byte[8192];
                    while (ws.State == WebSocketState.Open && !stop.IsCancellationRequested)
                    {
                        var r = await ws.ReceiveAsync(buffer, stop);
                        if (r.MessageType == WebSocketMessageType.Close) break;
                        if (r.EndOfMessage && Encoding.UTF8.GetString(buffer, 0, r.Count) != "pong") Changed?.Invoke();
                    }
                }
                catch (OperationCanceledException) { return; }
                catch (Exception) { }
                await Task.Delay(delay, stop).ContinueWith(_ => { });
                delay = TimeSpan.FromSeconds(Math.Min(60, delay.TotalSeconds * 2));
            }
        }, stop);
    }

    /// <summary>Start over (TIN-411): the sandbox deletes everything, and this app forgets its session.</summary>
    public async Task ResetAsync()
    {
        if (Sid is not null)
        {
            try { await http.PostAsJsonAsync($"{Base}/reset", new { }); }
            catch (HttpRequestException) { }
        }
        socketStop?.Cancel();
        foreach (Cookie c in cookies.GetCookies(Origin)) c.Expired = true;
        try { File.Delete(cookieFile); }
        catch (IOException) { }
        Sid = null;
    }

    public void Dispose()
    {
        socketStop?.Cancel();
        http.Dispose();
    }
}
