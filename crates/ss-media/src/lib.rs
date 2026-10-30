//! The vocabulary every run input shares: where the bytes come from and the
//! streams a run carries out of them.
pub mod plan;
pub mod range;
pub mod source;
pub mod tools;

pub use source::{ByteSource, SourceReader};
