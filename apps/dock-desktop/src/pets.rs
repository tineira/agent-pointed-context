//! Float as desktop pets (TIN-479): each agent is the APC character (its logo a badge on it, TIN-483) in a small frameless window of its own,
//! on top of every window. The window loads the dock page (?view=pet&agent=<id>), so dragging a pet
//! is the page's HTML drag, as from the dock: dropped on an APC app that takes it, it points the agent.
//! A drop nothing took (dropEffect "none") moves the pet to the cursor instead, and it stays there
//! across restarts. A pairing request shows as a bubble beside the pet, and the window grows for it.
//!
//! The pages tell this file which agents the dock has (pet_agents), so pets come and go with them;
//! an empty dock shows one hint pet that opens the dock. Positions are the logo's top left in
//! physical pixels, per agent, in pets.json in the app's config folder, and are kept inside a
//! visible monitor's work area on start, on every drop, and when the displays change.

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    sync::Mutex,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{ipc::CapabilityBuilder, AppHandle, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

/// A pet window, logical px: the page's .pet-logo (the APC character, 96 px, and a margin).
pub const PET: f64 = 104.0;
/// The character inside it (the page's .pet-logo, less this inset): only this circle (radius LOGO_RADIUS, half its 96 px), and the bubble, take clicks. pet-pose.ts CLIP says the same, and its test keeps the drawing inside.
const LOGO_INSET: f64 = 4.0;
const LOGO_RADIUS: f64 = 48.0;
const BUBBLE_RADIUS: f64 = 12.0;
/// Between the logo and its bubble (the page's --pet-gap).
const GAP: f64 = 6.0;
/// Where new pets go: down from the top right of the main screen, as the strip did.
const RIGHT: f64 = 32.0;
const TOP: f64 = 96.0;
const SPACING: f64 = 12.0;
/// The pet shown while the dock has no agents.
const HINT: &str = "hint";

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

/// Keeps a pet's logo (a square of `size`) inside the work area.
pub fn clamp(at: (i32, i32), size: i32, area: Rect) -> (i32, i32) {
    let fit = |v: i32, lo: i32, len: i32| v.min(lo + len - size).max(lo);
    (fit(at.0, area.x, area.w), fit(at.1, area.y, area.h))
}

/// A new pet's spot: down from the top right of the work area, the first no other pet takes; when a
/// column is full, the next one to its left.
pub fn free_spot(area: Rect, size: i32, scale: f64, taken: &[(i32, i32)]) -> (i32, i32) {
    let px = |v: f64| (v * scale).round() as i32;
    let step = size + px(SPACING);
    let (right, top) = (area.x + area.w - px(RIGHT) - size, area.y + px(TOP));
    let rows = ((area.h - px(TOP)) / step).max(1);
    let free = |at: (i32, i32)| taken.iter().all(|t| (t.0 - at.0).abs() >= size || (t.1 - at.1).abs() >= size);
    (0..rows * 4)
        .map(|i| (right - (i / rows) * step, top + (i % rows) * step))
        .find(|&at| free(at))
        .map_or((right, top), |at| clamp(at, size, area))
}

/// Which way a bubble opens from its pet, as the page lays it out.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Side {
    /// The bubble reaches left of the logo (the logo at the window's right edge).
    pub left: bool,
    /// The bubble sits above the logo (the logo at the window's bottom).
    pub up: bool,
}

/// A pet window's layout, logical px: its size, the logo's place in it and the bubble's, if any.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Layout {
    pub size: (f64, f64),
    pub logo: (f64, f64),
    pub bubble: Option<(f64, f64, f64, f64)>,
    pub side: Side,
}

/// Lays out a pet whose logo is at `at` (physical) with a bubble of `bubble` (logical): above the
/// logo where there is room, else below; towards the middle of the screen, unless that side is short.
pub fn layout(at: (i32, i32), bubble: Option<(f64, f64)>, scale: f64, area: Rect) -> Layout {
    let Some((bw, bh)) = bubble else {
        return Layout { size: (PET, PET), logo: (0.0, 0.0), bubble: None, side: Side { left: false, up: true } };
    };
    let (w, h) = (bw.max(PET), PET + GAP + bh);
    let px = |v: f64| (v * scale).round() as i32;
    let up = at.1 - px(GAP + bh) >= area.y || at.1 + px(h) > area.y + area.h;
    let fits_left = at.0 - px(w - PET) >= area.x;
    let fits_right = at.0 + px(w) <= area.x + area.w;
    let towards_left = at.0 + px(PET) / 2 > area.x + area.w / 2;
    let left = if towards_left { fits_left || !fits_right } else { !fits_right && fits_left };
    let logo = (if left { w - PET } else { 0.0 }, if up { GAP + bh } else { 0.0 });
    let rect = (if left { w - bw } else { 0.0 }, if up { 0.0 } else { PET + GAP }, bw, bh);
    Layout { size: (w, h), logo, bubble: Some(rect), side: Side { left, up } }
}

/// The pets' positions (as saved: a spot on a monitor that is gone stays, for when it is back) and
/// bubbles, a lock so two pages do not open the same pet at once, and one so saves do not interleave.
#[derive(Default)]
pub struct Pets {
    at: Mutex<HashMap<String, (i32, i32)>>,
    bubbles: Mutex<HashMap<String, (f64, f64)>>,
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

/// Puts a pet where it belongs: its logo inside a visible monitor's work area (a new pet gets a free
/// spot near the top right), the window around the logo and its bubble, clicks only on those. Only
/// a new spot is saved: a clamped one is not, so a pet on a monitor that is unplugged or asleep goes
/// back there when it returns.
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
    let size = (PET * scale).round() as i32;
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
    let _ = window.set_position(PhysicalPosition::new(at.0 - px(l.logo.0), at.1 - px(l.logo.1)));
    let _ = window.set_size(PhysicalSize::new(px(l.size.0) as u32, px(l.size.1) as u32));
    shape(window, &l, scale);
    Some(l.side)
}

/// Only the logo and the bubble take clicks (and show): the window's region on Windows.
#[cfg(windows)]
fn shape(window: &WebviewWindow, l: &Layout, scale: f64) {
    use windows::Win32::Graphics::Gdi::{CombineRgn, CreateRoundRectRgn, DeleteObject, SetWindowRgn, RGN_OR};
    let Ok(hwnd) = window.hwnd() else { return };
    let px = |v: f64| (v * scale).round() as i32;
    let rounded = |x: f64, y: f64, w: f64, h: f64, r: f64| unsafe { CreateRoundRectRgn(px(x), px(y), px(x + w) + 1, px(y + h) + 1, px(2.0 * r), px(2.0 * r)) };
    let side = PET - 2.0 * LOGO_INSET;
    let region = rounded(l.logo.0 + LOGO_INSET, l.logo.1 + LOGO_INSET, side, side, LOGO_RADIUS);
    unsafe {
        if let Some((x, y, w, h)) = l.bubble {
            let bubble = rounded(x, y, w, h, BUBBLE_RADIUS);
            CombineRgn(Some(region), Some(region), Some(bubble), RGN_OR);
            let _ = DeleteObject(bubble.into());
        }
        // The system owns the region from here.
        SetWindowRgn(hwnd, Some(region), true);
    }
}

#[cfg(not(windows))]
fn shape(_: &WebviewWindow, _: &Layout, _: f64) {}

/// Opens a pet (hidden unless the pets are shown), placed before it shows.
fn open(app: &AppHandle, key: &str, shown: bool) -> tauri::Result<WebviewWindow> {
    let label = format!("{PREFIX}{key}");
    if let Some(w) = app.get_webview_window(&label) {
        return Ok(w);
    }
    let query = if key == HINT { "view=pet".to_string() } else { format!("view=pet&agent={key}") };
    let w = crate::window(app, &label, crate::page(Some(&query)))
        .initialization_script(crate::SHELL_SCRIPT)
        .title("APC agent")
        .inner_size(PET, PET)
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
    if shown {
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

/// Shows or hides every pet.
pub fn show_all(app: &AppHandle, shown: bool) {
    for w in pet_windows(app) {
        show(&w, shown);
    }
}

/// Opens the pets the app had last time (the hint when none), lets their page call these commands,
/// and keeps them on a visible monitor when the displays change.
pub fn start(app: &AppHandle, shown: bool) -> tauri::Result<()> {
    let pets = Pets::load(app);
    let mut keys: Vec<String> = pets.at.lock().unwrap().keys().filter(|k| is_agent(k)).cloned().collect();
    app.manage(pets);
    keys.sort();
    if keys.is_empty() {
        keys.push(HINT.into());
    }
    // The pets' page is the dock's own, remote: only it, in pet windows, may call these commands. A
    // release build grants only the deployed dock, whatever APC_DOCK_ORIGIN says; a debug build the
    // dock it loads (a local one, say).
    let granted = if cfg!(debug_assertions) { crate::origin() } else { tauri::Url::parse(crate::DOCK_ORIGIN).expect("DOCK_ORIGIN is a URL") };
    app.add_capability(
        CapabilityBuilder::new("pets")
            .remote(format!("{}/*", granted.origin().ascii_serialization()))
            .window(format!("{PREFIX}*"))
            .permission("allow-pet-agents")
            .permission("allow-pet-dropped")
            .permission("allow-pet-bubble")
            .permission("allow-pet-open-dock"),
    )?;
    for key in keys {
        open(app, &key, shown)?;
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
        if key(&w).is_none_or(|k| !wanted.contains(&k)) {
            let _ = w.destroy();
        }
    }
    let shown = crate::floating(&app);
    let mut keys: Vec<String> = wanted.into_iter().collect();
    keys.sort();
    for key in keys {
        open(&app, &key, shown).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Whether the mouse button is still down: a drag cancelled with Esc ends while it is held, a drop
/// when it is let go. GetAsyncKeyState reads the physical buttons: the primary one is the right
/// with the buttons swapped.
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

/// A drag of this pet ended and nothing took it: the pet goes where the cursor is, with the point it
/// was held by (`grab`, CSS px from the logo's top left) under it. Not when the cursor is still on
/// the pet (a short drag), nor when the button is still held (Esc). Says whether it moved.
#[tauri::command]
pub fn pet_dropped(app: AppHandle, window: WebviewWindow, grab: (f64, f64)) -> bool {
    let Some(key) = key(&window) else { return false };
    if button_held() {
        return false;
    }
    let (Ok(c), Ok(pos), Ok(size)) = (app.cursor_position(), window.outer_position(), window.outer_size()) else { return false };
    let (x, y) = (c.x.round() as i32, c.y.round() as i32);
    if (pos.x..pos.x + size.width as i32).contains(&x) && (pos.y..pos.y + size.height as i32).contains(&y) {
        return false;
    }
    let scale = monitor_at(&app, x, y).map_or(1.0, |m| m.scale_factor());
    // The page's point, kept on the logo (NaN goes to 0).
    let held = |v: f64| (v.clamp(0.0, PET) * scale).round() as i32;
    let at = (x.saturating_sub(held(grab.0)), y.saturating_sub(held(grab.1)));
    app.state::<Pets>().at.lock().unwrap().insert(key, at);
    save(&app);
    place(&app, &window);
    true
}

/// A pairing request's bubble on this pet (its size, logical px), or none: the window grows for it
/// and shrinks back after. Says which way the bubble opens, for the page to lay it out.
#[tauri::command]
pub fn pet_bubble(app: AppHandle, window: WebviewWindow, bubble: Option<(f64, f64)>) -> Option<Side> {
    let key = key(&window)?;
    let bubble = bubble.filter(|(w, h)| (1.0..=600.0).contains(w) && (1.0..=800.0).contains(h));
    match bubble {
        Some(b) => app.state::<Pets>().bubbles.lock().unwrap().insert(key, b),
        None => app.state::<Pets>().bubbles.lock().unwrap().remove(&key),
    };
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
    fn clamp_keeps_the_logo_on_the_work_area() {
        assert_eq!(clamp((100, 100), 90, SCREEN), (100, 100));
        assert_eq!(clamp((-500, 2000), 90, SCREEN), (0, 942));
        assert_eq!(clamp((1900, -3), 90, SCREEN), (1830, 0));
        // A second monitor left of the main one.
        let left = Rect { x: -1280, y: 0, w: 1280, h: 984 };
        assert_eq!(clamp((-10, 500), 72, left), (-72, 500));
    }

    #[test]
    fn new_pets_stack_down_from_the_top_right() {
        let first = free_spot(SCREEN, 90, 1.25, &[]);
        assert_eq!(first, (1920 - 40 - 90, 120));
        let second = free_spot(SCREEN, 90, 1.25, &[first]);
        assert_eq!(second, (first.0, first.1 + 90 + 15));
        // A spot freed in the middle is taken again.
        let third = free_spot(SCREEN, 90, 1.25, &[first, (second.0, second.1 + 105)]);
        assert_eq!(third, second);
        // A full column goes on to the left.
        let column: Vec<(i32, i32)> = (0..20).map(|i| (first.0, first.1 + i * 105)).collect();
        assert_eq!(free_spot(SCREEN, 90, 1.25, &column), (first.0 - 105, 120));
    }

    #[test]
    fn a_pet_alone_is_its_logo() {
        let l = layout((500, 500), None, 1.0, SCREEN);
        assert_eq!((l.size, l.logo, l.bubble), ((PET, PET), (0.0, 0.0), None));
    }

    #[test]
    fn a_bubble_opens_above_and_towards_the_middle() {
        // Right half: above, reaching left; the logo stays at the window's bottom right.
        let l = layout((1600, 600), Some((240.0, 100.0)), 1.0, SCREEN);
        assert_eq!(l.side, Side { left: true, up: true });
        assert_eq!(l.size, (240.0, PET + GAP + 100.0));
        assert_eq!(l.logo, (240.0 - PET, GAP + 100.0));
        assert_eq!(l.bubble, Some((0.0, 0.0, 240.0, 100.0)));
        // Left half: reaching right.
        let l = layout((100, 600), Some((240.0, 100.0)), 1.0, SCREEN);
        assert_eq!(l.side, Side { left: false, up: true });
        assert_eq!(l.logo, (0.0, GAP + 100.0));
    }

    #[test]
    fn a_bubble_opens_below_at_the_top_and_above_at_the_bottom() {
        let l = layout((1600, 20), Some((240.0, 100.0)), 1.0, SCREEN);
        assert_eq!(l.side, Side { left: true, up: false });
        assert_eq!(l.logo, (240.0 - PET, 0.0));
        assert_eq!(l.bubble, Some((0.0, PET + GAP, 240.0, 100.0)));
        // At the bottom of the area, with no room below either: above.
        let l = layout((100, 960), Some((240.0, 100.0)), 1.0, SCREEN);
        assert!(l.side.up);
    }

    #[test]
    fn only_agent_ids_name_a_pet() {
        assert!(is_agent("ag_0123abcdef"));
        assert!(!is_agent("ag_"));
        assert!(!is_agent("hint"));
        assert!(!is_agent("ag_12/../x"));
    }
}
