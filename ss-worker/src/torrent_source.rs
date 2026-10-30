use async_trait::async_trait;
use ss_remux::torrent::TorrentFiles;
use ss_remux::SourceReader;

use crate::engine::{Engine, Prio, Reader};

#[async_trait]
impl TorrentFiles for Engine {
    fn file_size(&self, infohash: &str, index: usize) -> anyhow::Result<u64> {
        Engine::file_size(self, infohash, index)
    }

    fn read_chunk_size(&self) -> usize {
        Engine::read_chunk_size(self)
    }

    async fn open_playhead(
        &self,
        infohash: &str,
        reader: &str,
        index: usize,
        position: u64,
    ) -> anyhow::Result<Box<dyn SourceReader>> {
        let inner = self.open(infohash, reader, index, position, prio_for(reader)).await?;
        Ok(Box::new(TorrentReader(inner)))
    }
}

/// The bridge tags readers by role. A probe or the subtitle pass on the
/// playhead class would take its slot and move the window off the seek.
fn prio_for(reader: &str) -> Prio {
    match reader.split(':').next().unwrap_or("") {
        "remux-probe" => Prio::Head,
        "remux-subs" => Prio::Scan,
        _ => Prio::Playhead,
    }
}

struct TorrentReader(Reader);

#[async_trait]
impl SourceReader for TorrentReader {
    async fn read(&mut self, buf: &mut [u8]) -> anyhow::Result<usize> {
        self.0.read(buf).await
    }
}

#[cfg(test)]
mod tests {
    use super::prio_for;
    use crate::engine::Prio;

    #[test]
    fn only_the_remux_and_its_keyframe_search_read_at_the_playhead() {
        assert_eq!(prio_for("remux:run_a:0"), Prio::Playhead);
        assert_eq!(prio_for("remux-key:run_a"), Prio::Playhead);
        assert_eq!(prio_for("remux-probe:run_a"), Prio::Head);
        assert_eq!(prio_for("remux-subs:run_a"), Prio::Scan);
    }
}
