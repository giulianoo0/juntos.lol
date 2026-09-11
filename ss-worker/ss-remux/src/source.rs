use async_trait::async_trait;

/// Where a run's bytes come from. The bridge serves FFmpeg any byte range of
/// it; the implementation decides how the bytes arrive (a swarm, a CDN).
#[async_trait]
pub trait ByteSource: Send + Sync {
    fn size(&self) -> u64;
    /// The read size the bridge should use per call.
    fn chunk_size(&self) -> usize {
        256 * 1024
    }
    /// A sequential reader starting at `position`. `reader` tags the caller
    /// in logs and lets a source order its work per consumer.
    async fn open(&self, reader: &str, position: u64) -> anyhow::Result<Box<dyn SourceReader>>;
}

#[async_trait]
pub trait SourceReader: Send {
    /// Reads into `buf`; zero means the source ended.
    async fn read(&mut self, buf: &mut [u8]) -> anyhow::Result<usize>;
}
