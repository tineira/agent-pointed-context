//! Start with Windows: the tray's "Start with Windows" check writes or removes the dock's value in
//! the current user's Run key (HKCU\Software\Microsoft\Windows\CurrentVersion\Run), no admin needed.
//! A start from there carries `--autostart`, and the dock opens to the tray and its pets only.

/// The flag a start from the Run key carries: the dock window stays hidden (tray and pets only).
pub const FLAG: &str = "--autostart";
/// The value's name in the Run key.
#[cfg(windows)]
const VALUE: &str = "APC Dock";
#[cfg(windows)]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// What the Run key starts: this executable, quoted, with the flag.
pub fn command(exe: &str) -> String {
    format!("\"{exe}\" {FLAG}")
}

/// Whether a Run value starts this executable (a value left by another install path is not ours).
pub fn is_ours(value: &str, exe: &str) -> bool {
    value.trim().eq_ignore_ascii_case(&command(exe))
}

/// Whether this process was started from the Run key.
pub fn started_by_windows() -> bool {
    std::env::args().skip(1).any(|a| a == FLAG)
}

#[cfg(windows)]
fn exe() -> Option<String> {
    std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned())
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Whether Windows starts the dock at sign-in (this executable's value is in the Run key).
#[cfg(windows)]
pub fn enabled() -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let Some(exe) = exe() else { return false };
    let (key, name) = (wide(RUN_KEY), wide(VALUE));
    let mut buf = vec![0u16; 2048];
    let mut size = (buf.len() * 2) as u32;
    let ok = unsafe { RegGetValueW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr()), PCWSTR(name.as_ptr()), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut size)) };
    if ok.is_err() {
        return false;
    }
    let len = (size as usize / 2).saturating_sub(1).min(buf.len());
    is_ours(&String::from_utf16_lossy(&buf[..len]), &exe)
}

/// Turns starting with Windows on (writes the value) or off (removes it). Says whether it took.
#[cfg(windows)]
pub fn set(on: bool) -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{RegDeleteKeyValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};
    let (key, name) = (wide(RUN_KEY), wide(VALUE));
    if on {
        let Some(exe) = exe() else { return false };
        let data = wide(&command(&exe));
        let bytes = (data.len() * 2) as u32;
        unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr()), PCWSTR(name.as_ptr()), REG_SZ.0, Some(data.as_ptr().cast()), bytes) }.is_ok()
    } else {
        let r = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr()), PCWSTR(name.as_ptr())) };
        r.is_ok() || r == windows::Win32::Foundation::ERROR_FILE_NOT_FOUND
    }
}

#[cfg(not(windows))]
pub fn enabled() -> bool {
    false
}

#[cfg(not(windows))]
pub fn set(_on: bool) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_run_value_starts_this_exe_with_the_flag() {
        let exe = r"C:\Users\me\AppData\Local\APC Dock\APC Dock.exe";
        assert_eq!(command(exe), format!("\"{exe}\" --autostart"));
        assert!(is_ours(&command(exe), exe));
        assert!(is_ours(&command(exe).to_uppercase(), exe));
        // Another install path, or no flag, is not this dock's value.
        assert!(!is_ours(&command(r"D:\Other\APC Dock.exe"), exe));
        assert!(!is_ours(&format!("\"{exe}\""), exe));
    }
}
