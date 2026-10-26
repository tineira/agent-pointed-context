//! The APC dock for Windows (#84): the web dock (v2.apc.tineira.com/dock) in a window of its own,
//! and its agents in a small strip that stays on top of every window, shown and hidden with a global
//! shortcut or from the tray. The page is the web dock's own, so the hub, pairing and the drag are
//! unchanged; only the windows are native. Closing a window hides it; Quit is in the tray.
//!
//! APC_DOCK_ORIGIN points it at another dock (a local `pnpm --dir apps/dock dev`, say).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, path::PathBuf};

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::NewWindowResponse,
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Shows and hides the strip; the dock page names it too (DESKTOP_SHORTCUT in apps/dock/src/web/hub.tsx).
const SHORTCUT: &str = "Alt+Shift+Space";

fn origin() -> Url {
    let dock = std::env::var("APC_DOCK_ORIGIN").unwrap_or_else(|_| "https://v2.apc.tineira.com".into());
    Url::parse(&dock).expect("APC_DOCK_ORIGIN is a URL")
}

/// The dock page, or with view=strip the strip.
fn page(query: Option<&str>) -> Url {
    let mut url = origin();
    url.set_path("/dock");
    url.set_query(query);
    url
}

/// Whether a window may go to this address: the dock's own pages stay; a link out of the dock
/// (Pulse, Signals, the Pulse for desktop download) opens in the person's browser instead.
/// Any other address (file:, mailto:, an app's own scheme) goes nowhere.
fn stays(url: &Url) -> bool {
    match url.scheme() {
        "about" | "blob" => true,
        "http" | "https" if url.origin() == origin().origin() => true,
        "http" | "https" => {
            let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
            false
        }
        _ => false,
    }
}

/// Tells the dock page it is in this app on every load (it then hides Install and Float), and takes
/// "/" back to the dock: Start over clears the page's storage and goes to "/", the web landing.
const SHELL_SCRIPT: &str = r#"window.__APC_SHELL__ = "desktop"; if (location.pathname === "/") location.replace("/dock");"#;

/// A window on the dock page. The webview keeps HTML drag and drop (Tauri's own drop handler is off),
/// so dragging an agent out of it is the page's drag, as in Chrome or Edge.
fn window<'a>(app: &'a AppHandle, label: &str, url: Url) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .disable_drag_drop_handler()
        .on_navigation(stays)
        .on_new_window(|url, _| {
            stays(&url);
            NewWindowResponse::Deny
        })
}

fn dock(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window("dock") {
        return Ok(w);
    }
    window(app, "dock", page(None))
        .initialization_script(SHELL_SCRIPT)
        .title("APC Dock")
        .inner_size(400.0, 760.0)
        .min_inner_size(320.0, 420.0)
        .build()
}

fn show_dock(app: &AppHandle) {
    if let Ok(w) = dock(app) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The strip: the agents' logos only (the dock page's ?view=strip), on top of every window, near the
/// top right of the main screen. Made hidden; the shortcut or the tray shows it.
fn strip(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window("strip") {
        return Ok(w);
    }
    let (width, height) = (200.0, 112.0);
    let mut builder = window(app, "strip", page(Some("view=strip")))
        .title("APC agents")
        .inner_size(width, height)
        .min_inner_size(96.0, 96.0)
        .always_on_top(true)
        .skip_taskbar(true)
        .maximizable(false)
        .minimizable(false)
        .visible(false);
    if let Some(screen) = app.primary_monitor()? {
        let size = screen.size().to_logical::<f64>(screen.scale_factor());
        builder = builder.position(size.width - width - 32.0, 96.0);
    }
    builder.build()
}

/// Whether the strip was showing when the app last ran (shown on the first run).
fn strip_flag(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("strip"))
}

fn strip_was_shown(app: &AppHandle) -> bool {
    strip_flag(app).and_then(|f| fs::read_to_string(f).ok()).is_none_or(|s| s != "0")
}

fn set_strip(app: &AppHandle, shown: bool) {
    if let Ok(w) = strip(app) {
        let _ = if shown { w.show() } else { w.hide() };
    }
    if let Some(item) = app.try_state::<CheckMenuItem<Wry>>() {
        let _ = item.set_checked(shown);
    }
    if let Some(flag) = strip_flag(app) {
        let _ = flag.parent().map(fs::create_dir_all);
        let _ = fs::write(flag, if shown { "1" } else { "0" });
    }
}

fn toggle_strip(app: &AppHandle) {
    let shown = app.get_webview_window("strip").and_then(|w| w.is_visible().ok()).unwrap_or(false);
    set_strip(app, !shown);
}

fn tray(app: &AppHandle, strip_shown: bool) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open dock", true, None::<&str>)?;
    let float = CheckMenuItem::with_id(app, "float", format!("Float agents\t{SHORTCUT}"), true, strip_shown, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit APC Dock", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &float, &PredefinedMenuItem::separator(app)?, &quit])?;
    app.manage(float);
    let mut builder = TrayIconBuilder::with_id("tray")
        .tooltip("APC Dock")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_dock(app),
            "float" => toggle_strip(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_dock(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // A second launch brings the running dock to the front.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show_dock(app)))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app = app.handle();
            dock(app)?;
            let shown = strip_was_shown(app);
            tray(app, shown)?;
            // The strip resumes the dock this window opens and waits for it on a first run, so both
            // can open at once (POST /api/dock with { resume: true }).
            set_strip(app, shown);
            // Another app may hold the shortcut already: the tray still shows and hides the strip.
            if let Err(e) = app.global_shortcut().on_shortcut(SHORTCUT, |app, _, event| {
                if event.state() == ShortcutState::Pressed {
                    toggle_strip(app);
                }
            }) {
                eprintln!("{SHORTCUT} is taken: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == "strip" {
                    set_strip(window.app_handle(), false);
                } else {
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("the APC dock could not start");
}
