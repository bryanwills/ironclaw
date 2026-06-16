import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

import { buildUpdaterManifest } from './build-updater-manifest.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve('scripts/build-updater-manifest.mjs');

async function withArtifacts(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ironclaw-updater-manifest-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function addArtifact(dir, name, signature = `${name}-signature\n`) {
  await writeFile(path.join(dir, name), 'fake updater archive');
  await writeFile(path.join(dir, `${name}.sig`), signature);
}

test('builds a Tauri v2 static updater manifest for both macOS arches', async () => {
  await withArtifacts(async (dir) => {
    await addArtifact(dir, 'IronClaw_1.2.3_aarch64.app.tar.gz', 'sig-aarch64\n');
    await addArtifact(dir, 'IronClaw_1.2.3_x86_64.app.tar.gz', 'sig-x86\n');

    const manifest = await buildUpdaterManifest({
      artifactsDir: dir,
      repo: 'nearai/ironclaw-desktop-app',
      tag: 'v1.2.3',
      version: '1.2.3',
      notes: 'Release notes',
      pubDate: '2026-06-11T12:00:00.000Z'
    });

    assert.equal(manifest.version, '1.2.3');
    assert.equal(manifest.notes, 'Release notes');
    assert.equal(manifest.pub_date, '2026-06-11T12:00:00.000Z');
    assert.deepEqual(Object.keys(manifest.platforms).sort(), ['darwin-aarch64', 'darwin-x86_64']);
    assert.deepEqual(manifest.platforms['darwin-aarch64'], {
      signature: 'sig-aarch64',
      url: 'https://github.com/nearai/ironclaw-desktop-app/releases/download/v1.2.3/IronClaw_1.2.3_aarch64.app.tar.gz'
    });
    assert.deepEqual(manifest.platforms['darwin-x86_64'], {
      signature: 'sig-x86',
      url: 'https://github.com/nearai/ironclaw-desktop-app/releases/download/v1.2.3/IronClaw_1.2.3_x86_64.app.tar.gz'
    });
  });
});

test('refuses archives that were copied without an architecture suffix', async () => {
  await withArtifacts(async (dir) => {
    await addArtifact(dir, 'IronClaw.app.tar.gz', 'sig\n');

    await assert.rejects(
      buildUpdaterManifest({
        artifactsDir: dir,
        repo: 'nearai/ironclaw-desktop-app',
        tag: 'v1.2.3',
        version: '1.2.3',
        pubDate: '2026-06-11T12:00:00.000Z'
      }),
      /ambiguous/
    );
  });
});

test('maps a universal updater archive to both macOS updater platforms', async () => {
  await withArtifacts(async (dir) => {
    await addArtifact(dir, 'IronClaw_1.2.3_universal.app.tar.gz', 'sig-universal\n');

    const manifest = await buildUpdaterManifest({
      artifactsDir: dir,
      repo: 'nearai/ironclaw-desktop-app',
      tag: 'v1.2.3',
      version: '1.2.3',
      pubDate: '2026-06-11T12:00:00.000Z'
    });

    const expectedPlatform = {
      signature: 'sig-universal',
      url: 'https://github.com/nearai/ironclaw-desktop-app/releases/download/v1.2.3/IronClaw_1.2.3_universal.app.tar.gz'
    };
    assert.deepEqual(manifest.platforms['darwin-aarch64'], expectedPlatform);
    assert.deepEqual(manifest.platforms['darwin-x86_64'], expectedPlatform);
  });
});

test('refuses multiple universal updater archives', async () => {
  await withArtifacts(async (dir) => {
    await addArtifact(dir, 'IronClaw_1.2.3_universal.app.tar.gz', 'sig-one\n');
    await addArtifact(dir, 'IronClaw_1.2.3_2_universal.app.tar.gz', 'sig-two\n');

    await assert.rejects(
      buildUpdaterManifest({
        artifactsDir: dir,
        repo: 'nearai/ironclaw-desktop-app',
        tag: 'v1.2.3',
        version: '1.2.3',
        pubDate: '2026-06-11T12:00:00.000Z'
      }),
      /Multiple universal updater archives/
    );
  });
});

test('refuses mixed universal and per-arch updater archives', async () => {
  await withArtifacts(async (dir) => {
    await addArtifact(dir, 'IronClaw_1.2.3_universal.app.tar.gz', 'sig-universal\n');
    await addArtifact(dir, 'IronClaw_1.2.3_aarch64.app.tar.gz', 'sig-aarch64\n');

    await assert.rejects(
      buildUpdaterManifest({
        artifactsDir: dir,
        repo: 'nearai/ironclaw-desktop-app',
        tag: 'v1.2.3',
        version: '1.2.3',
        pubDate: '2026-06-11T12:00:00.000Z'
      }),
      /Mixed universal and per-arch updater archives/
    );
  });
});

test('requires detached updater signatures by default', async () => {
  await withArtifacts(async (dir) => {
    await addArtifact(dir, 'IronClaw_1.2.3_aarch64.app.tar.gz', 'sig-aarch64\n');
    await writeFile(path.join(dir, 'IronClaw_1.2.3_x86_64.app.tar.gz'), 'fake updater archive');

    await assert.rejects(
      buildUpdaterManifest({
        artifactsDir: dir,
        repo: 'nearai/ironclaw-desktop-app',
        tag: 'v1.2.3',
        version: '1.2.3',
        pubDate: '2026-06-11T12:00:00.000Z'
      }),
      /Missing updater signature/
    );
  });
});

test('refuses a release tag that does not match the manifest version', async () => {
  await withArtifacts(async (dir) => {
    await addArtifact(dir, 'IronClaw_1.2.3_universal.app.tar.gz', 'sig-universal\n');

    await assert.rejects(
      buildUpdaterManifest({
        artifactsDir: dir,
        repo: 'nearai/ironclaw-desktop-app',
        tag: 'v1.2.4',
        version: '1.2.3',
        pubDate: '2026-06-11T12:00:00.000Z'
      }),
      /Release tag v1\.2\.4 does not match manifest version 1\.2\.3/
    );
  });
});

test('cli writes latest.json to the artifact directory', async () => {
  await withArtifacts(async (dir) => {
    await addArtifact(dir, 'IronClaw_1.2.3_aarch64.app.tar.gz', 'sig-aarch64\n');
    await addArtifact(dir, 'IronClaw_1.2.3_x86_64.app.tar.gz', 'sig-x86\n');

    await execFileAsync(process.execPath, [
      scriptPath,
      '--artifacts',
      dir,
      '--repo',
      'nearai/ironclaw-desktop-app',
      '--tag',
      'v1.2.3',
      '--version',
      '1.2.3',
      '--pub-date',
      '2026-06-11T12:00:00.000Z'
    ]);

    const manifest = JSON.parse(await readFile(path.join(dir, 'latest.json'), 'utf8'));
    assert.equal(manifest.platforms['darwin-aarch64'].signature, 'sig-aarch64');
    assert.equal(manifest.platforms['darwin-x86_64'].signature, 'sig-x86');
  });
});
