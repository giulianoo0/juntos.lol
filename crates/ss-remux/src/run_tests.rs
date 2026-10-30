//! Runs the real FFmpeg against the real bridge and sink. Skipped where
//! there is no ffmpeg on the PATH.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;

use crate::bridge::{Bridge, InputTarget};
use crate::sink::Sink;
use crate::source::{ByteSource, SourceReader};
use crate::{plan, process};

pub(crate) struct Memory(pub Arc<Vec<u8>>);

struct MemoryReader {
    bytes: Arc<Vec<u8>>,
    at: usize,
}

#[async_trait]
impl ByteSource for Memory {
    fn size(&self) -> u64 {
        self.0.len() as u64
    }
    async fn open(&self, _reader: &str, position: u64) -> anyhow::Result<Box<dyn SourceReader>> {
        Ok(Box::new(MemoryReader { bytes: self.0.clone(), at: position as usize }))
    }
}

#[async_trait]
impl SourceReader for MemoryReader {
    async fn read(&mut self, buf: &mut [u8]) -> anyhow::Result<usize> {
        let n = buf.len().min(self.bytes.len().saturating_sub(self.at));
        buf[..n].copy_from_slice(&self.bytes[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}

pub(crate) fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ss-remux-{tag}-{}-{}", std::process::id(), rand::random::<u32>()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A short source with video and audio of different lengths, so the two
/// variants end on different segments.
pub(crate) fn sample(dir: &Path) -> Option<Vec<u8>> {
    let path = dir.join("sample.mkv");
    let status = std::process::Command::new("ffmpeg")
        .args([
            "-v", "error", "-y",
            "-f", "lavfi", "-i", "testsrc=size=160x120:rate=25:duration=21",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=23",
            "-c:v", "libx264", "-g", "25", "-c:a", "aac",
        ])
        .arg(&path)
        .status()
        .ok()?;
    status.success().then(|| std::fs::read(&path).unwrap())
}

/// One whole-file run, start to exit and settled, as the drain sees it:
/// the sink and every object it closed.
pub(crate) async fn remux_whole(bytes: Vec<u8>, dir: &Path) -> (Arc<Sink>, Vec<String>) {
    let bridge = Bridge::start().await.unwrap();
    let source: Arc<dyn ByteSource> = Arc::new(Memory(Arc::new(bytes)));
    let (probe_url, probe_cap) = bridge.register_input(InputTarget { source: source.clone(), reader: "remux-probe:t".into() });
    let probe_args: Vec<String> = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", &probe_url]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let probed = process::run_capture("ffprobe", &probe_args, Duration::from_secs(30)).await.unwrap();
    bridge.revoke(&probe_cap, "");
    let source_plan = plan::plan_streams(&probed).unwrap();
    let (input_url, _) = bridge.register_input(InputTarget { source, reader: "remux:t:0".into() });
    let (sink, mut closed) = Sink::new(dir.join("spool"), 256 << 20, 64 << 20).unwrap();
    let (output, _) = bridge.register_output(sink.clone());
    let args = plan::ffmpeg_args(&[input_url], &output, "", &source_plan, plan::Start::ZERO, None, None);
    let mut ffmpeg = process::spawn("ffmpeg", &args).unwrap();
    let status = tokio::time::timeout(Duration::from_secs(60), ffmpeg.wait()).await.unwrap().unwrap();
    assert!(status.success(), "ffmpeg: {}", ffmpeg.stderr_tail.lock());
    sink.settle().await;
    sink.close_producer();
    let mut names = Vec::new();
    while let Some(object) = closed.recv().await {
        names.push(object.name);
    }
    (sink, names)
}

fn have_ffmpeg() -> bool {
    std::process::Command::new("ffmpeg").arg("-version").output().is_ok_and(|o| o.status.success())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_finished_run_leaves_every_playlist_ended() {
    if !have_ffmpeg() {
        eprintln!("no ffmpeg; skipped");
        return;
    }
    let dir = scratch("endlist");
    let bytes = sample(&dir).expect("sample");
    for attempt in 0..6 {
        let (sink, closed) = remux_whole(bytes.clone(), &dir.join(attempt.to_string())).await;
        let manifests = sink.manifests();
        for name in ["client_stream_0.m3u8", "client_stream_1.m3u8"] {
            let body = manifests.get(name).unwrap_or_else(|| panic!("attempt {attempt}: no {name}"));
            assert!(body.contains("#EXT-X-ENDLIST"), "attempt {attempt}: {name} without ENDLIST:\n{body}");
            for segment in body.lines().filter(|l| l.ends_with(".m4s")) {
                assert!(closed.iter().any(|c| c == segment), "attempt {attempt}: {segment} listed but never closed");
            }
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}
