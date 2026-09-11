use std::sync::Arc;

use anyhow::Context;
use async_trait::async_trait;
use ss_remux::{ByteSource, SourceReader};

use crate::engine::{Engine, Prio, Reader};

/// One file of a torrent as the remux reads it: the engine's playhead
/// reader, reopened by the bridge at every stride.
pub struct TorrentSource {
    engine: Arc<Engine>,
    infohash: String,
    file_index: usize,
    size: u64,
}

impl TorrentSource {
    pub fn new(engine: Arc<Engine>, infohash: &str, file_index: usize) -> anyhow::Result<Self> {
        let size = engine.file_size(infohash, file_index).context("unknown file")?;
        Ok(Self { engine, infohash: infohash.into(), file_index, size })
    }
}

#[async_trait]
impl ByteSource for TorrentSource {
    fn size(&self) -> u64 {
        self.size
    }

    fn chunk_size(&self) -> usize {
        self.engine.read_chunk_size()
    }

    async fn open(&self, reader: &str, position: u64) -> anyhow::Result<Box<dyn SourceReader>> {
        let inner = self.engine.open(&self.infohash, reader, self.file_index, position, Prio::Playhead).await?;
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
