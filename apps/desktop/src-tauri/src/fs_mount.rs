//! Export the in-memory memory-tree contents to a real folder under
//! ~/Documents/IronClaw/<profile>/ and reveal it in Finder. One-way
//! (export) for v1.

use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(serde::Deserialize)]
pub struct MemoryFileInput {
    /// Relative path within the memory tree (e.g. "projects/a/notes.md").
    pub path: String,
    pub content: String,
}

#[tauri::command]
pub async fn export_memory_tree(
    app: tauri::AppHandle,
    profile_id: String,
    files: Vec<MemoryFileInput>,
) -> Result<String, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    // Sanitize the profile id into a safe folder name.
    let safe_profile: String = profile_id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    let root = home
        .join("Documents")
        .join("IronClaw")
        .join(if safe_profile.is_empty() {
            "default".into()
        } else {
            safe_profile
        });
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    for file in &files {
        // Reject path-traversal: each component must be a normal segment.
        let rel = PathBuf::from(&file.path);
        if rel.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::RootDir
            )
        }) {
            continue; // skip anything trying to escape
        }
        let dest = root.join(&rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&dest, &file.content).map_err(|e| e.to_string())?;
    }

    // Reveal the root in Finder.
    let _ = std::process::Command::new("open").arg(&root).status();
    Ok(root.display().to_string())
}
