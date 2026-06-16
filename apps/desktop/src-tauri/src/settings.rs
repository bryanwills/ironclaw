// App settings persisted as a JSON file in the platform AppData directory.
//
// The bearer token is intentionally NOT in this file — it lives in the
// macOS Keychain via the `keychain` module.
//
// We round-trip the settings blob as a raw `serde_json::Value` so the
// frontend owns the schema (including the profile shape introduced in
// the Profiles system). This keeps schema migrations + defaults in one
// place (the JS side) and means the Rust process doesn't need to know
// about new fields like `profiles[]` to load + save the file faithfully.

use std::{
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};

use serde_json::Value;
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "settings.json";

/// Opaque settings payload — JS owns the schema. Rust treats the file as
/// a JSON blob that round-trips cleanly via Tauri IPC.
pub type AppSettings = Value;

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    if let Err(e) = fs::create_dir_all(&dir) {
        return Err(format!("create app_data_dir {}: {e}", dir.display()));
    }
    Ok(dir.join(SETTINGS_FILE))
}

pub fn load(app: &AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    match fs::read(&path) {
        Ok(bytes) => {
            serde_json::from_slice::<Value>(&bytes).map_err(|e| format!("parse settings.json: {e}"))
        }
        // First-run: return an empty object. JS layer will overlay defaults.
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(Value::Object(Default::default())),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

pub fn save(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let bytes = serde_json::to_vec_pretty(settings).map_err(|e| format!("serialize: {e}"))?;
    atomic_write(&path, &bytes)
}

/// Write `bytes` to `path` atomically: serialize into a sibling temp file,
/// flush + `fsync` it, then rename over the target. A crash or power loss
/// mid-write can then only ever leave the previous file or the complete new
/// file in place — never a truncated/half-written `settings.json`. (Codex
/// audit P0; the JS cache already adopts new state only after this IPC
/// resolves, so the two layers together never desync on a failed write.)
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
        f.write_all(bytes)
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        f.sync_all()
            .map_err(|e| format!("fsync {}: {e}", tmp.display()))?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        // A failed rename shouldn't litter a stray temp file behind.
        let _ = fs::remove_file(&tmp);
        format!("rename {} -> {}: {e}", tmp.display(), path.display())
    })
}

#[cfg(test)]
mod tests {
    use crate::settings::atomic_write;
    use std::fs;

    #[test]
    fn atomic_write_replaces_contents_and_leaves_no_temp() {
        let dir =
            std::env::temp_dir().join(format!("ironclaw-settings-test-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("mkdir temp");
        let path = dir.join("settings.json");

        atomic_write(&path, b"{\"a\":1}").expect("first write");
        assert_eq!(fs::read_to_string(&path).expect("read 1"), "{\"a\":1}");

        // An overwrite fully replaces the contents and leaves no temp file.
        atomic_write(&path, b"{\"a\":2}").expect("second write");
        assert_eq!(fs::read_to_string(&path).expect("read 2"), "{\"a\":2}");
        assert!(!path.with_extension("json.tmp").exists());

        let _ = fs::remove_dir_all(&dir);
    }
}
