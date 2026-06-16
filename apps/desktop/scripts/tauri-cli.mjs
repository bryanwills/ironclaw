import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauriBin = path.join(repoRoot, 'node_modules', '.bin', 'tauri');
const args = process.argv.slice(2);

function hasArg(name, shortName) {
  return args.some((arg) => arg === name || (shortName && arg === shortName));
}

const isBuild = args[0] === 'build';

// Tauri embeds frontendDist into the binary at COMPILE time, but cargo's
// rerun-if-changed tracking misses edits nested inside the static tree —
// a JS-only change can ship a binary with STALE embedded assets. Touch the
// crate root so every `tauri build` re-embeds the current assets.
if (isBuild) {
  const { utimesSync } = await import('node:fs');
  const now = new Date();
  try {
    utimesSync(new URL('../src-tauri/src/main.rs', import.meta.url), now, now);
  } catch {
    // Missing file would fail the build anyway; nothing to do here.
  }
}
const hasSigningKey = Boolean((process.env.TAURI_SIGNING_PRIVATE_KEY || '').trim());
const alreadyOverridesConfig = hasArg('--config', '-c');

const finalArgs = [...args];
if (isBuild && !hasSigningKey && !alreadyOverridesConfig) {
  finalArgs.push('--config', JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
  console.warn(
    '[ironclaw] TAURI_SIGNING_PRIVATE_KEY is not set; building app/DMG without updater artifacts.'
  );
}

const child = spawn(tauriBin, finalArgs, {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit'
});

child.on('error', (error) => {
  console.error(`[ironclaw] failed to launch tauri CLI: ${error.message}`);
  process.exit(1);
});

child.on('close', (code, signal) => {
  if (signal) {
    console.error(`[ironclaw] tauri CLI terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
