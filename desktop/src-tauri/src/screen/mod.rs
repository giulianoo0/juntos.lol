//! Screen and window sharing from the app: the platform captures and encodes
//! H.264 on the GPU and the page publishes the access units as they come, with
//! the sound of the apps the sharer picked mixed beside them.
//!
//! Frames reach the page over a Channel in jlocal's wire format: u32 BE
//! payload length, u64 BE presentation time in µs, one flag byte (bit 0 a
//! keyframe, bit 1 the source is gone), then Annex-B. Sound is s16le 48 kHz
//! stereo in 10 ms blocks.

pub mod mix;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
mod pill;
#[cfg(windows)]
mod win;
#[cfg(windows)]
mod win_audio;
#[cfg(windows)]
mod win_video;

#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
use win as platform;
#[cfg(any(windows, target_os = "macos"))]
pub use platform::{audio_apps as list_audio_apps, sources as list_sources, Audio, Video};

use std::collections::HashSet;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};

pub const KEYFRAME: u8 = 1;
pub const ENDED: u8 = 2;
pub const SAMPLE_RATE: u32 = 48_000;
/// Frames in one 10 ms block of sound.
pub const BLOCK_FRAMES: usize = (SAMPLE_RATE / 100) as usize;

pub fn frame(pts_us: u64, flags: u8, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(13 + data.len());
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(&pts_us.to_be_bytes());
    out.push(flags);
    out.extend_from_slice(data);
    out
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub kind: TargetKind,
    pub id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TargetKind {
    Display,
    Window,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Quality {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

#[derive(Debug, Default, Serialize)]
pub struct Sources {
    pub displays: Vec<Display>,
    pub windows: Vec<Window>,
}

#[derive(Debug, Serialize)]
pub struct Display {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize)]
pub struct Window {
    pub id: String,
    pub title: String,
    pub app: String,
    pub icon: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct AudioApp {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
}

/// A process the system says is making (or holding) sound.
#[derive(Clone, Debug)]
pub struct Proc {
    pub pid: u32,
    pub parent: u32,
    pub id: String,
    pub name: String,
}

/// The apps whose sound stays out, by id, so a restarted app is the same app.
/// Every Discord client stays out unless turned on: the call would echo back.
#[derive(Clone, Debug, Default)]
pub struct Muted {
    muted: HashSet<String>,
    unmuted: HashSet<String>,
}

const DISCORD_CLIENTS: &[&str] = &["discord", "vesktop", "legcord", "armcord", "webcord", "equibop"];

pub fn starts_muted(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    DISCORD_CLIENTS.iter().any(|client| id.contains(client))
}

impl Muted {
    pub fn new(muted: Vec<String>, unmuted: Vec<String>) -> Self {
        let lower = |ids: Vec<String>| ids.into_iter().map(|id| id.to_ascii_lowercase()).collect();
        Muted { muted: lower(muted), unmuted: lower(unmuted) }
    }

    pub fn blocks(&self, id: &str) -> bool {
        let id = id.to_ascii_lowercase();
        self.muted.contains(&id) || (starts_muted(&id) && !self.unmuted.contains(&id))
    }
}

/// An app's id: its executable's name, lower case with only letters and
/// digits, the same after the app restarts.
pub fn app_id(exe: &str) -> String {
    let file = exe.rsplit(['/', '\\']).next().unwrap_or(exe);
    let stem = file.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(file);
    stem.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Whether `pid` is this app or was started by it: its webview plays the
/// room's voices, which must never go back out.
pub fn ours(pid: u32, procs: &[Proc]) -> bool {
    let me = std::process::id();
    let mut current = pid;
    for _ in 0..64 {
        if current == me {
            return true;
        }
        match procs.iter().find(|p| p.pid == current) {
            Some(p) if p.parent != 0 && p.parent != current => current = p.parent,
            _ => return false,
        }
    }
    false
}

/// The apps to offer in the sound list: one per id, none of them ours.
pub fn audible(sessions: &[Proc], procs: &[Proc]) -> Vec<AudioApp> {
    let mut seen = HashSet::new();
    sessions
        .iter()
        .filter(|p| !ours(p.pid, procs) && !p.id.is_empty())
        .filter(|p| seen.insert(p.id.clone()))
        .map(|p| AudioApp { id: p.id.clone(), name: p.name.clone(), icon: None })
        .collect()
}

pub type Sink = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

fn sink(channel: Channel<InvokeResponseBody>) -> Sink {
    Arc::new(move |bytes| {
        let _ = channel.send(InvokeResponseBody::Raw(bytes));
    })
}

#[derive(Default)]
pub struct ScreenState {
    #[cfg(any(windows, target_os = "macos"))]
    video: Mutex<Option<platform::Video>>,
    #[cfg(any(windows, target_os = "macos"))]
    audio: Mutex<Option<platform::Audio>>,
    #[cfg(not(any(windows, target_os = "macos")))]
    _none: Mutex<()>,
}

#[cfg(not(any(windows, target_os = "macos")))]
fn unsupported<T>() -> Result<T, String> {
    Err("unsupported: screen capture is not on this system yet".into())
}

#[tauri::command]
pub async fn screen_sources() -> Result<Sources, String> {
    #[cfg(any(windows, target_os = "macos"))]
    return tauri::async_runtime::spawn_blocking(platform::sources).await.map_err(|e| e.to_string())?;
    #[cfg(not(any(windows, target_os = "macos")))]
    unsupported()
}

#[tauri::command]
pub async fn screen_thumbnail(kind: TargetKind, id: String, width: u32) -> Result<String, String> {
    #[cfg(any(windows, target_os = "macos"))]
    return tauri::async_runtime::spawn_blocking(move || platform::thumbnail(&Target { kind, id }, width.clamp(64, 640)))
        .await
        .map_err(|e| e.to_string())?;
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (kind, id, width);
        unsupported()
    }
}

#[tauri::command]
pub async fn audio_apps() -> Result<Vec<AudioApp>, String> {
    #[cfg(any(windows, target_os = "macos"))]
    return tauri::async_runtime::spawn_blocking(platform::audio_apps).await.map_err(|e| e.to_string())?;
    #[cfg(not(any(windows, target_os = "macos")))]
    unsupported()
}

#[tauri::command]
pub async fn screen_start(
    state: tauri::State<'_, ScreenState>,
    target: Target,
    quality: Quality,
    frames: Channel<InvokeResponseBody>,
) -> Result<Started, String> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        if let Some(previous) = state.video.lock().take() {
            previous.stop();
        }
        let (video, started) = platform::Video::start(&target, quality, sink(frames))?;
        *state.video.lock() = Some(video);
        Ok(started)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (state, target, quality, frames);
        unsupported()
    }
}

#[tauri::command]
pub async fn screen_switch(state: tauri::State<'_, ScreenState>, target: Target) -> Result<Started, String> {
    #[cfg(any(windows, target_os = "macos"))]
    return state.video.lock().as_ref().ok_or("not_started: nothing is being shared")?.switch(&target);
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (state, target);
        unsupported()
    }
}

#[tauri::command]
pub async fn screen_quality(state: tauri::State<'_, ScreenState>, quality: Quality) -> Result<Started, String> {
    #[cfg(any(windows, target_os = "macos"))]
    return state.video.lock().as_ref().ok_or("not_started: nothing is being shared")?.quality(quality);
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (state, quality);
        unsupported()
    }
}

/// Whether the OS lets the app see the screen; only macOS asks.
#[tauri::command]
pub fn screen_permission() -> bool {
    #[cfg(target_os = "macos")]
    return pill::permitted();
    #[cfg(not(target_os = "macos"))]
    true
}

#[tauri::command]
pub async fn screen_permission_guide(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return pill::guide(&app);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

#[tauri::command]
pub async fn screen_stop(state: tauri::State<'_, ScreenState>) -> Result<(), String> {
    #[cfg(any(windows, target_os = "macos"))]
    if let Some(video) = state.video.lock().take() {
        video.stop();
    }
    let _ = state;
    Ok(())
}

#[tauri::command]
pub async fn audio_start(
    state: tauri::State<'_, ScreenState>,
    muted: Vec<String>,
    unmuted: Option<Vec<String>>,
    pcm: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        if let Some(previous) = state.audio.lock().take() {
            previous.stop();
        }
        *state.audio.lock() = Some(platform::Audio::start(Muted::new(muted, unmuted.unwrap_or_default()), sink(pcm))?);
        Ok(())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (state, muted, unmuted, pcm);
        unsupported()
    }
}

#[tauri::command]
pub async fn audio_set(state: tauri::State<'_, ScreenState>, muted: Vec<String>, unmuted: Option<Vec<String>>) -> Result<(), String> {
    #[cfg(any(windows, target_os = "macos"))]
    if let Some(audio) = state.audio.lock().as_ref() {
        audio.set_muted(Muted::new(muted, unmuted.unwrap_or_default()));
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = (state, muted, unmuted);
    Ok(())
}

#[tauri::command]
pub async fn audio_stop(state: tauri::State<'_, ScreenState>) -> Result<(), String> {
    #[cfg(any(windows, target_os = "macos"))]
    if let Some(audio) = state.audio.lock().take() {
        audio.stop();
    }
    let _ = state;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, parent: u32, id: &str) -> Proc {
        Proc { pid, parent, id: id.into(), name: id.into() }
    }

    #[test]
    fn a_frame_is_framed_like_jlocal() {
        let f = frame(1_500, KEYFRAME, &[0, 0, 0, 1, 0x65]);
        assert_eq!(&f[..4], &5u32.to_be_bytes());
        assert_eq!(&f[4..12], &1_500u64.to_be_bytes());
        assert_eq!(f[12], 1);
        assert_eq!(&f[13..], &[0, 0, 0, 1, 0x65]);
    }

    #[test]
    fn a_muted_app_stays_out_by_name_not_pid() {
        assert_eq!(app_id(r"C:\Users\x\AppData\Local\Discord\app-1.0\Discord.exe"), "discord");
        assert_eq!(app_id("VALORANT-Win64-Shipping.exe"), "valorantwin64shipping");
        let muted = Muted::new(vec!["Spotify".to_string()], vec![]);
        assert!(muted.blocks("spotify"));
        assert!(!muted.blocks("valorant"));
    }

    #[test]
    fn every_discord_starts_muted_until_turned_on() {
        let default = Muted::default();
        for id in ["discord", "discordptb", "discordcanary", "vesktop"] {
            assert!(default.blocks(id), "{id}");
        }
        let chosen = Muted::new(vec![], vec!["discordptb".to_string()]);
        assert!(!chosen.blocks("discordptb"));
        assert!(chosen.blocks("discord"));
    }

    #[test]
    fn the_app_itself_is_never_in_the_list() {
        let me = std::process::id();
        let procs = [proc(me, 1, "juntos"), proc(9001, me, "msedgewebview2"), proc(9002, 9001, "msedgewebview2"), proc(4242, 1, "chrome")];
        let sessions = [proc(9002, 9001, "msedgewebview2"), proc(4242, 1, "chrome"), proc(4243, 4242, "chrome")];
        let apps = audible(&sessions, &procs);
        assert_eq!(apps.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["chrome"]);
    }
}
