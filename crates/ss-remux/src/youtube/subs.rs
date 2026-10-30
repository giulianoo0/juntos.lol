//! YouTube subtitles arrive as whole WebVTT documents, so they are fetched
//! and published once, complete, before the video has a segment.
use std::time::Duration;

use anyhow::Context;

use super::SubtitlePick;
use crate::publish::Revoked;

const MAX_DOC_BYTES: usize = 4 << 20;
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

pub struct Publisher {
    /// Fetches the documents through the same exit as the video.
    pub client: reqwest::Client,
    /// Talks to the API.
    pub api: reqwest::Client,
    pub api_base: String,
    pub room_id: String,
    pub run_id: String,
    pub media_generation: u64,
    pub claim: String,
}

impl Publisher {
    pub async fn run(self, picks: Vec<SubtitlePick>) -> anyhow::Result<()> {
        let mut tracks = Vec::new();
        for pick in &picks {
            match self.fetch(&pick.url).await {
                Ok(vtt) => tracks.push(serde_json::json!({ "language": pick.language, "title": pick.title, "vtt": vtt })),
                Err(e) => tracing::warn!(run = %self.run_id, language = %pick.language, error = %e, "youtube subtitle skipped"),
            }
        }
        if tracks.is_empty() {
            anyhow::bail!("no subtitle document could be fetched");
        }
        let body = serde_json::json!({
            "claim": self.claim,
            "mediaGeneration": self.media_generation,
            "complete": true,
            "tracks": tracks,
        });
        let url = format!("{}/api/rooms/{}/subtitles/fleet", self.api_base, self.room_id);
        let mut last = None;
        for attempt in 0..3 {
            let response = self.api.post(&url).json(&body).send().await.context("subtitles send")?;
            let status = response.status();
            if status.is_success() {
                tracing::info!(run = %self.run_id, tracks = tracks.len(), "youtube subtitles published");
                return Ok(());
            }
            let text = response.text().await.unwrap_or_default();
            if ["claim_mismatch", "stale_generation", "room_not_found"].iter().any(|code| text.contains(code)) {
                return Err(Revoked(text.chars().take(200).collect()).into());
            }
            last = Some(anyhow::anyhow!("subtitle publish {status}: {}", text.chars().take(200).collect::<String>()));
            tokio::time::sleep(Duration::from_secs(2 * (attempt + 1))).await;
        }
        Err(last.unwrap())
    }

    async fn fetch(&self, url: &str) -> anyhow::Result<String> {
        let response = tokio::time::timeout(FETCH_TIMEOUT, self.client.get(url).send()).await.context("timeout")??;
        if !response.status().is_success() {
            anyhow::bail!("status {}", response.status());
        }
        let bytes = tokio::time::timeout(FETCH_TIMEOUT, response.bytes()).await.context("timeout")??;
        if bytes.len() > MAX_DOC_BYTES {
            anyhow::bail!("document too large");
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if !text.trim_start_matches('\u{feff}').starts_with("WEBVTT") {
            anyhow::bail!("not a WebVTT document");
        }
        Ok(text)
    }
}
