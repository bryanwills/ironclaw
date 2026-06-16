# R60 — Spotlight indexing of threads

**Lane**: A7 (codex)
**Branch**: `codex/r60-spotlight-indexing`
**Depends on**: nothing

## Context

A real native macOS app shows up in Spotlight. Right now, if a user
remembers "I asked IronClaw about X yesterday", they have to open the
app, hit Cmd+Shift+F, and search there. macOS's natural answer is
Spotlight — and we can plug straight into it by writing thread
metadata into `~/Library/Metadata/IronClaw/<id>.ironclaw-thread`.

mdimporter handles this via a `.mdimporter` plugin — but we can avoid
shipping one by using the simpler path: write metadata files with
extended attributes, and let Spotlight's default text indexer cover
them. Alternative: use `mdimport -i -d3` to register the directory
as searchable. Cheapest viable path: write JSON files in a known
location, document a one-line shell command to add it to mds.

We'll go with the simplest:

1. Write each thread's last-100-messages-text + title to
   `~/Library/Application Support/com.openclaw.ironclaw-desktop/spotlight/<id>.txt`.
2. macOS Spotlight indexes Application Support by default for text
   content. So search "IronClaw thread X" should surface that file.
3. Clicking a Spotlight result opens the file. Add an
   `ironclaw-desktop://thread/<id>` URL handler so future iterations
   can deep-link straight back into the app.

This task ships ONLY the indexing — the URL handler is out of scope
(deferred). For now, Spotlight finds the text; clicking opens TextEdit;
that's enough to validate "search works."

## Owned files (exclusive write access)

- `src-tauri/src/spotlight.rs` — NEW module.
- `src-tauri/src/lib.rs` — append 4 lines:
  - `mod spotlight;`
  - `.manage(spotlight::SpotlightIndexer::default())`
  - Two handler entries in `generate_handler![]`.
- `src/lib/stores/threads.svelte.ts` — append a SINGLE 8-line block
  that subscribes to thread updates and calls the Tauri command. Do
  not modify any existing function.

## Forbidden files

- All routes.
- All components.
- Any other store.

## Rust spec — `src-tauri/src/spotlight.rs`

```rust
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
//!     IronClaw thread: <title>
//!     <created_at>
//!     <updated_at>
//!     <message1.author>: <message1.content>
//!     ...
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
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?;
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
```

`lib.rs` additions (exact 4 lines, placed at existing markers):

```rust
mod spotlight;  // near the top with other `mod` declarations
// in .manage() chain:  .manage(spotlight::SpotlightIndexer::default())
// in generate_handler![]:  spotlight::spotlight_index_thread, spotlight::spotlight_remove_thread,
```

## Threads store integration

`src/lib/stores/threads.svelte.ts`, append at the end of the
`ThreadsStore` class (do not modify existing methods):

```ts
private async indexInSpotlight(threadId: string): Promise<void> {
  if (typeof window === 'undefined') return;
  if (!('__TAURI_INTERNALS__' in window)) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const messages = (await import('./messages.svelte'))
      .messages.get(threadId)
      .slice(-50)
      .map((m) => ({ role: m.role, content: m.content }));
    const thread = this.byId[threadId];
    if (!thread) return;
    await invoke('spotlight_index_thread', {
      snapshot: {
        id: threadId,
        title: thread.title ?? '(untitled)',
        created_at: thread.created_at,
        updated_at: thread.updated_at,
        messages
      }
    });
  } catch {
    // Spotlight indexing is best-effort.
  }
}
```

Then, in the existing `mergeUpdates` / `setThread` / wherever threads
are written, call `void this.indexInSpotlight(id)`. If
`mergeUpdates` doesn't exist (A4 may have introduced it), wire there
too in a separate commit.

## Wire contract

None — uses the existing thread + message stores.

## Acceptance

1. `cargo check --manifest-path src-tauri/Cargo.toml` → 0 errors.
2. `cargo clippy -- -D warnings` → green.
3. `npm run check` → 0 errors.
4. `npm run test` → green. Add a test that
   `indexInSpotlight` no-ops outside Tauri.
5. Manual:
   - Launch the bundled `.app`, send 3 messages in a thread titled
     "Spotlight smoke test 123".
   - Wait 30 seconds (Spotlight indexing has a delay).
   - Cmd+Space, search "Spotlight smoke test 123" → the index file
     should appear under "Documents" or similar.
   - Search for content inside the message ("smoke test 123") →
     should also surface the file.

## Out of scope

- Custom URL handler (`ironclaw-desktop://thread/<id>`) — deferred.
- mdimporter plugin (we use the default text indexer).
- Removing the index when a thread is deleted is one IPC call away;
  add it inline next to the existing delete path (small).
- Search ranking quality — Spotlight handles ranking.

## Notes

- The index directory is `~/Library/Application Support/com.openclaw.ironclaw-desktop/spotlight/`.
- macOS reindexes after first write; the first search may miss it for
  up to a minute.
- Plain text is intentional — no metadata XML, no JSON. Spotlight
  doesn't index JSON content by default.
- If the index files leak content, the OS keychain ACL doesn't help —
  they're plain text. Add a note to the privacy doc when Wave 4 lands.
