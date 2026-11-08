//! Float per agent (TIN-698): which agents' pets show. Each agent has a "floats" mark, and the mark is
//! the source of truth; Float being on (the tray, the shortcut, the dock's Float button) only says the
//! marked agents' pets show. Marks are keyed by the agent's id (ag_…, the grant its MCP URL names),
//! which stays the same across the agent's reconnects, never by a connection. A new agent is marked, so
//! only the agents the person unmarked are kept: one that leaves the dock (its pet closes) keeps its
//! mark for when it comes back. The web dock keeps its own marks (apps/dock/src/web/float-marks.ts,
//! the same rules); nothing is sent to the hub.
//!
//! Kept in the app's config folder: whether Float is on in `float` ("1" or "0", as before TIN-698) and
//! the unmarked agents in `float-agents.json`. The tray's Float menu and the dock's window follow every
//! change: the menu is built again, and the dock's page gets an "apc-float" event.

use std::{fs, path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{ipc::CapabilityBuilder, AppHandle, Manager};

/// The most unmarked agents kept: the oldest go first.
pub const MAX_UNMARKED: usize = 200;

/// What the tray and the dock say while Float is on and none of the dock's agents is marked.
pub const NONE_SELECTED: &str = "Float on, no agents selected";

/// Whether Float is on, and the agents taken out of it. The dock's page reads it as JSON.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Marks {
    pub on: bool,
    pub unmarked: Vec<String>,
}

impl Marks {
    pub fn marked(&self, id: &str) -> bool {
        !self.unmarked.iter().any(|u| u == id)
    }

    /// Whether a pet shows: Float is on and its agent is marked (the empty dock's hint has no mark to take away).
    pub fn shows(&self, key: &str) -> bool {
        self.on && self.marked(key)
    }

    /// Marks or unmarks agents (only the dock's ids). Marking also turns Float on, so it shows at once.
    pub fn set(&mut self, ids: &[String], mark: bool) {
        let mut valid: Vec<&String> = Vec::new();
        for id in ids.iter().filter(|id| crate::pets::is_agent(id)) {
            if !valid.contains(&id) {
                valid.push(id);
            }
        }
        self.unmarked.retain(|u| !valid.contains(&u));
        if mark {
            // Only a real mark turns Float on: All in an empty dock, or a bad id, leaves it as it is.
            self.on |= !valid.is_empty();
        } else {
            self.unmarked.extend(valid.into_iter().cloned());
            let extra = self.unmarked.len().saturating_sub(MAX_UNMARKED);
            self.unmarked.drain(..extra);
        }
    }

    /// Float is on, the dock has agents, and none of them is marked: the tray and the dock say so.
    pub fn none_selected(&self, ids: &[String]) -> bool {
        self.on && !ids.is_empty() && ids.iter().all(|id| !self.marked(id))
    }
}

#[derive(Serialize, Deserialize)]
struct Saved {
    unmarked: Vec<String>,
}

/// The unmarked agents as stored: anything but the dock's ids is dropped, and repeats.
fn read_unmarked(json: &str) -> Vec<String> {
    let Ok(saved) = serde_json::from_str::<Saved>(json) else { return Vec::new() };
    let mut marks = Marks::default();
    marks.set(&saved.unmarked, false);
    marks.unmarked
}

/// The app's Float: the marks, and the dock's agents by name (from the pets' pages) for the tray.
pub struct Float {
    marks: Mutex<Marks>,
    agents: Mutex<Vec<(String, String)>>,
}

fn path(app: &AppHandle, name: &str) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(name))
}

/// Whether the pets were showing when the app last ran (shown on the first run). Builds before the pets
/// kept the same flag for the strip, as `strip`: read once when `float` is not there yet.
fn was_on(app: &AppHandle) -> bool {
    let read = |name: &str| path(app, name).and_then(|f| fs::read_to_string(f).ok());
    read("float").or_else(|| read("strip")).is_none_or(|s| s != "0")
}

fn save(app: &AppHandle, marks: &Marks) {
    if let Some(flag) = path(app, "float") {
        let _ = flag.parent().map(fs::create_dir_all);
        let _ = fs::write(flag, if marks.on { "1" } else { "0" });
    }
    let (Some(f), Ok(json)) = (path(app, "float-agents.json"), serde_json::to_string(&Saved { unmarked: marks.unmarked.clone() })) else { return };
    // To a file beside it, then renamed over it, so a crash leaves the old one (as pets.json).
    let tmp = f.with_extension("json.tmp");
    if fs::write(&tmp, json).is_ok() && fs::rename(&tmp, &f).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

/// Loads the marks, and lets the dock's window (the dock's own page, remote) read and set them.
pub fn start(app: &AppHandle) -> tauri::Result<()> {
    let unmarked = path(app, "float-agents.json").and_then(|f| fs::read_to_string(f).ok()).map(|s| read_unmarked(&s)).unwrap_or_default();
    app.manage(Float { marks: Mutex::new(Marks { on: was_on(app), unmarked }), agents: Mutex::new(Vec::new()) });
    app.add_capability(
        CapabilityBuilder::new("float")
            .remote(format!("{}/*", crate::granted().origin().ascii_serialization()))
            .window("dock")
            .permission("allow-float-state")
            .permission("allow-float-set"),
    )?;
    Ok(())
}

pub fn marks(app: &AppHandle) -> Marks {
    app.try_state::<Float>().map(|f| f.marks.lock().unwrap().clone()).unwrap_or_default()
}

/// The dock's agents as the pets' pages last listed them: (id, name), in the dock's order.
pub fn agents(app: &AppHandle) -> Vec<(String, String)> {
    app.try_state::<Float>().map(|f| f.agents.lock().unwrap().clone()).unwrap_or_default()
}

pub fn shows(app: &AppHandle, key: &str) -> bool {
    marks(app).shows(key)
}

/// Changes the marks; when they changed, saves them, shows and hides the pets to match, builds the
/// tray's menu again and tells the dock's page.
pub fn change(app: &AppHandle, f: impl FnOnce(&mut Marks)) -> Marks {
    let Some(state) = app.try_state::<Float>() else { return Marks::default() };
    let (before, after) = {
        let mut marks = state.marks.lock().unwrap();
        let before = marks.clone();
        f(&mut marks);
        // Saved under the lock, so two changes at once never share the temporary file, and the last
        // change is the last one written.
        if *marks != before {
            save(app, &marks);
        }
        (before, marks.clone())
    };
    if after != before {
        crate::pets::show_floating(app);
        crate::refresh_tray(app);
        tell_dock(app, &after);
    }
    after
}

/// The dock's agents changed (an agent was added, removed or renamed): the tray lists them anew.
pub fn set_agents(app: &AppHandle, listed: Vec<(String, String)>) {
    let Some(state) = app.try_state::<Float>() else { return };
    let changed = {
        let mut agents = state.agents.lock().unwrap();
        let changed = *agents != listed;
        *agents = listed;
        changed
    };
    if changed {
        crate::refresh_tray(app);
    }
}

/// Tells the dock's page the marks changed (from the tray, the shortcut or the page itself).
fn tell_dock(app: &AppHandle, marks: &Marks) {
    let (Some(dock), Ok(json)) = (app.get_webview_window("dock"), serde_json::to_string(marks)) else { return };
    let _ = dock.eval(format!("window.dispatchEvent(new CustomEvent(\"apc-float\", {{ detail: {json} }}))"));
}

/// The dock's page reads the marks.
#[tauri::command]
pub fn float_state(app: AppHandle) -> Marks {
    marks(&app)
}

/// The dock's page turns Float on or off, or marks or unmarks an agent (marking also turns Float on).
#[tauri::command]
pub fn float_set(app: AppHandle, on: Option<bool>, agent: Option<String>, marked: Option<bool>) -> Marks {
    change(&app, |m| {
        if let (Some(agent), Some(mark)) = (agent, marked) {
            m.set(&[agent], mark);
        }
        if let Some(on) = on {
            m.on = on;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "ag_0a";
    const B: &str = "ag_0b";
    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_new_agent_floats_by_default() {
        let m = Marks { on: true, unmarked: vec![] };
        assert!(m.shows(A) && m.shows("ag_0c"));
        // The empty dock's hint shows whenever Float is on.
        assert!(m.shows("hint"));
        assert!(!Marks::default().shows(A));
    }

    #[test]
    fn only_marked_agents_float_and_marking_turns_float_on() {
        let mut m = Marks { on: true, unmarked: vec![] };
        m.set(&ids(&[B]), false);
        assert!(m.shows(A) && !m.shows(B));
        // Unmarking never turns Float off.
        m.set(&ids(&[A]), false);
        assert!(m.on);
        let mut off = Marks { on: false, unmarked: ids(&[A, B]) };
        off.set(&ids(&[A]), true);
        assert_eq!(off, Marks { on: true, unmarked: ids(&[B]) });
        // Marking nothing (All in an empty dock, a bad id) leaves Float off.
        let mut none = Marks::default();
        none.set(&ids(&["hint"]), true);
        none.set(&[], true);
        assert!(!none.on);
    }

    #[test]
    fn a_mark_survives_a_reconnect_and_a_restart() {
        let mut m = Marks { on: true, unmarked: vec![] };
        m.set(&ids(&[B]), false);
        // B left and came back: its id is the same, so it is still unmarked.
        assert!(!m.shows(B));
        let json = serde_json::to_string(&Saved { unmarked: m.unmarked.clone() }).unwrap();
        assert_eq!(read_unmarked(&json), ids(&[B]));
    }

    #[test]
    fn float_on_with_none_marked_says_so() {
        let mut m = Marks { on: true, unmarked: vec![] };
        m.set(&ids(&[A, B]), false);
        assert!(m.none_selected(&ids(&[A, B])));
        assert!(!m.none_selected(&[]));
        assert!(!m.none_selected(&ids(&[A, B, "ag_0c"])));
        assert!(!Marks { on: false, ..m.clone() }.none_selected(&ids(&[A, B])));
    }

    #[test]
    fn stored_marks_are_only_agent_ids_without_repeats_and_bounded() {
        assert_eq!(read_unmarked("not json"), Vec::<String>::new());
        assert_eq!(read_unmarked(r#"{"unmarked":["ag_0a","ag_0a","hint","ag_../x"]}"#), ids(&[A]));
        let mut m = Marks::default();
        let many: Vec<String> = (0..MAX_UNMARKED + 5).map(|i| format!("ag_{i:x}")).collect();
        m.set(&many, false);
        assert_eq!(m.unmarked.len(), MAX_UNMARKED);
        assert_eq!(m.unmarked.last(), many.last());
    }
}
