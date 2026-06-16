// Local-only crash + error log.
//
// We append one JSON line per event to `app_data_dir/crashes.jsonl`. The
// file rotates at `MAX_CRASH_FILE_BYTES` so a runaway loop can't fill the
// disk — the current file moves to `crashes.jsonl.1` and we start fresh.
// Older rotations are overwritten on every flip; one generation of
// history is enough for "what happened the last time the app died" and
// keeps the on-disk footprint bounded at ~10 MB total.
//
// Everything stays on the user's machine. The opt-in telemetry plumbing
// (see `src/lib/stores/telemetry.svelte.ts`) is a separate system —
// crash entries are never transmitted from here.
//
// Schema is intentionally permissive — the frontend owns the canonical
// shape (timestamp, type, message, stack?, route, profileId, userAgent,
// appVersion). We store every field that lands, including ones we don't
// model, by round-tripping through `serde_json::Value`. That way adding
// a new field on the JS side ships without touching Rust.

use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::PathBuf,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

/// Filename for the live (current) crash log inside `app_data_dir`.
const CRASH_FILE: &str = "crashes.jsonl";
/// Filename for the rotated-out previous generation.
const CRASH_FILE_ROTATED: &str = "crashes.jsonl.1";
/// 5 MB cap — once the live file passes this size on the next append,
/// rotate. Cheap upper bound; we don't bother trimming individual lines.
const MAX_CRASH_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// One crash/error/rejection event as written to disk.
///
/// `extra` captures any forward-compatible fields the frontend ships that
/// Rust doesn't model — keeps the schema evolution one-sided so we don't
/// need a Rust release every time the JS side adds a column.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrashEntry {
    /// ISO-8601 with millis. Stamped by the JS caller so it matches the
    /// browser's wall clock for the user.
    pub timestamp: String,
    /// One of: `"error"` | `"rejection"` | `"tauri-panic"`. Free-form on
    /// the wire — we don't validate, the UI knows the canonical set.
    #[serde(rename = "type")]
    pub kind: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    #[serde(rename = "profileId", default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(rename = "userAgent", default, skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    #[serde(
        rename = "appVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub app_version: Option<String>,
    /// Anything else the frontend wants to attach. Flattened on the wire
    /// so a future field like `sessionId` lands as a top-level key in
    /// the JSON line rather than nested under `extra`.
    #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, Value>,
}

fn crash_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    if let Err(e) = fs::create_dir_all(&dir) {
        return Err(format!("create app_data_dir {}: {e}", dir.display()));
    }
    Ok(dir)
}

fn crash_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crash_dir(app)?.join(CRASH_FILE))
}

fn rotated_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crash_dir(app)?.join(CRASH_FILE_ROTATED))
}

/// Move the current log to the rotated slot, replacing any prior
/// rotation. Best-effort: if the current file doesn't exist (first call,
/// or already wiped) we silently no-op so the caller's append always has
/// a clean slate to write into.
fn rotate(app: &AppHandle) -> Result<(), String> {
    let current = crash_path(app)?;
    if !current.exists() {
        return Ok(());
    }
    let rotated = rotated_path(app)?;
    // Drop the old rotation if any — `rename` on Windows wouldn't
    // overwrite by default; macOS is permissive but we'd rather have one
    // shared code path.
    if rotated.exists() {
        let _ = fs::remove_file(&rotated);
    }
    fs::rename(&current, &rotated).map_err(|e| format!("rotate {}: {e}", current.display()))?;
    Ok(())
}

/// Append a crash entry to the live log, rotating first if the file is
/// already over the size cap. Failures are returned so the IPC caller
/// can log / toast — the JS side wraps this in try/catch so crash
/// reporting never crashes the app.
pub fn write(app: &AppHandle, entry: CrashEntry) -> Result<(), String> {
    let path = crash_path(app)?;
    // Rotate eagerly if we're already past the cap. We do this before
    // serializing the new line so the line itself lands in a fresh file
    // — the alternative (rotate after write) would split a single
    // session's entries across two files.
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() >= MAX_CRASH_FILE_BYTES {
            rotate(app)?;
        }
    }
    let mut line = serde_json::to_vec(&entry).map_err(|e| format!("serialize entry: {e}"))?;
    line.push(b'\n');
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    file.write_all(&line)
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

/// Read the last `limit` entries from the live log (newest last). Lines
/// that don't parse as valid JSON are silently skipped — a half-written
/// line at the tail (e.g. process killed mid-append) shouldn't take down
/// the whole list. Doesn't touch the rotated file; callers asking for
/// recent history get the current generation only.
pub fn list(app: &AppHandle, limit: usize) -> Result<Vec<CrashEntry>, String> {
    let path = crash_path(app)?;
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let text = String::from_utf8_lossy(&bytes);
    let mut entries: Vec<CrashEntry> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<CrashEntry>(l).ok())
        .collect();
    if entries.len() > limit {
        let drop = entries.len() - limit;
        entries.drain(0..drop);
    }
    Ok(entries)
}

/// Wipe both the live log and the rotated history. Idempotent — missing
/// files are silently ignored so calling clear on a fresh install
/// doesn't surface a bogus "file not found" error.
pub fn clear(app: &AppHandle) -> Result<(), String> {
    for path in [crash_path(app)?, rotated_path(app)?] {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => return Err(format!("remove {}: {e}", path.display())),
        }
    }
    Ok(())
}

/// Return the path the live log writes to. Used by the Settings UI so
/// "View crash log" and "Reveal in Finder" can call into the shell
/// plugin with a stable target. We create the parent directory but not
/// the file itself — letting the shell open a non-existent path would
/// be confusing on a fresh install, so the UI is responsible for the
/// "no crashes yet" empty state before invoking the open path.
pub fn file_path(app: &AppHandle) -> Result<String, String> {
    Ok(crash_path(app)?.to_string_lossy().into_owned())
}
