import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve('scripts/prepare-universal-sidecars.sh');

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ironclaw-universal-sidecars-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function thinArch(source, arch, output) {
  await execFileAsync('lipo', [source, '-thin', arch, '-output', output]);
}

test('creates universal sidecars from real Mach-O slices', async () => {
  await withTempDir(async (dir) => {
    await thinArch('/usr/bin/true', 'arm64e', path.join(dir, 'ironclaw-aarch64-apple-darwin'));
    await thinArch('/usr/bin/true', 'x86_64', path.join(dir, 'ironclaw-x86_64-apple-darwin'));

    await execFileAsync('bash', [scriptPath, '--bin-dir', dir, '--bases', 'ironclaw']);

    const { stdout } = await execFileAsync('lipo', [
      '-archs',
      path.join(dir, 'ironclaw-universal-apple-darwin')
    ]);
    assert.match(stdout, /x86_64/);
    assert.match(stdout, /arm64/);
  });
});

test('check-only fails before lipo when a required sidecar slice is missing', async () => {
  await withTempDir(async (dir) => {
    await thinArch('/usr/bin/true', 'arm64e', path.join(dir, 'ironclaw-aarch64-apple-darwin'));

    await assert.rejects(
      execFileAsync('bash', [scriptPath, '--bin-dir', dir, '--bases', 'ironclaw', '--check-only']),
      /missing sidecar slice/
    );
  });
});
