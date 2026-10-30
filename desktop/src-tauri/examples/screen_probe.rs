//! Captures the main screen for a few seconds and writes what the page would
//! get: `probe.h264` (Annex-B) and `probe.pcm` (s16le 48 kHz stereo).
//! `screen_probe [seconds] [muted app ids...]`

#[cfg(any(windows, target_os = "macos"))]
fn main() {
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    use juntos_lib::screen::{list_audio_apps, list_sources, Audio, Muted, Quality, Target, TargetKind, Video};

    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).init();
    let mut args = std::env::args().skip(1);
    let seconds: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(5);
    let muted: Vec<String> = args.collect();
    let sources = list_sources().expect("sources");
    println!("displays: {:?}", sources.displays.iter().map(|d| (&d.id, d.width, d.height)).collect::<Vec<_>>());
    println!("windows: {}", sources.windows.iter().map(|w| format!("{} [{}]{}", w.title, w.app, if w.icon.is_some() { " +icon" } else { "" })).collect::<Vec<_>>().join(" | "));
    let apps = list_audio_apps().expect("audio apps");
    println!("audio apps: {:?}", apps.iter().map(|a| (&a.id, &a.name, a.icon.is_some())).collect::<Vec<_>>());

    let video_out = Arc::new(Mutex::new(std::fs::File::create("probe.h264").unwrap()));
    let stats = Arc::new(Mutex::new((0u32, 0u32, Vec::<u64>::new())));
    let sink = {
        let (out, stats) = (video_out.clone(), stats.clone());
        Arc::new(move |bytes: Vec<u8>| {
            let flags = bytes[12];
            let pts = u64::from_be_bytes(bytes[4..12].try_into().unwrap());
            out.lock().unwrap().write_all(&bytes[13..]).unwrap();
            let mut s = stats.lock().unwrap();
            s.0 += 1;
            if flags & 1 != 0 {
                s.1 += 1;
                s.2.push(pts);
            }
        })
    };
    let target = Target { kind: TargetKind::Display, id: sources.displays[0].id.clone() };
    let quality = Quality { width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 };
    let (video, started) = Video::start(&target, quality, sink).expect("video");
    println!("started: {started:?}");
    let audio_out = Arc::new(Mutex::new(std::fs::File::create("probe.pcm").unwrap()));
    let audio = Audio::start(Muted::new(muted, vec![]), {
        let out = audio_out.clone();
        Arc::new(move |bytes: Vec<u8>| out.lock().unwrap().write_all(&bytes).unwrap())
    })
    .expect("audio");
    std::thread::sleep(std::time::Duration::from_secs(seconds));
    video.stop();
    audio.stop();
    let s = stats.lock().unwrap();
    println!("frames: {}, keyframes: {}, keyframe pts (ms): {:?}", s.0, s.1, s.2.iter().map(|p| p / 1000).collect::<Vec<_>>());
}

#[cfg(not(any(windows, target_os = "macos")))]
fn main() {}
