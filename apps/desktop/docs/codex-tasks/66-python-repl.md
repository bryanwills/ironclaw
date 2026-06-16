# R66 — Python REPL block runner (lane A10)

**Branch**: `codex/r66-python-repl`
**Depends on**: nothing — but read Apple's sandboxing constraints first.

## Context

Render every ```` ```python ```` code block in MarkdownView with a small
"Run" button. Clicking executes the snippet in a sandboxed `/usr/bin/python3`
process and streams stdout/stderr back into the chat surface inline.

This task ships the Tauri command + a thin component. Wiring it into
MarkdownView is part of the same PR (one renderer addition).

## Owned files

- `src-tauri/src/sandbox_exec.rs` (NEW)
- `src-tauri/src/lib.rs` — APPEND `mod sandbox_exec;` near other modules
  + register `sandbox_exec::run_python_snippet`. Exactly two append
  lines.
- `src/lib/components/markdown-renderers/PythonBlock.svelte` (NEW)
- `src/lib/components/MarkdownView.svelte` — APPEND a single conditional
  branch that swaps the default code-block renderer for
  `<PythonBlock>` when `info === 'python'`. **Do not modify other
  branches.**

## Forbidden

- Any other component / route / store.
- Other modules in `src-tauri/`.

## Rust spec

```rust
//! Run a Python snippet in a constrained `/usr/bin/python3` subprocess.
//!
//! Security:
//!   - hardcoded interpreter path (no PATH lookup)
//!   - no shell expansion (we pass `-c <snippet>` directly)
//!   - no inherited env (start with `PYTHONDONTWRITEBYTECODE=1` only)
//!   - 30-second wall-clock timeout
//!   - 1 MB stdout cap
//!   - runs as the current app user; no privilege drop is performed here

use std::process::Stdio;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

const TIMEOUT_SECS: u64 = 30;
const STDOUT_CAP: usize = 1024 * 1024;

#[derive(serde::Serialize)]
pub struct PythonResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub truncated: bool,
}

#[tauri::command]
pub async fn run_python_snippet(code: String) -> Result<PythonResult, String> {
    let mut cmd = Command::new("/usr/bin/python3");
    cmd.arg("-c").arg(&code);
    cmd.env_clear();
    cmd.env("PYTHONDONTWRITEBYTECODE", "1");
    cmd.env("HOME", std::env::var("HOME").unwrap_or_default());
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut stdout_buf = Vec::with_capacity(8192);
    let mut stderr_buf = Vec::with_capacity(4096);

    let stdout = child.stdout.take().ok_or("stdout pipe missing")?;
    let stderr = child.stderr.take().ok_or("stderr pipe missing")?;

    let run = async {
        let mut so = tokio::io::BufReader::new(stdout);
        let mut se = tokio::io::BufReader::new(stderr);
        let _ = so.read_to_end(&mut stdout_buf).await;
        let _ = se.read_to_end(&mut stderr_buf).await;
        child.wait().await
    };

    let status = match timeout(Duration::from_secs(TIMEOUT_SECS), run).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => {
            return Err(format!("execution exceeded {TIMEOUT_SECS}s timeout"));
        }
    };

    let truncated = stdout_buf.len() > STDOUT_CAP;
    stdout_buf.truncate(STDOUT_CAP);
    stderr_buf.truncate(STDOUT_CAP);

    Ok(PythonResult {
        stdout: String::from_utf8_lossy(&stdout_buf).to_string(),
        stderr: String::from_utf8_lossy(&stderr_buf).to_string(),
        exit_code: status.code().unwrap_or(-1),
        truncated,
    })
}
```

## Component spec

```svelte
<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { inTauri } from '$lib/utils/runtime';

  interface Props { code: string }
  let { code }: Props = $props();

  let running = $state(false);
  let stdout = $state('');
  let stderr = $state('');
  let exitCode = $state<number | null>(null);
  let error = $state<string | null>(null);

  async function run() {
    if (!inTauri()) {
      error = 'Python execution requires the desktop app';
      return;
    }
    running = true;
    error = null;
    stdout = '';
    stderr = '';
    exitCode = null;
    try {
      const res = (await invoke('run_python_snippet', { code })) as {
        stdout: string;
        stderr: string;
        exit_code: number;
        truncated: boolean;
      };
      stdout = res.stdout;
      stderr = res.stderr;
      exitCode = res.exit_code;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      running = false;
    }
  }
</script>

<div class="my-2">
  <div class="flex items-center justify-between mb-1">
    <span class="text-[10px] font-mono text-text-muted uppercase">python</span>
    <button
      type="button"
      onclick={() => void run()}
      disabled={running}
      class="px-2 py-0.5 text-[10px] rounded border border-accent-cyan/40 text-accent-cyan hover:bg-accent-cyan/10 transition-colors disabled:opacity-40"
    >
      {running ? 'Running…' : 'Run'}
    </button>
  </div>
  <pre class="bg-bg-deep border border-border-subtle rounded p-3 overflow-x-auto"><code>{code}</code></pre>
  {#if stdout || stderr || error || exitCode !== null}
    <div class="mt-2 text-xs border border-border-subtle rounded bg-bg-base/40 p-2 font-mono whitespace-pre-wrap">
      {#if stdout}<div class="text-text-primary">{stdout}</div>{/if}
      {#if stderr}<div class="text-red-300 mt-1">{stderr}</div>{/if}
      {#if error}<div class="text-red-300">{error}</div>{/if}
      {#if exitCode !== null && exitCode !== 0}<div class="text-text-muted mt-1">exit {exitCode}</div>{/if}
    </div>
  {/if}
</div>
```

## MarkdownView integration

In `MarkdownView.svelte`'s renderer overrides, find the existing
fenced-code-block branch (where Mermaid/Plotly/KaTeX are detected).
Add a new branch BEFORE the default code-block renderer:

```ts
if (info === 'python' || info === 'py') {
  // Defer the render via a placeholder + post-render swap, matching
  // the pattern Mermaid uses.
  // (Implementation depends on existing code structure — read first.)
}
```

The mermaid/plotly path already has this swap-after-render machinery;
follow the same pattern.

## Tests

Add a vitest case in `MarkdownView.test.ts` that mocks `invoke` and
asserts a `python` block renders a button. Add `notes.test.ts`-style
mock pattern.

## Gates

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
npm run check
npm run test
```

## Ship

Standard codex commit + push.

## Failure modes

- Pre-flight `python3 -c 'print(42)'` returns non-zero on the build
  machine: assume Tauri sandbox doesn't allow it; ship the wire
  anyway, document.
- Pre-commit prettier failure: format + retry.
