# R50 — Native macOS TTS as a Tauri command

**Lane**: A2 (codex)
**Branch**: `codex/r50-tts-tauri-command`
**Depends on**: nothing

## Context

Voice output is the 2026 baseline for AI clients. The Web Speech API
synthesis is unreliable in WKWebView (Tauri 2.x has known gaps), so
the right path is a native Tauri command that wraps macOS's `say`
binary (universal, deterministic, scriptable).

This task ships ONLY the wire — the Rust command + the TS wrapper.
The UI consumer lands in B1 (R51, claude).

## Owned files (exclusive write access)

- `src-tauri/src/tts.rs` — new module.
- `src-tauri/src/lib.rs` — append 4 lines to register the command:
  one `mod tts;` near the top, one entry in the `.invoke_handler`
  `generate_handler![]` macro call. **Do not refactor anything else
  in this file.** If you need to insert imports, group them next to
  existing ones.
- `src-tauri/Cargo.toml` — add `tokio = { version = "1", features = ["process"] }` if not already enabled (probably is). No other deps.
- `src/lib/utils/tts.ts` — new TS wrapper.
- `src/lib/utils/tts.test.ts` — new vitest.

## Forbidden files

- Any route file.
- Any component file.
- Any other Tauri module.
- `tauri.conf.json` (no permission changes needed — `say` is invoked
  inside the Rust process, not through `shell:execute`, so it doesn't
  need a permission grant).

## Rust spec — `src-tauri/src/tts.rs`

```rust
//! macOS native TTS via the `say` binary.
//!
//! `say -v <voice> -r <rate> <text>` is the universal path. Bundled
//! voices live under /System/Library/Speech/Voices; the user can
//! pick via the macOS Voice Memos UI. We surface the voice + rate
//! as optional params and default to "Samantha" at 200 wpm.
//!
//! The command is fire-and-forget — Tokio spawns the child, returns
//! immediately, and the OS owns the process lifetime. A second call
//! interrupts the first (we kill the previous handle via a shared
//! Mutex<Option<Child>>).

use std::process::Stdio;
use std::sync::Mutex;
use tokio::process::Command;

#[derive(Default)]
pub struct TtsState {
    current: Mutex<Option<tokio::process::Child>>,
}

#[tauri::command]
pub async fn say_text(
    state: tauri::State<'_, TtsState>,
    text: String,
    voice: Option<String>,
    rate: Option<u32>,
) -> Result<(), String> {
    // Interrupt anything currently speaking.
    if let Ok(mut guard) = state.current.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.start_kill();
        }
    }

    let mut cmd = Command::new("/usr/bin/say");
    if let Some(v) = voice.as_deref() {
        cmd.arg("-v").arg(v);
    }
    cmd.arg("-r").arg((rate.unwrap_or(200)).to_string());
    cmd.arg(text);
    cmd.stdout(Stdio::null()).stderr(Stdio::null());

    let child = cmd.spawn().map_err(|e| e.to_string())?;
    if let Ok(mut guard) = state.current.lock() {
        *guard = Some(child);
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_tts(state: tauri::State<'_, TtsState>) -> Result<(), String> {
    if let Ok(mut guard) = state.current.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.start_kill();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn list_voices() -> Result<Vec<String>, String> {
    let output = Command::new("/usr/bin/say")
        .arg("-v")
        .arg("?")
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Each line: "Samantha            en_US    # description..."
    let voices: Vec<String> = stdout
        .lines()
        .filter_map(|line| line.split_whitespace().next().map(String::from))
        .collect();
    Ok(voices)
}
```

`lib.rs` additions (exact 4 lines, find the right insertion points):

```rust
mod tts;  // near top with other `mod` declarations
// in .manage(...) chain:  .manage(tts::TtsState::default())
// in generate_handler![]:  tts::say_text, tts::stop_tts, tts::list_voices,
```

## TS spec — `src/lib/utils/tts.ts`

```ts
// Native macOS TTS wrapper. Calls into the Tauri `say_text` /
// `stop_tts` / `list_voices` commands. No-ops gracefully when not
// running inside Tauri (browser dev, vitest).

import { invoke } from '@tauri-apps/api/core';
import { inTauri } from './runtime';

export interface SpeakOptions {
  voice?: string;
  rate?: number;
}

export async function speak(text: string, options: SpeakOptions = {}): Promise<void> {
  if (!inTauri()) return;
  if (!text.trim()) return;
  try {
    await invoke('say_text', {
      text,
      voice: options.voice ?? null,
      rate: options.rate ?? null
    });
  } catch (err) {
    // Don't spam toasts here — the caller decides whether to surface.
    console.warn('[tts] speak failed', err);
    throw err;
  }
}

export async function stopSpeaking(): Promise<void> {
  if (!inTauri()) return;
  try {
    await invoke('stop_tts');
  } catch (err) {
    console.warn('[tts] stop failed', err);
  }
}

export async function listVoices(): Promise<string[]> {
  if (!inTauri()) return [];
  try {
    return (await invoke('list_voices')) as string[];
  } catch (err) {
    console.warn('[tts] list_voices failed', err);
    return [];
  }
}
```

## Wire contract

None — pure native invocation.

## Acceptance

1. `cargo check --manifest-path src-tauri/Cargo.toml` → 0 errors.
2. `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
   → 0 errors.
3. `cargo test --manifest-path src-tauri/Cargo.toml` → green.
4. `npm run check` → 0 errors.
5. `npm run test` → all green (add new vitest for `tts.ts` — assert
   it no-ops outside Tauri).
6. Manual smoke test inside the bundled `.app`:
   ```
   open the app, open devtools (dev build), in console run:
   await window.__TAURI_INTERNALS__.invoke('say_text', { text: 'hello world' })
   ```
   Audio must play. `await invoke('stop_tts')` halts it. `await invoke('list_voices')`
   returns a non-empty array.

## Out of scope

- Any UI surface — that's lane B1 (R51).
- Streaming TTS (chunked input) — the current `say` binary doesn't
  support stdin streaming reliably; we defer until we wrap
  `AVSpeechSynthesizer` via objc bindings (Wave 3+).
- OpenAI TTS / 11labs cloud TTS — separate lane later.

## Notes

- The `say` binary is part of macOS — no install or permission needed.
- `start_kill` is preferred over `kill` because it returns immediately.
- The state mutex is `std::sync::Mutex`, not `tokio::sync::Mutex`,
  because the guard never crosses an await boundary in our code.
