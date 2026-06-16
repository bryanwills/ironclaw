<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { inTauri } from '$lib/utils/runtime';

  interface Props {
    code: string;
  }
  let { code }: Props = $props();

  let running = $state(false);
  let stdout = $state('');
  let stderr = $state('');
  let exitCode = $state<number | null>(null);
  let error = $state<string | null>(null);
  // Gate: assistant-authored Python runs on the user's machine (not a true
  // sandbox), so the first Run click only *arms* an explicit confirmation —
  // execution requires a second, deliberate "Run anyway" click. Never
  // auto-runs. (Codex audit P0.)
  let confirming = $state(false);

  function requestRun() {
    error = null;
    confirming = true;
  }
  function cancelRun() {
    confirming = false;
  }

  async function run() {
    confirming = false;
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
    {#if confirming}
      <div class="flex items-center gap-2">
        <span class="text-[10px] text-accent-gold">Runs code on your machine.</span>
        <button
          type="button"
          onclick={() => void run()}
          class="px-2 py-0.5 text-[10px] rounded border border-accent-gold/50 text-accent-gold hover:bg-accent-gold/10 transition-colors"
        >
          Run anyway
        </button>
        <button
          type="button"
          onclick={cancelRun}
          class="px-2 py-0.5 text-[10px] rounded border border-border-subtle text-text-muted hover:bg-bg-surface transition-colors"
        >
          Cancel
        </button>
      </div>
    {:else}
      <button
        type="button"
        onclick={requestRun}
        disabled={running}
        class="px-2 py-0.5 text-[10px] rounded border border-accent-cyan/40 text-accent-cyan hover:bg-accent-cyan/10 transition-colors disabled:opacity-40"
      >
        {running ? 'Running...' : 'Run'}
      </button>
    {/if}
  </div>
  <pre class="bg-bg-deep border border-border-subtle rounded p-3 overflow-x-auto"><code>{code}</code
    ></pre>
  {#if stdout || stderr || error || exitCode !== null}
    <div
      class="mt-2 text-xs border border-border-subtle rounded bg-bg-base/40 p-2 font-mono whitespace-pre-wrap"
    >
      {#if stdout}<div class="text-text-primary">{stdout}</div>{/if}
      {#if stderr}<div class="text-red-300 mt-1">{stderr}</div>{/if}
      {#if error}<div class="text-red-300">{error}</div>{/if}
      {#if exitCode !== null && exitCode !== 0}<div class="text-text-muted mt-1">
          exit {exitCode}
        </div>{/if}
    </div>
  {/if}
</div>
