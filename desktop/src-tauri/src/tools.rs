//! The sidecars. FFmpeg runs from the bundle; yt-dlp runs from a copy in the
//! app's data directory, so its own `-U` can update it without touching the
//! signed bundle.
use std::path::{Path, PathBuf};

/// The yt-dlp to run: the copy under `dir`, refreshed from `bundled` when
/// there is none or the bundle carries a newer one (an app update).
pub fn writable_copy(bundled: &Path, dir: &Path) -> std::io::Result<PathBuf> {
    let copy = dir.join(bundled.file_name().unwrap_or_default());
    let modified = |path: &Path| std::fs::metadata(path).and_then(|m| m.modified()).ok();
    let stale = match (modified(bundled), modified(&copy)) {
        (Some(source), Some(held)) => source > held,
        (_, None) => true,
        (None, Some(_)) => false,
    };
    if stale {
        std::fs::create_dir_all(dir)?;
        let partial = copy.with_extension("partial");
        std::fs::copy(bundled, &partial)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o755))?;
        }
        std::fs::rename(&partial, &copy)?;
    }
    Ok(copy)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn touch(path: &Path, body: &[u8], age: Duration) {
        std::fs::write(path, body).unwrap();
        let file = std::fs::File::options().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - age).unwrap();
    }

    #[test]
    fn copies_the_bundled_tool_on_first_run() {
        let dir = tempfile::tempdir().unwrap();
        let bundled = dir.path().join("yt-dlp");
        touch(&bundled, b"v1", Duration::from_secs(60));
        let copy = writable_copy(&bundled, &dir.path().join("bin")).unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), b"v1");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(std::fs::metadata(&copy).unwrap().permissions().mode() & 0o111, 0);
        }
    }

    #[test]
    fn keeps_a_copy_that_updated_itself() {
        let dir = tempfile::tempdir().unwrap();
        let bundled = dir.path().join("yt-dlp");
        touch(&bundled, b"v1", Duration::from_secs(600));
        std::fs::create_dir_all(dir.path().join("bin")).unwrap();
        touch(&dir.path().join("bin").join("yt-dlp"), b"v2", Duration::from_secs(10));
        let copy = writable_copy(&bundled, &dir.path().join("bin")).unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), b"v2");
    }

    #[test]
    fn an_app_update_brings_a_newer_bundled_tool_over_the_copy() {
        let dir = tempfile::tempdir().unwrap();
        let bundled = dir.path().join("yt-dlp");
        std::fs::create_dir_all(dir.path().join("bin")).unwrap();
        touch(&dir.path().join("bin").join("yt-dlp"), b"v1", Duration::from_secs(600));
        touch(&bundled, b"v3", Duration::from_secs(10));
        let copy = writable_copy(&bundled, &dir.path().join("bin")).unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), b"v3");
    }
}
