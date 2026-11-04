// Pulse for desktop (TIN-396). Usage: PulseDesktop [--pulse <origin>]
// It shows the demo's one world, as Pulse on the web does (TIN-621). An old --world <Pulse link> still works: its origin is used, its seed ignored.
using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Styling;
using Avalonia.Themes.Fluent;

namespace PulseDesktop;

public static class Program
{
    // OLE drag and drop on Windows needs a single-threaded apartment.
    [STAThread]
    public static void Main(string[] args) => BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);

    public static AppBuilder BuildAvaloniaApp() => AppBuilder.Configure<App>().UsePlatformDetect().WithInterFont().LogToTrace();
}

public sealed class App : Application
{
    public override void Initialize()
    {
        Styles.Add(new FluentTheme());
        // Its colors are drawn for a light page; a dark Windows would otherwise give grey text on dark cards.
        RequestedThemeVariant = ThemeVariant.Light;
    }

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop) desktop.MainWindow = new MainWindow(desktop.Args ?? []);
        base.OnFrameworkInitializationCompleted();
    }
}
