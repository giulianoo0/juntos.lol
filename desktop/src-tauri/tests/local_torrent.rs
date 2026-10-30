//! A real swarm into the cache: Sintel through librqbit, FFmpeg writing
//! region 0, the protocol serving it. Network and FFmpeg on PATH needed:
//! `cargo test --test local_torrent -- --ignored --nocapture`.
use std::time::{Duration, Instant};

use juntos_lib::local::{Input, Producer};
use juntos_lib::serve::serve;
use juntos_lib::torrent::Torrents;

const SINTEL: &str = "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel\
&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969\
&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F";

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn a_torrent_plays_from_the_cache() {
    let dir = tempfile::tempdir().unwrap();
    let torrents = Torrents::new(dir.path().join("torrents")).await.unwrap();
    let opened = torrents.open(SINTEL).await.unwrap();
    let video = opened.files.iter().find(|f| f.path.ends_with(".mp4")).expect("sintel.mp4");
    torrents.select(&opened.id, video.index).await.unwrap();
    let producer = Producer::new(dir.path().join("cache"), "ffmpeg".into(), "ffprobe".into(), 1 << 30);
    let key = format!("t-{}-{}", opened.id, video.index);
    let meta = producer
        .prepare(&key, "Sintel", Input::Container(torrents.source(&opened.id, video.index).unwrap()))
        .await
        .unwrap();
    println!("prepared {} ({} ms)", meta.title, meta.duration_ms);

    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        let regions = producer.regions(&key);
        println!("regions {regions:?} stats {:?}", serde_json::to_string(&torrents.stats(&opened.id)).unwrap());
        if regions.first().is_some_and(|r| r.produced_ms >= 20_000) {
            break;
        }
        assert!(Instant::now() < deadline, "region 0 never reached 20 s");
        tokio::time::sleep(Duration::from_secs(3)).await;
    }

    let master = serve(producer.root(), &format!("/{key}/hls/client_stream_0.m3u8"), None);
    assert_eq!(master.status(), 200);
    let body = String::from_utf8(master.body().clone()).unwrap();
    assert!(body.contains("cs_0_0.m4s"), "{body}");
    let segment = serve(producer.root(), &format!("/{key}/hls/cs_0_0.m4s"), Some(&"bytes=0-99".parse().unwrap()));
    assert_eq!(segment.status(), 206);
    assert_eq!(segment.body().len(), 100);

    producer.follow(&key, 400_000).await.unwrap();
    tokio::time::sleep(Duration::from_secs(20)).await;
    let regions = producer.regions(&key);
    println!("after seek {regions:?}");
    assert!(regions.iter().any(|r| r.n == 1 && r.start_ms > 390_000 && r.start_ms <= 400_000));
    producer.stop(&key).await;
}
