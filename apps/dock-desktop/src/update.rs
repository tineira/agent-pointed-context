//! Signed auto-update (TIN-615). Every build of main is a version of its own (0.2.<commits on main>,
//! stamped by scripts/build.mjs; any other build is 0.1.<n>, below every release) and announces
//! itself in `latest.json` on the dock-desktop prerelease, which points at that build's own installer
//! and carries its signature (.github/workflows/dock-desktop.yml). A little after the app starts, and
//! from the tray's "Check for updates", it reads `latest.json`; for a newer build it downloads the
//! installer and checks its signature against the public key in tauri.conf.json, and only then asks
//! the person. On their yes it runs those same bytes passively (a progress bar, no questions), which
//! starts the new version when done. Downloading needs no yes; installing always does.

use std::{
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The commit this build is from (scripts/build.mjs sets it); "dev" in a plain `cargo` build.
pub const COMMIT: &str = match option_env!("APC_DOCK_COMMIT") {
    Some(commit) => commit,
    None => "dev",
};

/// How long the first check waits after the app starts, so the dock and the pets open first.
const DELAY: Duration = Duration::from_secs(20);

const TITLE: &str = "APC Dock";

/// The build, as the tray shows it: "APC dock 0.2.N (abc1234)".
pub fn label(version: &str) -> String {
    format!("APC dock {version} ({COMMIT})")
}

fn question(offered: &str, current: &str) -> String {
    format!("APC dock {offered} is ready (you have {current}). Install now?")
}

/// Whether a check is running, so a click on the tray during the startup check asks nothing twice.
struct Checking(AtomicBool);

/// Who asked: the startup check says nothing unless an update is downloaded and verified; the
/// tray's says how it went.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Asked {
    OnStart,
    FromTray,
}

/// How a check ended, before the question.
#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    CheckFailed,
    UpToDate,
    /// No network, a bad download, or a signature that does not match the key.
    DownloadFailed,
    /// Downloaded and verified: the only case that asks.
    Ready,
}

/// What the person hears about an outcome. On startup only a ready update speaks.
fn notice(outcome: &Outcome, asked: Asked, current: &str) -> Option<String> {
    match (outcome, asked) {
        (Outcome::Ready, _) | (_, Asked::OnStart) => None,
        (Outcome::CheckFailed, Asked::FromTray) => Some("Couldn't check for updates.".into()),
        (Outcome::UpToDate, Asked::FromTray) => Some(format!("APC dock {current} is up to date.")),
        (Outcome::DownloadFailed, Asked::FromTray) => Some("Couldn't download the update.".into()),
    }
}

/// The check a little after startup. Not in a debug build, which is always older than the builds of main.
pub fn start(app: &AppHandle) {
    app.manage(Checking(AtomicBool::new(false)));
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(DELAY);
        check(&app, Asked::OnStart);
    });
}

/// The tray's "Check for updates".
pub fn check_now(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || check(&app, Asked::FromTray));
}

/// Runs on a thread of its own: the download and the dialogs block it, not the app.
fn check(app: &AppHandle, asked: Asked) {
    let Some(checking) = app.try_state::<Checking>() else { return };
    if checking.0.swap(true, Ordering::AcqRel) {
        return;
    }
    let current = app.package_info().version.to_string();
    let (outcome, ready) = fetch(app, &current);
    if let Some(text) = notice(&outcome, asked, &current) {
        tell(app, &text, if outcome == Outcome::UpToDate { MessageDialogKind::Info } else { MessageDialogKind::Warning });
    }
    // Later: nothing more until the next start (or the tray).
    if let Some((update, bytes)) = ready {
        if ask(app, &update.version, &current) {
            install(app, &update, &bytes, &current);
        }
    }
    checking.0.store(false, Ordering::Release);
}

/// Reads latest.json and, for a newer build, downloads its installer; the plugin checks the
/// signature as part of the download, so only verified bytes come back.
fn fetch(app: &AppHandle, current: &str) -> (Outcome, Option<(Update, Vec<u8>)>) {
    let cleanup = app.clone();
    let updater = match app
        .updater_builder()
        // Windows: the installer is started and the app exits at once; its tray icon goes with it.
        .on_before_exit(move || cleanup.cleanup_before_exit())
        .build()
    {
        Ok(updater) => updater,
        Err(e) => {
            eprintln!("update check failed: {e}");
            return (Outcome::CheckFailed, None);
        }
    };
    let update = match tauri::async_runtime::block_on(updater.check()) {
        Ok(Some(update)) => update,
        Ok(None) => return (Outcome::UpToDate, None),
        Err(e) => {
            eprintln!("update check failed: {e}");
            return (Outcome::CheckFailed, None);
        }
    };
    let tray = app.tray_by_id("tray");
    if let Some(tray) = &tray {
        let _ = tray.set_tooltip(Some(format!("Downloading APC dock {}…", update.version)));
    }
    let bytes = tauri::async_runtime::block_on(update.download(|_, _| {}, || {}));
    if let Some(tray) = &tray {
        let _ = tray.set_tooltip(Some(label(current)));
    }
    match bytes {
        Ok(bytes) => (Outcome::Ready, Some((update, bytes))),
        Err(e) => {
            eprintln!("download of {} failed: {e}", update.version);
            (Outcome::DownloadFailed, None)
        }
    }
}

/// The person's yes: nothing is installed without it.
fn ask(app: &AppHandle, offered: &str, current: &str) -> bool {
    app.dialog()
        .message(question(offered, current))
        .title(TITLE)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Install".into(), "Later".into()))
        .blocking_show()
}

/// Runs the downloaded installer (its signature is checked again), which exits the app on Windows.
/// Only returns if that failed: the person said yes, so they hear about it.
fn install(app: &AppHandle, update: &Update, bytes: &[u8], current: &str) {
    if let Err(e) = update.install(bytes) {
        eprintln!("install of {} failed: {e}", update.version);
        tell(app, &format!("Couldn't install the update. You still have APC dock {current}."), MessageDialogKind::Warning);
    }
}


fn tell(app: &AppHandle, text: &str, kind: MessageDialogKind) {
    app.dialog().message(text).title(TITLE).kind(kind).buttons(MessageDialogButtons::Ok).blocking_show();
}

#[cfg(test)]
mod tests {
    use super::*;
    use semver::Version;
    use serde_json::Value;

    /// Where builds of main announce themselves (`plugins.updater.endpoints` in tauri.conf.json): the
    /// fixed prerelease .github/workflows/dock-desktop.yml publishes `latest.json` to.
    const ENDPOINT: &str = "https://github.com/tineira/agent-pointed-context/releases/download/dock-desktop/latest.json";

    fn config() -> Value {
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json is JSON")
    }

    #[test]
    fn every_build_of_main_is_newer_than_the_last() {
        // scripts/build.mjs: 0.2.<commits on main>. The patch compares as a number, not as text.
        let v = |s: &str| Version::parse(s).unwrap();
        assert!(v("0.2.10") > v("0.2.9"));
        assert!(v("0.2.130") > v("0.2.129"));
        // Newer than the 0.1.0 every earlier build carried, and than a plain cargo build.
        assert!(v("0.2.1") > v("0.1.0"));
        assert!(v("0.2.1") > v(config()["version"].as_str().unwrap()));
    }

    #[test]
    fn any_other_build_sorts_below_every_release() {
        // A PR, another branch or a local build is 0.1.<n>, so even one with more commits than main
        // is updated by the next build of main.
        let v = |s: &str| Version::parse(s).unwrap();
        assert!(v("0.1.99999") < v("0.2.1"));
        assert!(v(config()["version"].as_str().unwrap()) < v("0.2.0"));
    }

    #[test]
    fn on_startup_only_a_verified_update_speaks() {
        for outcome in [Outcome::CheckFailed, Outcome::UpToDate, Outcome::DownloadFailed, Outcome::Ready] {
            assert_eq!(notice(&outcome, Asked::OnStart, "0.2.5"), None, "{outcome:?}");
        }
        // Ready asks its own question, from either path.
        assert_eq!(notice(&Outcome::Ready, Asked::FromTray, "0.2.5"), None);
        assert_eq!(notice(&Outcome::CheckFailed, Asked::FromTray, "0.2.5").unwrap(), "Couldn't check for updates.");
        assert_eq!(notice(&Outcome::DownloadFailed, Asked::FromTray, "0.2.5").unwrap(), "Couldn't download the update.");
        assert_eq!(notice(&Outcome::UpToDate, Asked::FromTray, "0.2.5").unwrap(), "APC dock 0.2.5 is up to date.");
    }

    #[test]
    fn the_updater_is_configured_for_the_prerelease() {
        let c = config();
        let updater = &c["plugins"]["updater"];
        assert_eq!(updater["endpoints"], serde_json::json!([ENDPOINT]));
        assert_eq!(updater["windows"]["installMode"], "passive");
        let key = updater["pubkey"].as_str().unwrap();
        let key = String::from_utf8(base64_decode(key)).unwrap();
        assert!(key.starts_with("untrusted comment: minisign public key"), "{key}");
        assert_eq!(c["bundle"]["createUpdaterArtifacts"], true);
        // The installer's identity: an update installs over the existing install, per user as before.
        assert_eq!(c["identifier"], "com.tineira.apc.dock");
        assert_eq!(c["productName"], "APC Dock");
        assert_eq!(c["bundle"]["windows"]["nsis"]["installMode"], "currentUser");
        assert!(ENDPOINT.starts_with("https://"));
    }

    #[test]
    fn the_question_names_both_versions() {
        assert_eq!(question("0.2.140", "0.2.131"), "APC dock 0.2.140 is ready (you have 0.2.131). Install now?");
        assert!(label("0.2.131").starts_with("APC dock 0.2.131 ("));
    }

    /// Standard base64, enough to read the public key's comment.
    fn base64_decode(s: &str) -> Vec<u8> {
        const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let (mut acc, mut bits) = (0u32, 0);
        for c in s.bytes().filter(|&c| c != b'=') {
            acc = (acc << 6) | ABC.iter().position(|&a| a == c).expect("base64") as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((acc >> bits) as u8);
                acc &= (1 << bits) - 1;
            }
        }
        out
    }
}
