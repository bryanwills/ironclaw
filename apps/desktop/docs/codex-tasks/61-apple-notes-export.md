# R61 — Apple Notes export (lane A8)

**Branch**: `codex/r61-apple-notes-export`
**Depends on**: nothing

## Context

Power-user request: push an IronClaw assistant turn into Apple Notes
for permanent storage. AppleScript can do this via `osascript`. Ship
a Tauri command + a thin TS wrapper. UI hook can come later.

## Owned files (exclusive write)

- `src-tauri/src/notes_export.rs` (NEW)
- `src-tauri/src/lib.rs` — APPEND `mod notes_export;` near top + register
  `notes_export::export_to_notes` in `.invoke_handler![]`. **Only those
  two append lines.**
- `src/lib/api/files.ts` — APPEND a single async `exportToNotes(title, body)`
  function.
- `src/lib/utils/notes.test.ts` (NEW) — small unit test for the TS
  wrapper.

## Forbidden

- Any UI component or route.
- Anything else in `src-tauri/` outside the two-line append.

## Probe

```bash
osascript -e 'tell application "Notes" to make new note with properties {name:"smoke", body:"hello"}'
```

If this opens Notes.app and creates a "smoke" note, the wire works.
The Tauri command shells out to `/usr/bin/osascript` with `-e`. We
escape `title` and `body` by HEREDOC-style stdin instead of as args
to avoid quote escaping pitfalls.

## Rust spec

```rust
//! Push a single assistant turn into Apple Notes via osascript.
//!
//! Best-effort: failures bubble back to the JS caller so the UI can
//! decide whether to surface a toast.

use std::io::Write;
use std::process::{Command, Stdio};

#[tauri::command]
pub async fn export_to_notes(title: String, body: String) -> Result<(), String> {
    // Build the AppleScript on stdin so we don't have to escape
    // the user's title/body content for the command line.
    let title = title.replace('"', "\\\"");
    let body = body.replace('"', "\\\"").replace('\n', "\\n");
    let script = format!(
        "tell application \"Notes\"\n  tell account 1\n    make new note at folder \"Notes\" with properties {{name:\"{}\", body:\"{}\"}}\n  end tell\nend tell",
        title, body
    );

    let mut child = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(&script)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        let mut err = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = std::io::Read::read_to_string(&mut stderr, &mut err);
        }
        return Err(format!("osascript exited {}: {}", status, err.trim()));
    }
    Ok(())
}
```

`lib.rs` additions:
```rust
mod notes_export;                                 // near `mod tts;`
notes_export::export_to_notes,                    // in `generate_handler![]`
```

## TS wrapper

`src/lib/api/files.ts` — append:
```ts
import { invoke } from '@tauri-apps/api/core';
import { inTauri } from '$lib/utils/runtime';

export async function exportToNotes(title: string, body: string): Promise<void> {
  if (!inTauri()) throw new Error('Apple Notes export requires the desktop app');
  await invoke('export_to_notes', { title, body });
}
```

## Tests

`src/lib/utils/notes.test.ts` (4 cases):
1. `exportToNotes` calls `invoke('export_to_notes', { title, body })`
2. `exportToNotes` throws when not inTauri (mock `inTauri` returning false)
3. `exportToNotes` propagates invoke errors
4. Empty title/body fall through (no client-side validation in v1)

Mock pattern:
```ts
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('$lib/utils/runtime', () => ({ inTauri: vi.fn(() => true) }));
```

## Gates

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
npm run check
npm run test src/lib/utils/notes.test.ts
npm run test
```

## Ship

1. `git add` your files
2. Commit:
   ```
   R61: apple notes export (codex)
   
   Short body explaining what landed and any deviations.
   
   Co-Authored-By: Codex GPT-5.5 <noreply@openai.com>
   ```
3. `git push -u origin HEAD`

## Failure modes

- osascript fails on a sandboxed environment with permissions denied —
  document in summary; the wire still ships, just can't be smoke-tested.
- Pre-commit failure: run `cargo fmt` + prettier first.
