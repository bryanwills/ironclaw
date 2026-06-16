//! Spotlight-friendly thread index files.
//!
//! Writes plain-text snapshots of each thread to
//! `$APPDATA/spotlight/<thread_id>.txt`. macOS's Spotlight indexer
//! covers Application Support by default for text content, so the
//! files appear in Spotlight without any mdimporter plugin.
//!
//! Format (deliberately plain so the indexer treats it as
//! body-searchable text):
//!
//! ```text
//! IronClaw thread: <title>
//! <created_at>
//! <updated_at>
//! <message1.author>: <message1.content>
//! ...
//! ```
//!
//! Quota: keep last 50 messages per thread; cap each at 4 KB.

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

#[derive(Default)]
pub struct SpotlightIndexer {
    base: Mutex<Option<PathBuf>>,
}

impl SpotlightIndexer {
    fn ensure_dir(&self, app: &tauri::AppHandle) -> Result<PathBuf, String> {
        let mut guard = self.base.lock().map_err(|e| e.to_string())?;
        if let Some(p) = guard.as_ref() {
            return Ok(p.clone());
        }
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let dir = data_dir.join("spotlight");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        *guard = Some(dir.clone());
        Ok(dir)
    }
}

#[derive(serde::Deserialize)]
pub struct ThreadSnapshot {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub messages: Vec<MessageSnapshot>,
}

#[derive(serde::Deserialize)]
pub struct MessageSnapshot {
    pub role: String,
    pub content: String,
}

#[tauri::command]
pub async fn spotlight_index_thread(
    app: tauri::AppHandle,
    state: tauri::State<'_, SpotlightIndexer>,
    snapshot: ThreadSnapshot,
) -> Result<(), String> {
    let dir = state.ensure_dir(&app)?;
    let safe_id: String = snapshot
        .id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if safe_id.is_empty() {
        return Err("thread id empty after sanitization".into());
    }
    let path = dir.join(format!("{safe_id}.txt"));

    let mut body = String::with_capacity(8_192);
    body.push_str("IronClaw thread: ");
    body.push_str(&snapshot.title);
    body.push('\n');
    body.push_str(&snapshot.created_at);
    body.push('\n');
    body.push_str(&snapshot.updated_at);
    body.push_str("\n\n");

    for msg in snapshot.messages.iter().rev().take(50).rev() {
        body.push_str(&msg.role);
        body.push_str(": ");
        let trimmed: String = msg.content.chars().take(4_000).collect();
        body.push_str(&trimmed);
        body.push_str("\n\n");
        if body.len() > 200_000 {
            break;
        }
    }

    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn spotlight_remove_thread(
    app: tauri::AppHandle,
    state: tauri::State<'_, SpotlightIndexer>,
    thread_id: String,
) -> Result<(), String> {
    let dir = state.ensure_dir(&app)?;
    let safe_id: String = thread_id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if safe_id.is_empty() {
        return Ok(());
    }
    let path = dir.join(format!("{safe_id}.txt"));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
