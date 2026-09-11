use axum::http::HeaderValue;

/// RFC 9110 single-range parsing: an end past the size is clamped, a start
/// at or past the size is unsatisfiable, and `bytes=-N` means the tail.
pub fn parse_range(value: Option<&HeaderValue>, size: u64) -> Result<(u64, u64), ()> {
    let Some(value) = value.and_then(|v| v.to_str().ok()) else { return Ok((0, size.saturating_sub(1))) };
    let spec = value.strip_prefix("bytes=").ok_or(())?;
    let (a, b) = spec.split_once('-').ok_or(())?;
    if a.is_empty() {
        let n: u64 = b.parse().map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        return Ok((size.saturating_sub(n), size.saturating_sub(1)));
    }
    let start: u64 = a.parse().map_err(|_| ())?;
    if start >= size {
        return Err(());
    }
    let end = if b.is_empty() { size - 1 } else { b.parse::<u64>().map_err(|_| ())?.min(size - 1) };
    if end < start {
        return Err(());
    }
    Ok((start, end))
}
