//! The APC dock for Windows (#84): the web dock (apc.tineira.com/dock) in a window of its own,
//! and its agents as desktop pets (TIN-479, pets.rs): each agent's character in a small window of
//! its own on top of every window, moved by a grip shown on hover (TIN-484), all shown and hidden
//! with a global shortcut or from the tray. The pages are the web dock's own, so the hub, pairing
//! and the drag are unchanged; only the windows are native. Closing a window hides it; Quit is in
//! the tray. The tray names the build and checks for updates; a little after it starts the app checks
//! too, and updates itself on the person's yes (TIN-615, update.rs). Which agents float is the person's
//! choice, per agent, from the tray's Float menu or the dock (TIN-698, float.rs).
//!
//! APC_DOCK_ORIGIN points it at another dock (a local `pnpm --dir apps/dock dev`, say).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod float;
mod pets;
mod update;

use tauri::{
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::NewWindowResponse,
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Shows and hides the pets; the dock page names it too (DESKTOP_SHORTCUT in apps/dock/src/web/setup.tsx).
const SHORTCUT: &str = "Alt+Shift+Space";

/// The deployed dock: the only origin a release build lets the pets' page call the app (pets.rs).
const DOCK_ORIGIN: &str = "https://apc.tineira.com";

fn origin() -> Url {
    let dock = std::env::var("APC_DOCK_ORIGIN").unwrap_or_else(|_| DOCK_ORIGIN.into());
    Url::parse(&dock).expect("APC_DOCK_ORIGIN is a URL")
}

/// The dock pages that may call the app's commands (the pets', float.rs's): a release build grants only
/// the deployed dock, whatever APC_DOCK_ORIGIN says; a debug build the dock it loads (a local one, say).
fn granted() -> Url {
    if cfg!(debug_assertions) {
        origin()
    } else {
        Url::parse(DOCK_ORIGIN).expect("DOCK_ORIGIN is a URL")
    }
}

/// The dock page, or with view=pet a pet.
fn page(query: Option<&str>) -> Url {
    let mut url = origin();
    url.set_path("/dock");
    url.set_query(query);
    url
}

/// Whether a window may go to this address: the dock's own pages stay; a link out of the dock
/// (Pulse, Signals, downloads, extension installation) opens in the person's browser instead.
/// Any other address (file:, mailto:, an app's own scheme) goes nowhere.
fn stays(url: &Url) -> bool {
    match url.scheme() {
        "about" | "blob" => true,
        "http" | "https"
            if url.origin() == origin().origin() && url.path().trim_end_matches('/') != "/extension" => true,
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

fn toggle_float(app: &AppHandle) {
    float::change(app, |m| m.on = !m.on);
}

/// The tray's id for an agent's item in the Float menu.
const AGENT_ITEM: &str = "float-agent:";

/// An agent's name as a menu item: "&" would underline the next letter, a tab would start a shortcut.
fn menu_text(name: &str) -> String {
    let clean: String = name.chars().filter(|c| !c.is_control()).take(40).collect();
    clean.replace('&', "&&")
}

/// The tray's Float menu (TIN-698): Float on, a check per agent in the dock, All and None. While Float
/// is on with no agent marked, its first item says so.
fn float_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let (marks, agents) = (float::marks(app), float::agents(app));
    let ids: Vec<String> = agents.iter().map(|(id, _)| id.clone()).collect();
    let on = if marks.none_selected(&ids) { float::NONE_SELECTED } else { "Float on" };
    let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = vec![
        Box::new(CheckMenuItem::with_id(app, "float", format!("{on}\t{SHORTCUT}"), true, marks.on, None::<&str>)?),
        Box::new(PredefinedMenuItem::separator(app)?),
    ];
    for (id, name) in &agents {
        items.push(Box::new(CheckMenuItem::with_id(app, format!("{AGENT_ITEM}{id}"), menu_text(name), true, marks.marked(id), None::<&str>)?));
    }
    if agents.is_empty() {
        items.push(Box::new(MenuItem::with_id(app, "float-empty", "No agents in your dock", false, None::<&str>)?));
    }
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(MenuItem::with_id(app, "float-all", "All", !agents.is_empty(), None::<&str>)?));
    items.push(Box::new(MenuItem::with_id(app, "float-none", "None", !agents.is_empty(), None::<&str>)?));
    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|i| i.as_ref()).collect();
    Submenu::with_items(app, "Float", true, &refs)
}

fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    // The build, greyed out at the top: "APC dock 0.2.N (abc1234)" (TIN-615).
    let build = update::label(&app.package_info().version.to_string());
    let about = MenuItem::with_id(app, "build", &build, false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open dock", true, None::<&str>)?;
    let float = float_menu(app)?;
    let updates = MenuItem::with_id(app, "update", "Check for updates", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit APC Dock", true, None::<&str>)?;
    Menu::with_items(
        app,
        &[&about, &PredefinedMenuItem::separator(app)?, &open, &float, &PredefinedMenuItem::separator(app)?, &updates, &quit],
    )
}

/// Builds the tray's menu again, after Float or the dock's agents changed (float.rs). On the main thread,
/// where the menu lives: the dock's pages ask for changes from other threads.
fn refresh_tray(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let (Some(tray), Ok(menu)) = (handle.tray_by_id("tray"), tray_menu(&handle)) {
            let _ = tray.set_menu(Some(menu));
        }
    });
}

/// A click in the tray's Float menu. Ticking an agent marks it and turns Float on, as in the dock.
fn float_event(app: &AppHandle, id: &str) {
    let ids = || float::agents(app).into_iter().map(|(id, _)| id).collect::<Vec<_>>();
    let before = float::marks(app);
    match id {
        "float" => {
            toggle_float(app);
        }
        "float-all" => {
            let all = ids();
            float::change(app, |m| m.set(&all, true));
        }
        "float-none" => {
            let all = ids();
            float::change(app, |m| m.set(&all, false));
        }
        _ => {
            if let Some(agent) = id.strip_prefix(AGENT_ITEM) {
                let agent = agent.to_string();
                float::change(app, |m| {
                    let mark = !m.marked(&agent);
                    m.set(&[agent], mark);
                });
            }
        }
    }
    // A check item ticks itself when clicked: when nothing changed (float::change builds the menu again
    // when something did), the menu is built again anyway so it shows the marks as they are.
    if float::marks(app) == before {
        refresh_tray(app);
    }
}

fn tray(app: &AppHandle) -> tauri::Result<()> {
    let build = update::label(&app.package_info().version.to_string());
    let menu = tray_menu(app)?;
    let mut builder = TrayIconBuilder::with_id("tray")
        .tooltip(&build)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_dock(app),
            "update" => update::check_now(app),
            "quit" => app.exit(0),
            id if id == "float" || id.starts_with("float-") => float_event(app, id),
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
        // The update's question (update.rs); plugins.updater in tauri.conf.json: the endpoint, the key, passive.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // No opener plugin: its script takes over clicks on target=_blank links to open them over IPC,
        // which the dock page (remote, with no capability in the dock's window) cannot use, so the
        // links did nothing. Without it a click is a new window request, and on_new_window opens the
        // link (tauri_plugin_opener's open_url needs no plugin).
        .invoke_handler(tauri::generate_handler![pets::pet_agents, pets::pet_bubble, pets::pet_grip, pets::pet_move, pets::pet_open_dock, float::float_state, float::float_set])
        .setup(|app| {
            let app = app.handle();
            float::start(app)?;
            dock(app)?;
            tray(app)?;
            // The pets resume the dock this window opens and wait for it on a first run, so both can
            // open at once (POST /api/dock with { resume: true }).
            pets::start(app)?;
            // Another app may hold the shortcut already: the tray still shows and hides the pets.
            if let Err(e) = app.global_shortcut().on_shortcut(SHORTCUT, |app, _, event| {
                if event.state() == ShortcutState::Pressed {
                    toggle_float(app);
                }
            }) {
                eprintln!("{SHORTCUT} is taken: {e}");
            }
            update::start(app);
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if window.label().starts_with(pets::PREFIX) {
                    float::change(window.app_handle(), |m| m.on = false);
                } else {
                    let _ = window.hide();
                }
            }
            // A pet moved by its grip (TIN-484): its spot is saved once it settles.
            WindowEvent::Moved(_) => pets::moved(window.app_handle(), window.label()),
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("the APC dock could not start");
}
