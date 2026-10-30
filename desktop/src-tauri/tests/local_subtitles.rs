//! A container's own subtitles from the cache to the room: FFmpeg pulls the
//! track while the first region is written, and the room's subtitle route
//! gets the whole of it. FFmpeg on PATH needed:
//! `cargo test --test local_subtitles -- --ignored --nocapture`.
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use juntos_lib::local::{Input, Producer};
use ss_remux::{ByteSource, SourceReader};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

struct File(PathBuf, u64);

struct Reader(tokio::fs::File);

#[async_trait::async_trait]
impl SourceReader for Reader {
    async fn read(&mut self, buf: &mut [u8]) -> anyhow::Result<usize> {
        Ok(self.0.read(buf).await?)
    }
}

#[async_trait::async_trait]
impl ByteSource for File {
    fn size(&self) -> u64 {
        self.1
    }
    async fn open(&self, _reader: &str, position: u64) -> anyhow::Result<Box<dyn SourceReader>> {
        let mut file = tokio::fs::File::open(&self.0).await?;
        file.seek(std::io::SeekFrom::Start(position)).await?;
        Ok(Box::new(Reader(file)))
    }
}

/// The room's subtitle route: keeps each body it is sent.
async fn room(posts: Arc<Mutex<Vec<serde_json::Value>>>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let posts = posts.clone();
            tokio::spawn(async move {
                let mut raw = Vec::new();
                let mut chunk = [0u8; 65536];
                loop {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    raw.extend_from_slice(&chunk[..n]);
                    let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                    let head = String::from_utf8_lossy(&raw[..end]).to_ascii_lowercase();
                    let length: usize = head.lines().find_map(|l| l.strip_prefix("content-length:")).map(|v| v.trim().parse().unwrap()).unwrap_or(0);
                    if raw.len() < end + 4 + length {
                        continue;
                    }
                    assert!(head.starts_with("post /api/rooms/r1/subtitles "), "{head}");
                    posts.lock().unwrap().push(serde_json::from_slice(&raw[end + 4..end + 4 + length]).unwrap());
                    let _ = socket.write_all(b"HTTP/1.1 201 Created\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await;
                    return;
                }
            });
        }
    });
    base
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn a_containers_subtitles_reach_the_room() {
    let dir = tempfile::tempdir().unwrap();
    let srt = dir.path().join("pt.srt");
    std::fs::write(&srt, "1\n00:00:01,000 --> 00:00:03,000\nOlá, coração – 字幕\n\n2\n00:00:20,000 --> 00:00:22,000\nFim da cena\n").unwrap();
    let mkv = dir.path().join("filme.mkv");
    let made = Command::new("ffmpeg")
        .args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-f", "lavfi", "-i", "sine=frequency=440"])
        .arg("-i")
        .arg(&srt)
        .args(["-t", "30", "-map", "0:v", "-map", "1:a", "-map", "2:s", "-c:v", "libx264", "-g", "48", "-c:a", "aac", "-c:s", "ass", "-metadata:s:s:0", "language=por", "-metadata:s:s:0", "title=Português"])
        .arg(&mkv)
        .status()
        .unwrap();
    assert!(made.success());

    let posts = Arc::new(Mutex::new(Vec::new()));
    let base = room(posts.clone()).await;
    let producer = Producer::new(dir.path().join("cache"), "ffmpeg".into(), "ffprobe".into(), 1 << 30);
    let size = std::fs::metadata(&mkv).unwrap().len();
    producer.prepare("k", "Filme", Input::Container(Arc::new(File(mkv, size)))).await.unwrap();
    producer.subtitles("k", base, "r1".into(), 2).await.unwrap();

    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let done = posts.lock().unwrap().iter().any(|p| p["complete"] == true);
        if done {
            break;
        }
        assert!(Instant::now() < deadline, "the subtitles never went out whole: {:?}", posts.lock().unwrap());
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let last = posts.lock().unwrap().last().cloned().unwrap();
    println!("{}", serde_json::to_string_pretty(&last).unwrap());
    assert!(last.get("claim").is_none());
    assert_eq!(last["mediaGeneration"], 2);
    let track = &last["tracks"][0];
    assert_eq!(track["language"], "por");
    assert_eq!(track["title"], "Português");
    let vtt = track["vtt"].as_str().unwrap();
    assert!(vtt.starts_with("WEBVTT"));
    assert!(vtt.contains("Olá, coração – 字幕"), "{vtt}");
    assert!(vtt.contains("Fim da cena"), "{vtt}");
    assert!(track["ass"].as_str().unwrap().contains("[Script Info]"));
}
