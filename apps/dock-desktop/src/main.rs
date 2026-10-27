//! The APC dock for Windows (#84): the web dock (v2.apc.tineira.com/dock) in a window of its own,
//! and its agents as desktop pets (TIN-479, pets.rs): each agent's logo in a small window of its own
//! on top of every window, all shown and hidden with a global shortcut or from the tray. The pages are
//! the web dock's own, so the hub, pairing and the drag are unchanged; only the windows are native.
//! Closing a window hides it; Quit is in the tray.
//!
//! APC_DOCK_ORIGIN points it at another dock (a local `pnpm --dir apps/dock dev`, say).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pets;

use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::NewWindowResponse,
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Shows and hides the pets; the dock page names it too (DESKTOP_SHORTCUT in apps/dock/src/web/setup.tsx).
const SHORTCUT: &str = "Alt+Shift+Space";

/// The deployed dock: the only origin a release build lets the pets' page call the app (pets.rs).
const DOCK_ORIGIN: &str = "https://v2.apc.tineira.com";

fn origin() -> Url {
    let dock = std::env::var("APC_DOCK_ORIGIN").unwrap_or_else(|_| DOCK_ORIGIN.into());
    Url::parse(&dock).expect("APC_DOCK_ORIGIN is a URL")
}

/// The dock page, or with view=pet a pet.
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

/// Whether the pets show (Float agents in the tray), for pets opened later.
struct Floating(AtomicBool);

fn floating(app: &AppHandle) -> bool {
    app.try_state::<Floating>().is_some_and(|f| f.0.load(Ordering::Relaxed))
}

/// Whether the pets were showing when the app last ran (shown on the first run).
fn float_flag(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("float"))
}

/// Builds before the pets kept the same flag for the strip, as `strip`: read once when `float` is not there yet.
fn float_was_shown(app: &AppHandle) -> bool {
    let dir = app.path().app_config_dir().ok();
    let read = |name: &str| dir.as_ref().and_then(|d| fs::read_to_string(d.join(name)).ok());
    read("float").or_else(|| read("strip")).is_none_or(|s| s != "0")
}

fn set_float(app: &AppHandle, shown: bool) {
    if let Some(f) = app.try_state::<Floating>() {
        f.0.store(shown, Ordering::Relaxed);
    }
    pets::show_all(app, shown);
    if let Some(item) = app.try_state::<CheckMenuItem<Wry>>() {
        let _ = item.set_checked(shown);
    }
    if let Some(flag) = float_flag(app) {
        let _ = flag.parent().map(fs::create_dir_all);
        let _ = fs::write(flag, if shown { "1" } else { "0" });
    }
}

fn toggle_float(app: &AppHandle) {
    set_float(app, !floating(app));
}

fn tray(app: &AppHandle, shown: bool) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open dock", true, None::<&str>)?;
    let float = CheckMenuItem::with_id(app, "float", format!("Float agents\t{SHORTCUT}"), true, shown, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit APC Dock", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &float, &PredefinedMenuItem::separator(app)?, &quit])?;
    app.manage(float);
    let mut builder = TrayIconBuilder::with_id("tray")
        .tooltip("APC Dock")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_dock(app),
            "float" => toggle_float(app),
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
        // No opener plugin: its script takes over clicks on target=_blank links to open them over IPC,
        // which the dock page (remote, with no capability in the dock's window) cannot use, so the
        // links did nothing. Without it a click is a new window request, and on_new_window opens the
        // link (tauri_plugin_opener's open_url needs no plugin).
        .invoke_handler(tauri::generate_handler![pets::pet_agents, pets::pet_dropped, pets::pet_bubble, pets::pet_open_dock])
        .setup(|app| {
            let app = app.handle();
            dock(app)?;
            let shown = float_was_shown(app);
            app.manage(Floating(AtomicBool::new(shown)));
            tray(app, shown)?;
            // The pets resume the dock this window opens and wait for it on a first run, so both can
            // open at once (POST /api/dock with { resume: true }).
            pets::start(app, shown)?;
            // Another app may hold the shortcut already: the tray still shows and hides the pets.
            if let Err(e) = app.global_shortcut().on_shortcut(SHORTCUT, |app, _, event| {
                if event.state() == ShortcutState::Pressed {
                    toggle_float(app);
                }
            }) {
                eprintln!("{SHORTCUT} is taken: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label().starts_with(pets::PREFIX) {
                    set_float(window.app_handle(), false);
                } else {
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("the APC dock could not start");
}
