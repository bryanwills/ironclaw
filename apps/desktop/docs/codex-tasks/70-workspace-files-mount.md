# R70 — Workspace files: export memory tree to Finder (lane A13)

**Branch**: `codex/r70-workspace-files`
**Depends on**: nothing

## Context

"Mount in Finder" for the memory tree. Option A (light) from
`docs/WORKSPACE-OS.md`: on demand, write the memory tree's files to a
real folder under `~/Documents/IronClaw/<profile>/` and open it in
Finder. One-way for v1 (export only); two-way sync is a later lane.

## Owned files (exclusive write)

- `src-tauri/src/fs_mount.rs` (NEW)
- `src-tauri/src/lib.rs` — APPEND `mod fs_mount;` + register
  `fs_mount::export_memory_tree`. Two lines.
- `src/routes/memory/+page.svelte` — ADD a single "Open in Finder"
  button in the header toolbar that calls a new `exportMemoryTree()`
  wrapper. ~10 lines, no other changes.
- `src/lib/api/files.ts` — APPEND `exportMemoryTree(profileId, files)`
  wrapper.

## Forbidden

- Any other route / component / store.
- Other Rust modules.

## Rust spec

```rust
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
        .join(if safe_profile.is_empty() { "default".into() } else { safe_profile });
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    for file in &files {
        // Reject path-traversal: each component must be a normal segment.
        let rel = PathBuf::from(&file.path);
        if rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::RootDir))
        {
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
```

`lib.rs`:
```rust
mod fs_mount;                          // near other mod decls
fs_mount::export_memory_tree,          // in generate_handler![]
```

## TS wrapper

`src/lib/api/files.ts` — append:
```ts
export async function exportMemoryTree(
  profileId: string,
  files: Array<{ path: string; content: string }>
): Promise<string> {
  if (!inTauri()) throw new Error('Workspace export requires the desktop app');
  return (await invoke('export_memory_tree', { profileId, files })) as string;
}
```

## Memory route button

In `src/routes/memory/+page.svelte`, find the header toolbar (where
refresh / new-doc buttons live). Add:
```svelte
<button type="button" onclick={onExportToFinder} title="Export memory tree to ~/Documents/IronClaw and open in Finder" ...>
  Open in Finder
</button>
```
With a handler that gathers the loaded nodes' paths + content (fetch
each via the existing `client.readMemory(path)` if content isn't
already loaded — but to keep it light, export only the already-loaded
node previews and document that full content export is a follow-up).
On success, toast `Exported N files to <path>`.

## Tests

Add `src/lib/utils/fs-mount.test.ts` (3 cases) for the TS wrapper:
calls invoke, throws outside Tauri, propagates errors.

## Gates

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
npm run check
npm run test
```

## Ship

Standard codex commit + push.

## Notes

- The path-traversal guard is load-bearing — keep it.
- One-way export only. Do NOT attempt filesystem-watch sync in this
  lane.
