//! Lifecycle maintenance for oversized tool results persisted by the harness.

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::Path;
use std::time::{Duration, SystemTime};

/// Matches Electron's default retention period for persisted tool results.
pub const DEFAULT_TOOL_RESULT_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Remove harness-owned tool-result files whose modification time is older
/// than 24 hours.
///
/// This is intentionally an explicit, one-shot operation so the application
/// can run it once during startup without putting directory scans on every
/// tool call.
pub fn cleanup_expired_tool_results(storage_dir: &Path) -> io::Result<usize> {
    cleanup_tool_results_older_than(storage_dir, DEFAULT_TOOL_RESULT_MAX_AGE)
}

/// Remove harness-owned tool-result files older than `max_age`.
///
/// The cleanup is non-recursive and refuses a symlink as the storage root.
/// Entries that are directories, symlinks, or do not match the filename
/// emitted by `persist_tool_result` are retained.
pub fn cleanup_tool_results_older_than(storage_dir: &Path, max_age: Duration) -> io::Result<usize> {
    let root_metadata = match fs::symlink_metadata(storage_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };

    if root_metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to clean a symlinked tool-result directory",
        ));
    }
    if !root_metadata.is_dir() {
        return Ok(0);
    }

    let now = SystemTime::now();
    let mut removed = 0;
    for entry in fs::read_dir(storage_dir)? {
        let Ok(entry) = entry else {
            continue;
        };
        if !is_managed_tool_result_filename(&entry.file_name()) {
            continue;
        }

        // symlink_metadata avoids following a link even if an entry changes
        // between read_dir and this check. remove_file also unlinks rather
        // than traversing a symlink if it changes after the check.
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !metadata.file_type().is_file() {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age <= max_age {
            continue;
        }

        match fs::remove_file(entry.path()) {
            Ok(()) => removed += 1,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => {}
        }
    }

    Ok(removed)
}

/// Current persisted names are
/// `<safe-tool>_<safe-call-id>_<hyphenated-v4-uuid>.txt`. Both safe
/// components contain one to 48 ASCII filename characters. UUID validation
/// makes the ownership filter substantially narrower than a `.txt` glob.
fn is_managed_tool_result_filename(filename: &OsStr) -> bool {
    let Some(filename) = filename.to_str() else {
        return false;
    };
    let Some(stem) = filename.strip_suffix(".txt") else {
        return false;
    };
    let Some((components, uuid)) = stem.rsplit_once('_') else {
        return false;
    };

    is_canonical_v4_uuid(uuid) && has_two_safe_components(components)
}

fn has_two_safe_components(value: &str) -> bool {
    if value.len() > 48 * 2 + 1
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return false;
    }

    value.match_indices('_').any(|(separator, _)| {
        let left_len = separator;
        let right_len = value.len().saturating_sub(separator + 1);
        (1..=48).contains(&left_len) && (1..=48).contains(&right_len)
    })
}

fn is_canonical_v4_uuid(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }

    let bytes = value.as_bytes();
    for (index, byte) in bytes.iter().copied().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_digit() && !(b'a'..=b'f').contains(&byte) {
            return false;
        }
    }

    bytes[14] == b'4' && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{File, FileTimes};

    const OLD_UUID: &str = "550e8400-e29b-41d4-a716-446655440000";
    const FRESH_UUID: &str = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
    const DIRECTORY_UUID: &str = "123e4567-e89b-42d3-a456-426614174000";

    fn test_dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "worldbase-tool-result-cleanup-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn write_with_modified(path: &Path, content: &str, modified: SystemTime) {
        fs::write(path, content).unwrap();
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(FileTimes::new().set_modified(modified))
            .unwrap();
    }

    #[test]
    fn removes_only_expired_managed_files() {
        let dir = test_dir();
        fs::create_dir_all(&dir).unwrap();
        let old_time = SystemTime::now() - Duration::from_secs(25 * 60 * 60);

        let old_managed = dir.join(format!("read_file_call_1_{OLD_UUID}.txt"));
        let fresh_managed = dir.join(format!("run_command_call_2_{FRESH_UUID}.txt"));
        let unrelated = dir.join("notes.txt");
        let managed_directory = dir.join(format!("read_file_call_3_{DIRECTORY_UUID}.txt"));
        let nested_managed = dir
            .join("unrelated-directory")
            .join(format!("read_file_call_4_{DIRECTORY_UUID}.txt"));

        write_with_modified(&old_managed, "old", old_time);
        fs::write(&fresh_managed, "fresh").unwrap();
        write_with_modified(&unrelated, "keep", old_time);
        fs::create_dir(&managed_directory).unwrap();
        fs::create_dir(dir.join("unrelated-directory")).unwrap();
        write_with_modified(&nested_managed, "nested", old_time);

        assert_eq!(cleanup_expired_tool_results(&dir).unwrap(), 1);
        assert!(!old_managed.exists());
        assert!(fresh_managed.exists());
        assert!(unrelated.exists());
        assert!(managed_directory.is_dir());
        assert!(nested_managed.exists());

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_directory_is_a_noop() {
        let dir = test_dir();
        assert_eq!(cleanup_expired_tool_results(&dir).unwrap(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_entry_or_root_symlinks() {
        use std::os::unix::fs::symlink;

        let dir = test_dir();
        let storage = dir.join("storage");
        let outside = dir.join("outside");
        fs::create_dir_all(&storage).unwrap();
        fs::create_dir_all(&outside).unwrap();

        let target = outside.join("target.txt");
        let entry_link = storage.join(format!("read_file_call_1_{OLD_UUID}.txt"));
        write_with_modified(
            &target,
            "outside",
            SystemTime::now() - Duration::from_secs(25 * 60 * 60),
        );
        symlink(&target, &entry_link).unwrap();

        assert_eq!(
            cleanup_tool_results_older_than(&storage, Duration::ZERO).unwrap(),
            0
        );
        assert!(entry_link
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "outside");

        let root_link = dir.join("storage-link");
        symlink(&storage, &root_link).unwrap();
        let error = cleanup_expired_tool_results(&root_link).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(entry_link.symlink_metadata().is_ok());

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ownership_filter_matches_the_current_persistence_format() {
        assert!(is_managed_tool_result_filename(OsStr::new(&format!(
            "read_file_call_with_underscores_{OLD_UUID}.txt"
        ))));
        assert!(!is_managed_tool_result_filename(OsStr::new("notes.txt")));
        assert!(!is_managed_tool_result_filename(OsStr::new(&format!(
            "read_file_call_1_{OLD_UUID}.json"
        ))));
        assert!(!is_managed_tool_result_filename(OsStr::new(
            "read_file_call_1_550e8400-e29b-51d4-a716-446655440000.txt"
        )));
        assert!(!is_managed_tool_result_filename(OsStr::new(&format!(
            "../read_file_call_1_{OLD_UUID}.txt"
        ))));
    }
}
