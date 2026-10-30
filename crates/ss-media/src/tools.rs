//! The environment a tool (FFmpeg, FFprobe, yt-dlp) runs with: cleared, then
//! only what it needs handed back.
use std::ffi::OsString;

/// PATH, plus what Windows needs to start a process that opens sockets
/// (Winsock fails with error 10106 without `SystemRoot`) and that unpacks
/// itself into a temp folder (yt-dlp).
const KEPT: &[&str] = &["PATH", "SystemRoot", "windir", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA"];

/// The kept variables this process has, to pass after `env_clear`.
pub fn tool_env() -> Vec<(&'static str, OsString)> {
    KEPT.iter().filter_map(|name| std::env::var_os(name).map(|value| (*name, value))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_kept_variables_go_through() {
        let env = tool_env();
        assert!(env.iter().all(|(name, _)| KEPT.contains(name)));
        assert_eq!(env.iter().any(|(name, _)| *name == "PATH"), std::env::var_os("PATH").is_some());
    }

    #[cfg(windows)]
    #[test]
    fn windows_keeps_the_system_root() {
        assert!(tool_env().iter().any(|(name, _)| *name == "SystemRoot"));
    }
}
