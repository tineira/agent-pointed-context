//! Float as desktop pets (TIN-479): each agent is the APC character (its logo a badge on it, TIN-483) in a small frameless window of its own,
//! on top of every window. The window loads the dock page (?view=pet&agent=<id>), so dragging a pet
//! is the page's HTML drag, as from the dock: dropped on an APC app that takes it, it points the agent.
//! A drop nothing took leaves the pet where it is. The pet moves only by its grip (TIN-484): a pill
//! above its head, shown while the mouse is over the pet, that moves the window natively
//! (start_dragging); where it is let go stays across restarts. A pairing request shows as a bubble
//! beside the pet, and the window grows for it.
//!
//! The pages tell this file which agents the dock has (pet_agents), so pets come and go with them;
//! an empty dock shows one hint pet that opens the dock. Positions are the pet's top left (the grip's
//! band and the logo below it) in physical pixels, per agent, in pets.json in the app's config folder,
//! and are kept inside a visible monitor's work area on start, after every move and when the displays
//! change.

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{ipc::CapabilityBuilder, AppHandle, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

/// A pet's width, logical px: the page's .pet-logo (the APC character, 96 px, and a margin).
pub const PET: f64 = 104.0;
/// The band above the logo the grip shows in (the page's .pet-grip, TIN-484).
const GRIP: f64 = 14.0;
/// A pet's height: the grip's band and the logo.
pub const PET_H: f64 = GRIP + PET;
/// The character inside the logo (the page's .pet-logo, less this inset): only this circle (radius LOGO_RADIUS, half its 96 px), and the bubble, take clicks. pet-pose.ts CLIP says the same, and its test keeps the drawing inside.
const LOGO_INSET: f64 = 4.0;
const LOGO_RADIUS: f64 = 48.0;
/// While the mouse is over the pet, the grip takes clicks too: this rounded box around the painted
/// pill (32 by 14 at the band's top, centred), reaching down into the circle so the cursor can go
/// from the character to the grip without leaving the window's region.
const GRIP_HIT: (f64, f64, f64, f64) = (PET / 2.0 - 18.0, 0.0, 36.0, GRIP + LOGO_INSET + 12.0);
const GRIP_RADIUS: f64 = 8.0;
const BUBBLE_RADIUS: f64 = 12.0;
/// Between the pet and its bubble (the page's --pet-gap).
const GAP: f64 = 6.0;
/// Where new pets go: down from the top right of the main screen, as the strip did.
const RIGHT: f64 = 32.0;
const TOP: f64 = 96.0;
const SPACING: f64 = 12.0;
/// The pet shown while the dock has no agents.
const HINT: &str = "hint";
/// A grip move has ended once the window has kept still this long with the button up.
const SETTLE: Duration = Duration::from_millis(300);

/// The window label prefix the pets' capability is scoped to.
pub const PREFIX: &str = "pet-";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    fn of(m: &Monitor) -> Rect {
        let a = m.work_area();
        Rect { x: a.position.x, y: a.position.y, w: a.size.width as i32, h: a.size.height as i32 }
    }
    fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
}

/// Keeps a pet (a box of `size`, its grip and logo) inside the work area.
pub fn clamp(at: (i32, i32), size: (i32, i32), area: Rect) -> (i32, i32) {
    let fit = |v: i32, lo: i32, len: i32, side: i32| v.min(lo + len - side).max(lo);
    (fit(at.0, area.x, area.w, size.0), fit(at.1, area.y, area.h, size.1))
}

/// A new pet's spot: down from the top right of the work area, the first no other pet takes; when a
/// column is full, the next one to its left.
pub fn free_spot(area: Rect, size: (i32, i32), scale: f64, taken: &[(i32, i32)]) -> (i32, i32) {
    let px = |v: f64| (v * scale).round() as i32;
    let (across, down) = (size.0 + px(SPACING), size.1 + px(SPACING));
    let (right, top) = (area.x + area.w - px(RIGHT) - size.0, area.y + px(TOP));
    let rows = ((area.h - px(TOP)) / down).max(1);
    let free = |at: (i32, i32)| taken.iter().all(|t| (t.0 - at.0).abs() >= size.0 || (t.1 - at.1).abs() >= size.1);
    (0..rows * 4)
        .map(|i| (right - (i / rows) * across, top + (i % rows) * down))
        .find(|&at| free(at))
        .map_or((right, top), |at| clamp(at, size, area))
}

/// Which way a bubble opens from its pet, as the page lays it out.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Side {
    /// The bubble reaches left of the pet (the pet at the window's right edge).
    pub left: bool,
    /// The bubble sits above the pet (the pet at the window's bottom).
    pub up: bool,
}

/// A pet window's layout, logical px: its size, the pet's place in it (its top left, the grip's
/// band above the logo) and the bubble's, if any.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Layout {
    pub size: (f64, f64),
    pub pet: (f64, f64),
    pub bubble: Option<(f64, f64, f64, f64)>,
    pub side: Side,
}

/// Lays out a pet at `at` (physical) with a bubble of `bubble` (logical): above the pet where there
/// is room, else below; towards the middle of the screen, unless that side is short.
pub fn layout(at: (i32, i32), bubble: Option<(f64, f64)>, scale: f64, area: Rect) -> Layout {
    let Some((bw, bh)) = bubble else {
        return Layout { size: (PET, PET_H), pet: (0.0, 0.0), bubble: None, side: Side { left: false, up: true } };
    };
    let (w, h) = (bw.max(PET), PET_H + GAP + bh);
    let px = |v: f64| (v * scale).round() as i32;
    let up = at.1 - px(GAP + bh) >= area.y || at.1 + px(h) > area.y + area.h;
    let fits_left = at.0 - px(w - PET) >= area.x;
    let fits_right = at.0 + px(w) <= area.x + area.w;
    let towards_left = at.0 + px(PET) / 2 > area.x + area.w / 2;
    let left = if towards_left { fits_left || !fits_right } else { !fits_right && fits_left };
    let pet = (if left { w - PET } else { 0.0 }, if up { GAP + bh } else { 0.0 });
    let rect = (if left { w - bw } else { 0.0 }, if up { 0.0 } else { PET_H + GAP }, bw, bh);
    Layout { size: (w, h), pet, bubble: Some(rect), side: Side { left, up } }
}

/// Where `place` last put a pet: its layout, the monitor's scale and the window's position.
#[derive(Clone, Copy, Debug)]
struct Placed {
    layout: Layout,
    scale: f64,
    pos: (i32, i32),
}

/// The pets' positions (as saved: a spot on a monitor that is gone stays, for when it is back),
/// bubbles, which pets the mouse is over, each window's layout and where `place` last put it, the
/// grip moves in progress (when each last moved: only these moves are saved, never one Windows or
/// `place` makes), a lock so two pages do not open the same pet at once, and one so saves do not
/// interleave.
#[derive(Default)]
pub struct Pets {
    at: Mutex<HashMap<String, (i32, i32)>>,
    bubbles: Mutex<HashMap<String, (f64, f64)>>,
    hovered: Mutex<HashSet<String>>,
    placed: Mutex<HashMap<String, Placed>>,
    moving: Mutex<HashMap<String, Instant>>,
    sync: Mutex<()>,
    saving: Mutex<()>,
}

/// The most agents a page's list opens pets for.
const MAX_PETS: usize = 32;

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("pets.json"))
}

#[derive(Serialize, Deserialize)]
struct Saved(HashMap<String, (i32, i32)>);

impl Pets {
    fn load(app: &AppHandle) -> Pets {
        let saved = file(app).and_then(|f| fs::read_to_string(f).ok()).and_then(|s| serde_json::from_str::<Saved>(&s).ok());
        Pets { at: Mutex::new(saved.map(|s| s.0).unwrap_or_default()), ..Default::default() }
    }
}

/// Writes pets.json whole: to a file beside it, then renamed over it, so a crash leaves the old one.
fn save(app: &AppHandle) {
    let (Some(f), Some(pets)) = (file(app), app.try_state::<Pets>()) else { return };
    let _one = pets.saving.lock().unwrap();
    let at: HashMap<String, (i32, i32)> = pets.at.lock().unwrap().iter().filter(|(k, _)| k.as_str() != HINT).map(|(k, v)| (k.clone(), *v)).collect();
    let _ = f.parent().map(fs::create_dir_all);
    let Ok(json) = serde_json::to_string(&Saved(at)) else { return };
    let tmp = f.with_extension("json.tmp");
    if fs::write(&tmp, json).is_ok() && fs::rename(&tmp, &f).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

/// An agent id as the dock makes them (ag_ and hex): the only names a pet window takes.
fn is_agent(id: &str) -> bool {
    id.len() <= 64 && id.strip_prefix("ag_").is_some_and(|hex| !hex.is_empty() && hex.chars().all(|c| c.is_ascii_hexdigit()))
}

fn key(window: &WebviewWindow) -> Option<String> {
    window.label().strip_prefix(PREFIX).map(str::to_string)
}

fn pet_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows().into_values().filter(|w| w.label().starts_with(PREFIX)).collect()
}

/// The monitor a point is on, else the main one.
fn monitor_at(app: &AppHandle, x: i32, y: i32) -> Option<Monitor> {
    app.monitor_from_point(x as f64, y as f64).ok().flatten().or_else(|| app.primary_monitor().ok().flatten())
}

/// A pet's size on a monitor of this scale, physical px.
fn pet_size(scale: f64) -> (i32, i32) {
    ((PET * scale).round() as i32, (PET_H * scale).round() as i32)
}

/// Puts a pet where it belongs: inside a visible monitor's work area (a new pet gets a free spot
/// near the top right), the window around the pet and its bubble, clicks only on those. Only a new
/// spot is saved: a clamped one is not, so a pet on a monitor that is unplugged or asleep goes back
/// there when it returns.
fn place(app: &AppHandle, window: &WebviewWindow) -> Option<Side> {
    let key = key(window)?;
    let state = app.state::<Pets>();
    let saved = state.at.lock().unwrap().get(&key).copied();
    let bubble = state.bubbles.lock().unwrap().get(&key).copied();
    let monitor = match saved {
        Some((x, y)) => monitor_at(app, x, y).filter(|m| Rect::of(m).contains(x, y)).or_else(|| monitor_at(app, x, y)),
        None => app.primary_monitor().ok().flatten(),
    }?;
    let (scale, area) = (monitor.scale_factor(), Rect::of(&monitor));
    let size = pet_size(scale);
    let at = match saved {
        Some(at) => clamp(at, size, area),
        None => {
            let taken: Vec<(i32, i32)> = state.at.lock().unwrap().iter().filter(|(k, _)| **k != key).map(|(_, v)| *v).collect();
            free_spot(area, size, scale, &taken)
        }
    };
    if saved.is_none() {
        state.at.lock().unwrap().insert(key.clone(), at);
        save(app);
    }
    let l = layout(at, bubble, scale, area);
    let px = |v: f64| (v * scale).round() as i32;
    let pos = (at.0 - px(l.pet.0), at.1 - px(l.pet.1));
    let hovered = state.hovered.lock().unwrap().contains(&key);
    state.placed.lock().unwrap().insert(key, Placed { layout: l, scale, pos });
    let _ = window.set_position(PhysicalPosition::new(pos.0, pos.1));
    let _ = window.set_size(PhysicalSize::new(px(l.size.0) as u32, px(l.size.1) as u32));
    shape(window, &l, scale, hovered);
    Some(l.side)
}

/// Only the logo, the grip while the mouse is over the pet, and the bubble take clicks (and show):
/// the window's region on Windows.
#[cfg(windows)]
fn shape(window: &WebviewWindow, l: &Layout, scale: f64, grip: bool) {
    use windows::Win32::Graphics::Gdi::{CombineRgn, CreateRoundRectRgn, DeleteObject, SetWindowRgn, RGN_OR};
    let Ok(hwnd) = window.hwnd() else { return };
    let px = |v: f64| (v * scale).round() as i32;
    let rounded = |x: f64, y: f64, w: f64, h: f64, r: f64| unsafe { CreateRoundRectRgn(px(x), px(y), px(x + w) + 1, px(y + h) + 1, px(2.0 * r), px(2.0 * r)) };
    let side = PET - 2.0 * LOGO_INSET;
    let (x, y) = l.pet;
    let region = rounded(x + LOGO_INSET, y + GRIP + LOGO_INSET, side, side, LOGO_RADIUS);
    let add = |(x, y, w, h): (f64, f64, f64, f64), r: f64| unsafe {
        let part = rounded(x, y, w, h, r);
        CombineRgn(Some(region), Some(region), Some(part), RGN_OR);
        let _ = DeleteObject(part.into());
    };
    if grip {
        add((x + GRIP_HIT.0, y + GRIP_HIT.1, GRIP_HIT.2, GRIP_HIT.3), GRIP_RADIUS);
    }
    if let Some(bubble) = l.bubble {
        add(bubble, BUBBLE_RADIUS);
    }
    // The system owns the region from here.
    unsafe {
        SetWindowRgn(hwnd, Some(region), true);
    }
}

#[cfg(not(windows))]
fn shape(_: &WebviewWindow, _: &Layout, _: f64, _: bool) {}

/// No title bar, ever. A click or a drag activates the pet, and tao hands WM_NCACTIVATE to
/// DefWindowProc, which paints the window's caption. With a window region the system draws no frame of
/// its own, so that caption ("APC agent" on pale blue, the classic look) lands in the transparent
/// window and stays there, cut by the logo's circle. lParam -1 tells DefWindowProc not to paint it;
/// tao still gets the message. The window has no frame (tao gives the client area all of it), so the
/// other ways to paint one, WM_NCPAINT and the theme's own caption and frame messages, paint nothing.
/// (tao's direct repaint of the caption runs only from set_theme, which the dock never calls.)
#[cfg(windows)]
fn no_title_bar(window: &WebviewWindow) {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{WM_NCACTIVATE, WM_NCPAINT};
    /// Undocumented: the theme's caption and frame painting (WM_NCUAHDRAWCAPTION, WM_NCUAHDRAWFRAME).
    const WM_NCUAHDRAWCAPTION: u32 = 0xAE;
    const WM_NCUAHDRAWFRAME: u32 = 0xAF;
    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM, _: usize, _: usize) -> LRESULT {
        match msg {
            WM_NCACTIVATE => unsafe { DefSubclassProc(hwnd, msg, w, LPARAM(-1)) },
            WM_NCPAINT | WM_NCUAHDRAWCAPTION | WM_NCUAHDRAWFRAME => LRESULT(0),
            _ => unsafe { DefSubclassProc(hwnd, msg, w, l) },
        }
    }
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let _ = SetWindowSubclass(hwnd, Some(proc), 1, 0);
        }
    }
}

#[cfg(not(windows))]
fn no_title_bar(_: &WebviewWindow) {}

/// Opens a pet (hidden unless the pets are shown), placed before it shows.
fn open(app: &AppHandle, key: &str) -> tauri::Result<WebviewWindow> {
    let label = format!("{PREFIX}{key}");
    if let Some(w) = app.get_webview_window(&label) {
        return Ok(w);
    }
    let query = if key == HINT { "view=pet".to_string() } else { format!("view=pet&agent={key}") };
    let w = crate::window(app, &label, crate::page(Some(&query)))
        .initialization_script(crate::SHELL_SCRIPT)
        .title("APC agent")
        .inner_size(PET, PET_H)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .visible(false)
        .build()?;
    // Windows keeps a new window at least ~134 px wide; a resize after it is built gets under that.
    place(app, &w);
    // A subclass is set from the window's own thread (pet_agents runs on another), and before the pet
    // shows, so no click comes first. Without it a pet only risks the title bar, so it still shows.
    // Whether the pets show is read there, not before the hop: a toggle in between is not undone.
    let (pet, handle) = (w.clone(), app.clone());
    let hooked = w.run_on_main_thread(move || {
        no_title_bar(&pet);
        if crate::floating(&handle) {
            show(&pet, true);
        }
    });
    if hooked.is_err() && crate::floating(app) {
        show(&w, true);
    }
    Ok(w)
}

/// Shows a pet without taking the focus from the window the person is in (tao's show activates the
/// window, `focused(false)` holds only for its first show), or hides it. Pets are only ever shown
/// and hidden here, so tao's own idea of their visibility stays "hidden" and never fights this.
#[cfg(windows)]
fn show(window: &WebviewWindow, shown: bool) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE, SW_SHOWNOACTIVATE};
    if let Ok(hwnd) = window.hwnd() {
        let _ = unsafe { ShowWindow(hwnd, if shown { SW_SHOWNOACTIVATE } else { SW_HIDE }) };
    }
}

#[cfg(not(windows))]
fn show(window: &WebviewWindow, shown: bool) {
    let _ = if shown { window.show() } else { window.hide() };
}

/// Shows or hides every pet. A hidden pet gets no pointerleave, so its grip stops taking clicks here.
pub fn show_all(app: &AppHandle, shown: bool) {
    if !shown {
        if let Some(state) = app.try_state::<Pets>() {
            state.hovered.lock().unwrap().clear();
        }
    }
    for w in pet_windows(app) {
        if !shown {
            reshape(app, &w);
        }
        show(&w, shown);
    }
}

/// Sets a pet's region again from its last layout (the grip's box only while the mouse is over it).
fn reshape(app: &AppHandle, window: &WebviewWindow) {
    let (Some(key), Some(state)) = (key(window), app.try_state::<Pets>()) else { return };
    let hovered = state.hovered.lock().unwrap().contains(&key);
    let placed = state.placed.lock().unwrap().get(&key).copied();
    if let Some(p) = placed {
        shape(window, &p.layout, p.scale, hovered);
    }
}

/// Drops what the app keeps for a pet window that is gone, but its saved spot.
fn forget(state: &Pets, key: &str) {
    state.hovered.lock().unwrap().remove(key);
    state.placed.lock().unwrap().remove(key);
    state.bubbles.lock().unwrap().remove(key);
    state.moving.lock().unwrap().remove(key);
}

/// Opens the pets the app had last time (the hint when none), lets their page call these commands,
/// and keeps them on a visible monitor when the displays change.
pub fn start(app: &AppHandle) -> tauri::Result<()> {
    let pets = Pets::load(app);
    let mut keys: Vec<String> = pets.at.lock().unwrap().keys().filter(|k| is_agent(k)).cloned().collect();
    app.manage(pets);
    keys.sort();
    if keys.is_empty() {
        keys.push(HINT.into());
    }
    // The pets' page is the dock's own, remote: only it, in pet windows, may call these commands
    // (pet_move moves only the window that calls it). A release build grants only the deployed dock, whatever
    // APC_DOCK_ORIGIN says; a debug build the dock it loads (a local one, say).
    let granted = if cfg!(debug_assertions) { crate::origin() } else { tauri::Url::parse(crate::DOCK_ORIGIN).expect("DOCK_ORIGIN is a URL") };
    app.add_capability(
        CapabilityBuilder::new("pets")
            .remote(format!("{}/*", granted.origin().ascii_serialization()))
            .window(format!("{PREFIX}*"))
            .permission("allow-pet-agents")
            .permission("allow-pet-bubble")
            .permission("allow-pet-grip")
            .permission("allow-pet-move")
            .permission("allow-pet-open-dock"),
    )?;
    for key in keys {
        open(app, &key)?;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last = String::new();
        loop {
            let now = app.available_monitors().map(|ms| ms.iter().map(|m| format!("{:?}{:?}{}", m.work_area(), m.size(), m.scale_factor())).collect::<String>()).unwrap_or_default();
            if !last.is_empty() && now != last {
                for w in pet_windows(&app) {
                    place(&app, &w);
                }
            }
            last = now;
            std::thread::sleep(Duration::from_secs(2));
        }
    });
    Ok(())
}

/// The dock's agents, from a pet's page on every change: one pet each, opened or closed to match.
#[tauri::command]
pub async fn pet_agents(app: AppHandle, agents: Vec<String>) -> Result<(), String> {
    let state = app.state::<Pets>();
    let _one = state.sync.lock().unwrap();
    let mut wanted: HashSet<String> = agents.into_iter().filter(|a| is_agent(a)).take(MAX_PETS).collect();
    // Saved spots of agents no longer in the dock go.
    let before = state.at.lock().unwrap().len();
    state.at.lock().unwrap().retain(|k, _| wanted.contains(k));
    if state.at.lock().unwrap().len() != before {
        save(&app);
    }
    if wanted.is_empty() {
        wanted.insert(HINT.into());
    }
    for w in pet_windows(&app) {
        let k = key(&w).unwrap_or_default();
        if !wanted.contains(&k) {
            let _ = w.destroy();
            forget(&state, &k);
        }
    }
    let mut keys: Vec<String> = wanted.into_iter().collect();
    keys.sort();
    for key in keys {
        open(&app, &key).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Whether the mouse button is still down: a grip move goes on while it is held. GetAsyncKeyState
/// reads the physical buttons: the primary one is the right with the buttons swapped.
#[cfg(windows)]
fn button_held() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};
    let primary = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 { VK_RBUTTON } else { VK_LBUTTON };
    unsafe { GetAsyncKeyState(i32::from(primary.0)) < 0 }
}

#[cfg(not(windows))]
fn button_held() -> bool {
    false
}

/// Notes a move of a pet's window and says whether it is a grip move: one in progress (pet_move
/// started it), whose time it brings up to date. Any other move (Windows' own, on a display change or
/// a DPI change, or `place`'s) is not the person's and is never saved.
fn grip_moved(moving: &mut HashMap<String, Instant>, key: &str, now: Instant) -> bool {
    moving.get_mut(key).map(|last| *last = now).is_some()
}

/// A pet window moved (WindowEvent::Moved): during a grip move, its watcher waits for it to keep still.
pub fn moved(app: &AppHandle, label: &str) {
    let (Some(key), Some(state)) = (label.strip_prefix(PREFIX), app.try_state::<Pets>()) else { return };
    grip_moved(&mut state.moving.lock().unwrap(), key, Instant::now());
}

/// Where a pet moved by its grip goes (its top left, physical px, not yet clamped), or None when the
/// window is where `place` last put it (the grip was pressed and let go without a move).
fn moved_to(pos: (i32, i32), placed: &Placed, scale: f64) -> Option<(i32, i32)> {
    let px = |v: f64| (v * scale).round() as i32;
    (pos != placed.pos).then(|| (pos.0 + px(placed.layout.pet.0), pos.1 + px(placed.layout.pet.1)))
}

/// A pet moved by its grip: its new spot, kept on the work area of the monitor it is on, is saved
/// for its agent. Says which way its bubble now opens.
fn settle(app: &AppHandle, window: &WebviewWindow) -> Option<Side> {
    let key = key(window)?;
    let pos = window.outer_position().ok()?;
    let state = app.state::<Pets>();
    let placed = state.placed.lock().unwrap().get(&key).copied()?;
    let scale = window.scale_factor().unwrap_or(placed.scale);
    let Some(at) = moved_to((pos.x, pos.y), &placed, scale) else { return Some(placed.layout.side) };
    let size = pet_size(scale);
    let monitor = monitor_at(app, at.0 + size.0 / 2, at.1 + size.1 / 2)?;
    let at = clamp(at, pet_size(monitor.scale_factor()), Rect::of(&monitor));
    state.at.lock().unwrap().insert(key, at);
    save(app);
    place(app, window)
}

/// The grip is pressed: the window that calls this (and no other) moves with the mouse until it is
/// let go and keeps still; then its spot is saved. Answers once it has, with which way the bubble now
/// opens (the move may have turned it), so the page lays the bubble out again.
#[tauri::command]
pub async fn pet_move(app: AppHandle, window: WebviewWindow) -> Option<Side> {
    let key = key(&window)?;
    app.state::<Pets>().moving.lock().unwrap().insert(key.clone(), Instant::now());
    if window.start_dragging().is_err() {
        app.state::<Pets>().moving.lock().unwrap().remove(&key);
        return None;
    }
    tauri::async_runtime::spawn_blocking(move || {
        loop {
            std::thread::sleep(SETTLE / 3);
            let state = app.state::<Pets>();
            let mut moving = state.moving.lock().unwrap();
            match moving.get(&key) {
                Some(last) if last.elapsed() < SETTLE || button_held() => continue,
                Some(_) => {
                    moving.remove(&key);
                    break;
                }
                // The window is gone.
                None => return None,
            }
        }
        settle(&app, &window)
    })
    .await
    .ok()
    .flatten()
}

/// The mouse is over the pet, or left it: while it is over, the grip takes clicks too.
#[tauri::command]
pub fn pet_grip(app: AppHandle, window: WebviewWindow, shown: bool) {
    let Some(key) = key(&window) else { return };
    let state = app.state::<Pets>();
    if shown {
        state.hovered.lock().unwrap().insert(key.clone());
    } else {
        state.hovered.lock().unwrap().remove(&key);
    }
    reshape(&app, &window);
}

/// A pairing request's bubble on this pet (its size, logical px), or none: the window grows for it
/// and shrinks back after. Says which way the bubble opens, for the page to lay it out.
#[tauri::command]
pub fn pet_bubble(app: AppHandle, window: WebviewWindow, bubble: Option<(f64, f64)>) -> Option<Side> {
    let key = key(&window)?;
    let bubble = bubble.filter(|(w, h)| (1.0..=600.0).contains(w) && (1.0..=800.0).contains(h));
    let state = app.state::<Pets>();
    match bubble {
        Some(b) => state.bubbles.lock().unwrap().insert(key.clone(), b),
        None => state.bubbles.lock().unwrap().remove(&key),
    };
    // During a grip move, placing would put the pet back on its old spot: the move's end places it,
    // with this bubble, and tells the page which way it opens then.
    if state.moving.lock().unwrap().contains_key(&key) {
        return state.placed.lock().unwrap().get(&key).map(|p| p.layout.side);
    }
    place(&app, &window)
}

/// The hint pet's click: the dock, where agents are added.
#[tauri::command]
pub fn pet_open_dock(app: AppHandle) {
    crate::show_dock(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect { x: 0, y: 0, w: 1920, h: 1032 };

    #[test]
    fn clamp_keeps_the_pet_on_the_work_area() {
        assert_eq!(clamp((100, 100), (90, 105), SCREEN), (100, 100));
        assert_eq!(clamp((-500, 2000), (90, 105), SCREEN), (0, 927));
        assert_eq!(clamp((1900, -3), (90, 105), SCREEN), (1830, 0));
        // A second monitor left of the main one.
        let left = Rect { x: -1280, y: 0, w: 1280, h: 984 };
        assert_eq!(clamp((-10, 500), (72, 84), left), (-72, 500));
    }

    #[test]
    fn new_pets_stack_down_from_the_top_right() {
        let size = (130, 148);
        let first = free_spot(SCREEN, size, 1.25, &[]);
        assert_eq!(first, (1920 - 40 - 130, 120));
        let second = free_spot(SCREEN, size, 1.25, &[first]);
        assert_eq!(second, (first.0, first.1 + 148 + 15));
        // A spot freed in the middle is taken again.
        let third = free_spot(SCREEN, size, 1.25, &[first, (second.0, second.1 + 163)]);
        assert_eq!(third, second);
        // A full column goes on to the left.
        let column: Vec<(i32, i32)> = (0..20).map(|i| (first.0, first.1 + i * 163)).collect();
        assert_eq!(free_spot(SCREEN, size, 1.25, &column), (first.0 - 145, 120));
    }

    #[test]
    fn a_pet_alone_is_its_grip_and_logo() {
        let l = layout((500, 500), None, 1.0, SCREEN);
        assert_eq!((l.size, l.pet, l.bubble), ((PET, PET_H), (0.0, 0.0), None));
    }

    #[test]
    fn the_grip_reaches_into_the_logo_and_stays_on_the_window() {
        // Inside the window's width and above the circle's bottom, overlapping its top, so the cursor
        // goes from the character to the grip without leaving the region.
        let (x, y, w, h) = GRIP_HIT;
        assert!(x >= 0.0 && x + w <= PET && y >= 0.0);
        assert!(y + h > GRIP + LOGO_INSET && y + h < GRIP + LOGO_INSET + LOGO_RADIUS);
        assert!((x + w / 2.0 - PET / 2.0).abs() < f64::EPSILON);
    }

    #[test]
    fn a_bubble_opens_above_and_towards_the_middle() {
        // Right half: above, reaching left; the pet stays at the window's bottom right.
        let l = layout((1600, 600), Some((240.0, 100.0)), 1.0, SCREEN);
        assert_eq!(l.side, Side { left: true, up: true });
        assert_eq!(l.size, (240.0, PET_H + GAP + 100.0));
        assert_eq!(l.pet, (240.0 - PET, GAP + 100.0));
        assert_eq!(l.bubble, Some((0.0, 0.0, 240.0, 100.0)));
        // Left half: reaching right.
        let l = layout((100, 600), Some((240.0, 100.0)), 1.0, SCREEN);
        assert_eq!(l.side, Side { left: false, up: true });
        assert_eq!(l.pet, (0.0, GAP + 100.0));
    }

    #[test]
    fn a_bubble_opens_below_at_the_top_and_above_at_the_bottom() {
        let l = layout((1600, 20), Some((240.0, 100.0)), 1.0, SCREEN);
        assert_eq!(l.side, Side { left: true, up: false });
        assert_eq!(l.pet, (240.0 - PET, 0.0));
        assert_eq!(l.bubble, Some((0.0, PET_H + GAP, 240.0, 100.0)));
        // At the bottom of the area, with no room below either: above.
        let l = layout((100, 940), Some((240.0, 100.0)), 1.0, SCREEN);
        assert!(l.side.up);
    }

    #[test]
    fn only_a_grip_move_is_the_persons() {
        let (start, later) = (Instant::now(), Instant::now() + Duration::from_millis(50));
        let mut moving = HashMap::new();
        // Windows moved the pet (a display or DPI change), or `place` did: not a grip move, not noted.
        assert!(!grip_moved(&mut moving, "ag_1", later));
        assert!(moving.is_empty());
        // During a grip move each move counts, and the time it last moved is kept.
        moving.insert("ag_1".to_string(), start);
        assert!(grip_moved(&mut moving, "ag_1", later));
        assert_eq!(moving["ag_1"], later);
        assert!(!grip_moved(&mut moving, "ag_2", later));
    }

    #[test]
    fn a_grip_move_lands_where_the_window_is_let_go() {
        let placed = Placed { layout: layout((500, 500), Some((240.0, 100.0)), 1.25, SCREEN), scale: 1.25, pos: (400, 300) };
        // Pressed and let go without a move: nothing to save.
        assert_eq!(moved_to((400, 300), &placed, 1.25), None);
        // The pet's top left, not the window's: the bubble's room above it is added back.
        let (dx, dy) = ((placed.layout.pet.0 * 1.25).round() as i32, (placed.layout.pet.1 * 1.25).round() as i32);
        assert!(dy > 0);
        assert_eq!(moved_to((100, 50), &placed, 1.25), Some((100 + dx, 50 + dy)));
    }

    #[test]
    fn only_agent_ids_name_a_pet() {
        assert!(is_agent("ag_0123abcdef"));
        assert!(!is_agent("ag_"));
        assert!(!is_agent("hint"));
        assert!(!is_agent("ag_12/../x"));
    }
}
