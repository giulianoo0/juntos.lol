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
        let inner = self.open(infohash, reader, index, position, Prio::Playhead).await?;
        Ok(Box::new(TorrentReader(inner)))
    }
}

struct TorrentReader(Reader);

#[async_trait]
impl SourceReader for TorrentReader {
    async fn read(&mut self, buf: &mut [u8]) -> anyhow::Result<usize> {
        self.0.read(buf).await
    }
}
