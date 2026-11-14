// Pulse for desktop's window (TIN-396): a slice of Pulse (the customer bridge, active customers per
// month, the customer list) drawn with native controls, each a target an agent dragged from the dock
// can be dropped on. MCP stays on Pulse's server: a drop pins through Pulse's own API, exactly as the
// page does (consent here, then in the dock; later drops confirmed with the dock), and the agent reads
// with Pulse's tools. Pins show the agent's mark (TIN-388), with a ring until it reads them. The consent shows no
// pairing code (TIN-901); after the Allow a card shows it, large, with copy and the time left, until the dock connects.
using System.Diagnostics;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Controls.Shapes;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;

namespace PulseDesktop;

public sealed class MainWindow : Window
{
    static readonly IBrush Accent = new SolidColorBrush(Color.Parse("#b85209"));
    static readonly IBrush Ok = new SolidColorBrush(Color.Parse("#1f7a4d"));
    static readonly IBrush Line = new SolidColorBrush(Color.Parse("#7f8a99"), 0.35);
    static readonly IBrush Muted = new SolidColorBrush(Color.Parse("#7f8a99"));
    static readonly string DockUrl = "https://apc.tineira.com/dock";

    /// <summary>PULSE_DESKTOP_DEBUG=1 logs every drag's formats to stderr, to see what a source hands over.</summary>
    static readonly bool Debug = Environment.GetEnvironmentVariable("PULSE_DESKTOP_DEBUG") == "1";
    PulseClient client;
    SandboxState? state;
    Dataset? data;
    string month = "";
    readonly List<(Control Control, Target Target, Panel Pins)> targets = [];
    readonly StackPanel bar = new() { Orientation = Orientation.Horizontal, Spacing = 8, VerticalAlignment = VerticalAlignment.Center };
    readonly ComboBox months = new() { MinWidth = 140 };
    readonly ContentControl body = new();
    readonly TextBlock status = new() { Margin = new Thickness(16, 6), Foreground = Muted, TextWrapping = TextWrapping.Wrap };
    /// <summary>The dock grants waiting for their pairing code (APC 0.9): the code, the time left, and Cancel.</summary>
    readonly StackPanel waiting = new() { Spacing = 6, Margin = new Thickness(16, 8, 16, 0) };
    readonly DispatcherTimer waitingClock = new() { Interval = TimeSpan.FromSeconds(1) };
    /// <summary>The handoff cards, one per dock grant in handoff, kept between ticks (HandoffCard).</summary>
    readonly Dictionary<string, HandoffCard> cards = new();

    public MainWindow(string[] args)
    {
        Title = "Pulse for desktop";
        Width = 1100;
        Height = 760;
        MinWidth = 760;
        MinHeight = 520;
        // One world for everyone (TIN-621): nothing to paste. An old --world <Pulse link> still names a Pulse to open.
        var origin = Arg(args, "--pulse") ?? Environment.GetEnvironmentVariable("PULSE_URL") ?? PulseClient.OriginOf(Arg(args, "--world")) ?? "https://pulse.apc.tineira.com";
        client = NewClient(new Uri(origin));
        var dock = new Button { Content = "Open agent dock" };
        dock.Click += (_, _) => OpenUrl(DockUrl);
        var startOver = new Button { Content = "Start over" };
        startOver.Click += async (_, _) => await StartOverAsync();
        months.SelectionChanged += async (_, _) =>
        {
            if (months.SelectedItem is string m && m != month)
            {
                month = m;
                Render();
                await Try(() => client.ReportViewAsync("overview", month, null));
            }
        };

        var header = new Border
        {
            Padding = new Thickness(16, 10),
            BorderBrush = Line,
            BorderThickness = new Thickness(0, 0, 0, 1),
            Child = new DockPanel
            {
                LastChildFill = false,
                Children =
                {
                    new StackPanel
                    {
                        Orientation = Orientation.Horizontal,
                        Spacing = 10,
                        VerticalAlignment = VerticalAlignment.Center,
                        Children =
                        {
                            new TextBlock { Text = "Pulse", FontSize = 18, FontWeight = FontWeight.Bold, VerticalAlignment = VerticalAlignment.Center },
                            new TextBlock { Text = "FOR DESKTOP", FontSize = 11, Foreground = Muted, VerticalAlignment = VerticalAlignment.Center },
                        },
                    }.Also(p => DockPanel.SetDock(p, Dock.Left)),
                    new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12, Children = { bar, dock, startOver } }.Also(p => DockPanel.SetDock(p, Dock.Right)),
                },
            },
        };
        DockPanel.SetDock(header, Dock.Top);
        DockPanel.SetDock(waiting, Dock.Top);
        DockPanel.SetDock(status, Dock.Bottom);
        Content = new DockPanel { Children = { header, waiting, status, new ScrollViewer { Content = body, Padding = new Thickness(16) } } };
        waitingClock.Tick += (_, _) => DrawWaiting();

        Opened += async (_, _) => await OpenAsync();
        Closed += (_, _) =>
        {
            waitingClock.Stop();
            client.Dispose();
        };
    }

    static string? Arg(string[] args, string name)
    {
        var i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    PulseClient NewClient(Uri origin)
    {
        var c = new PulseClient(origin);
        c.Changed += () => Dispatcher.UIThread.Post(async () => await RefreshAsync());
        return c;
    }

    /// <summary>Open the sandbox: the demo's one world, the same customers and ids as Pulse and Signals on the web (TIN-621).</summary>
    async Task OpenAsync()
    {
        await Try(async () =>
        {
            await client.OpenAsync();
            data = await client.DatasetAsync();
            var all = Figures.Months(data);
            months.ItemsSource = all;
            month = all[^1];
            months.SelectedItem = month;
            await RefreshAsync();
            await client.ReportViewAsync("overview", month, null);
            Say($"Open on {client.Origin.Host}, the same data as Pulse on the web. Drag an agent from your dock onto a step, a bar or a customer.");
        });
    }

    async Task RefreshAsync()
    {
        if (client.Sid is null) return;
        await Try(async () =>
        {
            state = await client.StateAsync();
            Render();
            DrawWaiting();
        });
    }

    /// <summary>
    /// After the Allow (APC 0.9, 0.10 section 4): each dock grant in handoff gets the handoff card, the same as the web's: the
    /// code large with copy, the time left, a warning under it, and Cancel (the app's Cancel route, which ends a grant only
    /// in handoff), until the dock connects or the grant goes. Pulse's stored expiry is the truth: at zero the countdown
    /// stops and the code goes, with a note that the dock did not finish in time. If the person's own dock never asks for the
    /// code, the agent was someone else's.
    /// </summary>
    void DrawWaiting()
    {
        var links = state?.hub_links?.Where(l => l.state == "handoff").ToList() ?? new List<HubLink>();
        // A grant that is no longer in handoff loses its card; the others keep theirs, so nothing the person is pressing is rebuilt.
        foreach (var gone in cards.Keys.Where(id => links.All(l => l.grant_id != id)).ToList())
        {
            waiting.Children.Remove(cards[gone].Root);
            cards.Remove(gone);
        }
        if (links.Count == 0)
        {
            waitingClock.Stop();
            return;
        }
        if (!waitingClock.IsEnabled) waitingClock.Start();
        var now = DateTimeOffset.UtcNow;
        foreach (var l in links)
        {
            if (!cards.TryGetValue(l.grant_id, out var card))
            {
                card = new HandoffCard(l.grant_id, async text =>
                {
                    if (Clipboard is { } clip) await clip.SetTextAsync(text);
                });
                var grantId = l.grant_id;
                card.Cancel.Click += async (_, _) => await Try(async () =>
                {
                    var r = await client.CancelAsync(grantId);
                    Say(r.Ok ? "Cancelled: Pulse took that dock's access back." : $"Not cancelled: {Describe(r.Error)}");
                    await RefreshAsync();
                });
                cards[l.grant_id] = card;
                waiting.Children.Add(card.Root);
            }
            var host = Uri.TryCreate(l.hub, UriKind.Absolute, out var hub) ? hub.Host : l.hub;
            card.Update(Handoff.View(host, l.pairing, now), now);
        }
    }

    // ---- drawing ----

    void Render()
    {
        if (data is null || state is null || month == "") return;
        targets.Clear();
        var bridge = Figures.Bridge(data, month);
        // A waterfall, as on the page (charts.tsx): New and Reactivated rise from where Start ends, Churned
        // falls from there, Start and End stand on the floor.
        const double plot = 150;
        var max = Math.Max(1, Math.Max(bridge["start"] + bridge["new"] + bridge["reactivated"], bridge["end"]));
        var level = 0;
        var steps = new Grid { ColumnDefinitions = new ColumnDefinitions("*,*,*,*,*"), Height = 200, Margin = new Thickness(0, 8, 0, 0) };
        for (var i = 0; i < Figures.BridgeSteps.Length; i++)
        {
            var step = Figures.BridgeSteps[i];
            var n = bridge[step];
            var (from, to) = step switch { "new" or "reactivated" => (level, level + n), "churned" => (level - n, level), _ => (0, n) };
            level = step switch { "start" or "end" => n, "churned" => level - n, _ => level + n };
            var color = step switch { "new" or "reactivated" => Ok, "churned" => new SolidColorBrush(Color.Parse("#c0392b")), _ => Accent };
            var column = new DockPanel { Margin = new Thickness(6, 0) };
            var label = new TextBlock { Text = $"{Capital(step)}\n{(step is "churned" ? "−" : step is "new" or "reactivated" ? "+" : "")}{n}", TextAlignment = TextAlignment.Center, FontWeight = FontWeight.SemiBold };
            DockPanel.SetDock(label, Dock.Bottom);
            column.Children.Add(label);
            column.Children.Add(new Border
            {
                Background = color,
                CornerRadius = new CornerRadius(3),
                Height = Math.Max(2, plot * (to - from) / max),
                Margin = new Thickness(0, 0, 0, plot * from / max),
                VerticalAlignment = VerticalAlignment.Bottom,
            });
            var t = Target.Figure("customer_bridge", month, $"step:{step}");
            steps.Children.Add(Pointable(column, t, padding: 2).Also(c => Grid.SetColumn(c, i)));
        }
        var bridgeCard = Card($"Customer bridge, {month}", "From last month's active customers to this month's. Every step is pointable, and so is the whole bridge.", steps);

        var series = Figures.ActiveSeries(data);
        var top = Math.Max(1, series.Max(s => s.Active));
        var bars = new Grid { Height = 170, Margin = new Thickness(0, 8, 0, 0) };
        for (var i = 0; i < series.Count; i++) bars.ColumnDefinitions.Add(new ColumnDefinition(GridLength.Star));
        for (var i = 0; i < series.Count; i++)
        {
            var (m, n) = series[i];
            var col = new DockPanel { Margin = new Thickness(2, 0) };
            var lbl = new TextBlock { Text = m[5..], FontSize = 10, Foreground = Muted, HorizontalAlignment = HorizontalAlignment.Center };
            DockPanel.SetDock(lbl, Dock.Bottom);
            col.Children.Add(lbl);
            col.Children.Add(new Border { Background = m == month ? Accent : Line, CornerRadius = new CornerRadius(3), Height = 4 + 130.0 * n / top, VerticalAlignment = VerticalAlignment.Bottom }.Also(b => ToolTip.SetTip(b, $"{m}: {n} active")));
            bars.Children.Add(Pointable(col, Target.Figure("active_customers", m), padding: 1).Also(c => Grid.SetColumn(c, i)));
        }
        var activeCard = Card("Active customers per month", "Drop an agent on a bar, or on the chart for the whole trend.", bars, Target.Figure("active_customers", month, "series"));

        var at = data.activity.Where(a => a.month == month).ToDictionary(a => a.customer_id);
        var rows = new StackPanel { Spacing = 2, Margin = new Thickness(0, 8, 0, 0) };
        foreach (var c in data.customers.Where(c => at.TryGetValue(c.id, out var a) && a.active).OrderByDescending(c => at[c.id].seats).Take(40))
        {
            var row = new Grid { ColumnDefinitions = new ColumnDefinitions("80,*,70,60,44") };
            row.Children.Add(new TextBlock { Text = c.id, FontFamily = new FontFamily("Consolas, Menlo, monospace"), Foreground = Muted });
            row.Children.Add(new TextBlock { Text = c.name, TextTrimming = TextTrimming.CharacterEllipsis, Margin = new Thickness(0, 0, 8, 0) }.Also(x => Grid.SetColumn(x, 1)));
            row.Children.Add(new TextBlock { Text = c.plan, Foreground = Muted }.Also(x => Grid.SetColumn(x, 2)));
            row.Children.Add(new TextBlock { Text = c.region.ToUpperInvariant(), Foreground = Muted }.Also(x => Grid.SetColumn(x, 3)));
            row.Children.Add(new TextBlock { Text = at[c.id].seats.ToString(), TextAlignment = TextAlignment.Right }.Also(x => Grid.SetColumn(x, 4)));
            rows.Children.Add(Pointable(row, Target.Customer(c.id), padding: 6));
        }
        var customersCard = Card("Customers", $"Active in {month}, most seats first. Each row is pointable.", rows);

        // The month picker outlives each drawing: take it off the last one before placing it again.
        (months.Parent as Panel)?.Children.Remove(months);
        var left = new StackPanel { Spacing = 16, Children = { new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Children = { new TextBlock { Text = "Month", VerticalAlignment = VerticalAlignment.Center, Foreground = Muted }, months } }, bridgeCard, activeCard } };
        var grid = new Grid { ColumnDefinitions = new ColumnDefinitions("5*,4*") };
        grid.Children.Add(left);
        grid.Children.Add(customersCard.Also(c => { Grid.SetColumn(c, 1); c.Margin = new Thickness(16, 0, 0, 0); }));
        body.Content = grid;
        DrawPins();
        DrawBar();
    }

    static string Capital(string s) => char.ToUpperInvariant(s[0]) + s[1..];

    Border Card(string title, string hint, Control content, Target? whole = null)
    {
        var inner = new StackPanel { Children = { new TextBlock { Text = title, FontWeight = FontWeight.SemiBold, FontSize = 15 }, new TextBlock { Text = hint, Foreground = Muted, FontSize = 12, TextWrapping = TextWrapping.Wrap }, content } };
        var card = new Border { Padding = new Thickness(14), CornerRadius = new CornerRadius(10), BorderBrush = Line, BorderThickness = new Thickness(1) };
        if (whole is null)
        {
            card.Child = inner;
            return card;
        }
        return (Border)Pointable(inner, whole, padding: 0, frame: card);
    }

    /// <summary>A target: it takes an agent dropped from the dock, lights up under a drag, and shows the agents pinned on it.</summary>
    Control Pointable(Control content, Target target, double padding, Border? frame = null)
    {
        var pins = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, -4, -4, 0) };
        var host = frame ?? new Border { Padding = new Thickness(padding), CornerRadius = new CornerRadius(6), BorderThickness = new Thickness(2), BorderBrush = Brushes.Transparent, Background = Brushes.Transparent };
        host.Child = new Panel { Children = { content, pins } };
        var restBrush = host.BorderBrush;
        var restThickness = host.BorderThickness;
        DragDrop.SetAllowDrop(host, true);
        // The older IDataObject API: it hands over a foreign clipboard format (Chromium's custom MIME data) by name, as bytes.
#pragma warning disable CS0618
        host.AddHandler(DragDrop.DragOverEvent, (_, e) =>
        {
            if (Debug) Console.Error.WriteLine($"drag over {target.Canonical}: {string.Join(", ", e.Data.GetDataFormats())}");
            if (!AgentDrag.MayCarry(e.Data.GetDataFormats())) return;
            e.DragEffects = DragDropEffects.Link;
            host.BorderBrush = Accent;
            host.BorderThickness = new Thickness(2);
            e.Handled = true; // the innermost target wins
        });
        void Rest()
        {
            host.BorderBrush = restBrush;
            host.BorderThickness = restThickness;
        }
        host.AddHandler(DragDrop.DragLeaveEvent, (_, _) => Rest());
        host.AddHandler(DragDrop.DropEvent, async (_, e) =>
        {
            Rest();
            if (e.Handled) return;
            e.Handled = true;
            var formats = e.Data.GetDataFormats().ToList();
            var drag = AgentDrag.From(f => e.Data.Get(f), formats);
            await OnDropAsync(drag, target, formats);
        });
#pragma warning restore CS0618
        targets.Add((host, target, pins));
        return host;
    }

    void DrawPins()
    {
        if (state is null) return;
        foreach (var (_, target, pins) in targets)
        {
            pins.Children.Clear();
            foreach (var g in state.grants.Where(g => g.pin is not null && Target.CanonicalOf(g.pin) == target.Canonical))
            {
                var mark = Mark(g, 22);
                var ring = new Border
                {
                    Width = 30,
                    Height = 30,
                    CornerRadius = new CornerRadius(8),
                    BorderThickness = new Thickness(2),
                    BorderBrush = g.pin!.Seen ? Brushes.Transparent : Accent,
                    Background = Brushes.White,
                    Child = mark,
                    Cursor = new Cursor(StandardCursorType.Hand),
                };
                ToolTip.SetTip(ring, $"{g.Name}: {(g.pin.Seen ? "read this pin" : "has not read this pin yet")}. Click to remove it.");
                ring.PointerPressed += async (_, _) => await Try(async () => { await client.UnpinAsync(g.id); await RefreshAsync(); });
                var badge = new Panel { Children = { ring } };
                if (g.pin.Seen) badge.Children.Add(new Border { Width = 14, Height = 14, CornerRadius = new CornerRadius(7), Background = Ok, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(0, 0, -4, -4), Child = new TextBlock { Text = "✓", Foreground = Brushes.White, FontSize = 9, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center } });
                pins.Children.Add(badge);
            }
        }
    }

    /// <summary>The standard agent bar (TIN-394), natively: each agent's mark, and a dot where it points (click: show it).</summary>
    void DrawBar()
    {
        bar.Children.Clear();
        if (state is null) return;
        foreach (var g in state.grants)
        {
            var chip = new Border { Width = 32, Height = 32, CornerRadius = new CornerRadius(8), BorderBrush = Line, BorderThickness = new Thickness(1), Child = Mark(g, 22), Opacity = g.client_name is null ? 0.45 : 1 };
            ToolTip.SetTip(chip, g.client_name is null ? $"{g.Name} (not connected yet)" : g.Name);
            var item = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, Children = { chip } };
            if (g.pin is { } pin)
            {
                var dot = new Ellipse { Width = 10, Height = 10, Fill = pin.Seen ? Ok : Accent, Cursor = new Cursor(StandardCursorType.Hand), VerticalAlignment = VerticalAlignment.Center };
                ToolTip.SetTip(dot, pin.Seen ? "Read. Click to show it." : "Not read yet. Click to show it.");
                dot.PointerPressed += (_, _) => targets.FirstOrDefault(t => t.Target.Canonical == Target.CanonicalOf(pin)).Control?.BringIntoView();
                item.Children.Add(dot);
            }
            bar.Children.Add(item);
        }
    }

    /// <summary>An agent's mark: the icon its dock or client sent (a small PNG), or its initial.</summary>
    static Control Mark(Grant g, double size)
    {
        var src = g.client_icon;
        var comma = src?.IndexOf(',') ?? -1;
        if (src is not null && src.StartsWith("data:image/") && comma > 0)
        {
            try
            {
                using var stream = new MemoryStream(Convert.FromBase64String(src[(comma + 1)..]));
                return new Image { Source = new Bitmap(stream), Width = size, Height = size, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            }
            catch (FormatException) { }
        }
        return new TextBlock { Text = g.Name[..1].ToUpperInvariant(), FontWeight = FontWeight.Bold, Foreground = Accent, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    }

    // ---- drops ----

    async Task OnDropAsync(AgentDrag? drag, Target target, List<string> formats)
    {
        if (drag is null)
        {
            Say($"That drag carries no agent (formats: {string.Join(", ", formats.Take(6))}). Drag your agent from the agent dock.");
            return;
        }
        if (drag.Hub is null || drag.Ticket is null)
        {
            Say("This agent came without a pairing ticket. Drag it again from your agent dock.");
            return;
        }
        // Every drop goes to Pulse, which decides (TIN-606): one it holds no grant for asks first, with the nonce and the
        // pairing code to show (APC 0.9); one still waiting for its code in the dock comes back with it.
        await Try(async () =>
        {
            var r = await client.HubPairAsync(drag, target, null, null);
            if (r.Error == "consent_required" && r.Consent is not null && r.PairingCode is not null) await ConsentAsync(drag, target, r.Consent);
            else if (r.Ok && r.Status == "pending" && r.Pairing is not null) Say($"Waiting for your dock: type the code in the card above there to allow it.{PinNote(r.PinError)}");
            else if (r.Ok) Say($"Pinned {state?.grants.FirstOrDefault(g => g.id == r.GrantId)?.Name ?? "your agent"}. Now ask it about \"this\".");
            else Say($"Not pinned: {Describe(r.Error)}");
        });
        await RefreshAsync();
    }

    /// <summary>A pairing that went through while the pin on the drop's target failed (pin_error): said, not dropped.</summary>
    static string PinNote(string? pinError) => pinError is null ? "" : $" Not pinned where you dropped it ({pinError}): drop the agent there again once your dock connects.";

    /// <summary>A refusal in words, as the page says it (hub-consent.tsx).</summary>
    static string Describe(string? error) => error switch
    {
        "ticket_expired" => "the drag is too old. Drag the agent from the dock again.",
        "consent_required" => "this question is too old. Drag the agent from the dock again.",
        "hub_not_allowed" => "Pulse does not pair with that dock.",
        "hub_unreachable" => "the dock did not answer. Try again in a moment.",
        "hub_refused" => "the dock did not answer as a dock should, so Pulse didn't pair.",
        "hub_ignores_pairing_code" => "this dock can't check pairing codes, so Pulse didn't pair.",
        "invalid_pairing_code" or "pairing_code_required" => "the dock refused the pairing code. Drag the agent from the dock again.",
        "not_cancellable" => "the dock has connected already, so Cancel no longer applies. To take its access back, revoke the agent in Pulse on the web (pulse.apc.tineira.com, in the agent bar).",
        "pairing_ended" => "that pairing ended before the dock connected. Drag the agent from the dock again.",
        null => "it did not go through.",
        _ => error,
    };

    /// <summary>
    /// The first drop of a dock agent: ask the person here (all of Pulse, or one region); then the dock asks too, and needs the
    /// pairing code (APC 0.9). The dialog shows no code (TIN-901): the card in the window shows it once the person has allowed.
    /// Allow is not the default: Enter does not allow.
    /// </summary>
    async Task ConsentAsync(AgentDrag drag, Target target, string consent)
    {
        var host = new Uri(drag.Hub!).Host;
        var region = new ComboBox { ItemsSource = new[] { "All of Pulse", "LATAM only", "NA only", "EMEA only" }, SelectedIndex = 0, MinWidth = 160 };
        var allow = new Button { Content = "Allow", Classes = { "accent" } };
        var cancel = new Button { Content = "Not now", IsCancel = true };
        var dialog = new Window
        {
            Title = "Pulse",
            Width = 460,
            SizeToContent = SizeToContent.Height,
            CanResize = false,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Content = new StackPanel
            {
                Margin = new Thickness(20),
                Spacing = 12,
                Children =
                {
                    new TextBlock { Text = $"Let your agent from the dock at {host} read Pulse?", FontSize = 17, FontWeight = FontWeight.Bold, TextWrapping = TextWrapping.Wrap },
                    new TextBlock { Text = "If you allow it, Pulse gives that dock its own access, the dock asks you once more, and from then on that agent reads Pulse when you point it here.", TextWrapping = TextWrapping.Wrap, Foreground = Muted },
                    new TextBlock { Text = "After Allow, your dock will ask for a code.", TextWrapping = TextWrapping.Wrap },
                    new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Children = { new TextBlock { Text = "Access", VerticalAlignment = VerticalAlignment.Center }, region } },
                    new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Children = { allow, cancel } },
                },
            },
        };
        allow.Click += (_, _) => dialog.Close(true);
        cancel.Click += (_, _) => dialog.Close(false);
        if (await dialog.ShowDialog<bool>(this) != true) return;
        string? scope = region.SelectedIndex switch { 1 => "latam", 2 => "na", 3 => "emea", _ => null };
        var r = await client.HubPairAsync(drag, target, scope, consent);
        // Paired: the card in the window shows the code until the dock connects. Not paired: said.
        Say(r.Ok ? $"Paired with the dock at {host}. Type the code in the card above there to allow it, then ask your agent about \"this\".{PinNote(r.PinError)}" : $"Not paired: {Describe(r.Error)}");
    }

    /// <summary>
    /// Start over (TIN-411), as on the web: this app's sandbox and session go, after a confirm that says
    /// what goes, links the other sites' Start over, and gives the prompt that drops "APC" from the agent.
    /// </summary>
    async Task StartOverAsync()
    {
        const string disconnect = "Please remove the remote MCP server named \"APC\" (its URL starts with https://apc.tineira.com/mcp/) from your connectors. If you can remove it yourself, do it now and tell me when it's gone. If you can't, tell me the exact steps to remove it in the app I'm using you in right now.";
        var go = new Button { Content = "Delete and start over", Classes = { "accent" } };
        var cancel = new Button { Content = "Cancel", IsCancel = true, IsDefault = true };
        var copy = new Button { Content = "Copy", VerticalAlignment = VerticalAlignment.Top };
        Button Link(string name, string url)
        {
            var b = new Button { Content = $"Start over in {name}" };
            b.Click += (_, _) => OpenUrl($"{url}?start_over=1");
            return b;
        }
        var dialog = new Window
        {
            Title = "Pulse",
            Width = 480,
            SizeToContent = SizeToContent.Height,
            CanResize = false,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Content = new StackPanel
            {
                Margin = new Thickness(20),
                Spacing = 10,
                Children =
                {
                    new TextBlock { Text = "Start over in Pulse for desktop?", FontSize = 17, FontWeight = FontWeight.Bold },
                    new TextBlock { Text = "This deletes this app's Pulse sandbox: the agents your dock paired here and their pins, your view, and the event log. The app forgets its session.", TextWrapping = TextWrapping.Wrap },
                    new TextBlock { Text = "To start from zero everywhere, do the same on the other sites (each opens in your browser and asks you there):", TextWrapping = TextWrapping.Wrap, FontWeight = FontWeight.SemiBold },
                    new WrapPanel { ItemSpacing = 8, LineSpacing = 8, Children = { Link("Agent dock", DockUrl), Link("Pulse (web)", "https://pulse.apc.tineira.com/agents"), Link("Signals", "https://signals.apc.tineira.com/") } },
                    new TextBlock { Text = "And remove the \"APC\" server from your agent. Paste this to your agent:", TextWrapping = TextWrapping.Wrap },
                    new DockPanel
                    {
                        Children =
                        {
                            copy.Also(c => { DockPanel.SetDock(c, Dock.Right); c.Margin = new Thickness(8, 0, 0, 0); }),
                            new TextBlock { Text = disconnect, TextWrapping = TextWrapping.Wrap, FontFamily = new FontFamily("Consolas, monospace"), FontSize = 12, Foreground = Muted },
                        },
                    },
                    new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right, Children = { cancel, go } },
                },
            },
        };
        copy.Click += async (_, _) =>
        {
            if (dialog.Clipboard is { } clip) await clip.SetTextAsync(disconnect);
            copy.Content = "Copied";
        };
        go.Click += (_, _) => dialog.Close(true);
        cancel.Click += (_, _) => dialog.Close(false);
        if (await dialog.ShowDialog<bool>(this) != true) return;
        await Try(async () =>
        {
            await client.ResetAsync();
            data = null;
            state = null;
            month = "";
            body.Content = null;
            bar.Children.Clear();
        });
        // A new sandbox at once, as the web page opens one: the same data, none of the old agents or pins.
        await OpenAsync();
    }

    // ---- helpers ----

    void Say(string text) => status.Text = text;

    async Task Try(Func<Task> work)
    {
        try
        {
            await work();
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e);
            Say($"Something went wrong: {e.Message}");
        }
    }

    static void OpenUrl(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch (Exception) { }
    }
}

static class Fluent
{
    /// <summary>Configure a control inline and keep building the tree.</summary>
    public static T Also<T>(this T x, Action<T> f)
    {
        f(x);
        return x;
    }
}
