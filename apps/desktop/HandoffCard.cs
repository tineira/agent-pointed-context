// The handoff card's controls (APC 0.10 section 4, TIN-901): built once per dock grant and kept, so the once-a-second tick
// changes only the countdown text (and what a phase change shows). Buttons are never rebuilt under the person's hand: a
// Tab stop stays where it is, and a Cancel pressed across a tick still clicks.
using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;

namespace PulseDesktop;

public sealed class HandoffCard
{
    static readonly IBrush Accent = new SolidColorBrush(Color.Parse("#b85209"));
    static readonly IBrush Line = new SolidColorBrush(Color.Parse("#7f8a99"), 0.35);
    static readonly IBrush Muted = new SolidColorBrush(Color.Parse("#7f8a99"));

    readonly TextBlock title = new() { FontWeight = FontWeight.SemiBold, TextWrapping = TextWrapping.Wrap };
    readonly Border codeBlock = new();
    readonly TextBlock code = new() { FontSize = 34, FontWeight = FontWeight.Bold, FontFamily = new FontFamily("Consolas, Menlo, monospace"), HorizontalAlignment = HorizontalAlignment.Center };
    readonly Button copy = new() { HorizontalAlignment = HorizontalAlignment.Center };
    readonly TextBlock clock = new() { Foreground = Muted };
    readonly StackPanel lines = new() { Spacing = 8 };
    HandoffPhase? shownPhase;
    DateTimeOffset copiedUntil = DateTimeOffset.MinValue;
    string? copyable;

    public string GrantId { get; }
    public Button Cancel { get; } = new() { Content = "Cancel", HorizontalAlignment = HorizontalAlignment.Left };
    public Border Root { get; }

    public HandoffCard(string grantId, Func<string, Task> copyText)
    {
        GrantId = grantId;
        codeBlock.Padding = new Thickness(12, 10);
        codeBlock.CornerRadius = new CornerRadius(10);
        codeBlock.BorderBrush = Line;
        codeBlock.BorderThickness = new Thickness(1);
        codeBlock.Child = new StackPanel
        {
            Spacing = 6,
            Children =
            {
                new TextBlock { Text = "CODE", FontSize = 11, Foreground = Muted, HorizontalAlignment = HorizontalAlignment.Center },
                code,
                copy,
            },
        };
        copy.Click += async (_, _) =>
        {
            if (copyable is null) return;
            await copyText(copyable);
            copiedUntil = DateTimeOffset.UtcNow.AddSeconds(1.5);
            copy.Content = "Copied";
        };
        Root = new Border
        {
            Padding = new Thickness(14, 12),
            CornerRadius = new CornerRadius(8),
            BorderBrush = Accent,
            BorderThickness = new Thickness(1),
            Child = new StackPanel { Spacing = 8, Children = { title, codeBlock, clock, lines, Cancel } },
        };
    }

    /// <summary>
    /// Show what the view says. The controls stay; the countdown and the Copy label change in place, and the lines under
    /// the code are swapped only when the phase does (they are plain text, with nothing to focus).
    /// </summary>
    public void Update(HandoffView view, DateTimeOffset now)
    {
        title.Text = view.Title;
        copyable = view.Code;
        codeBlock.IsVisible = view.Code is not null;
        clock.IsVisible = view.Code is not null;
        if (view.Code is not null)
        {
            code.Text = view.Code;
            clock.Text = $"Works once. Expires in {view.Clock}.";
            copy.Content = now < copiedUntil ? "Copied" : "Copy code";
        }
        if (shownPhase != view.Phase)
        {
            shownPhase = view.Phase;
            lines.Children.Clear();
            foreach (var line in view.Lines) lines.Children.Add(new TextBlock { Text = line, TextWrapping = TextWrapping.Wrap, Foreground = Muted });
        }
    }
}
