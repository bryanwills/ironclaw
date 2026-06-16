# Sidecar binaries

IronClaw v0.29.0 prebuilt macOS binaries are bundled here for the Local
Sidecar mode. They are **not** committed to git (see `.gitignore`).

To re-fetch before a `npm run tauri build`:

```bash
./download.sh           # downloads both arches, verifies sha256, renames
```

Tauri's `bundle.externalBin` setting in `tauri.conf.json` references
`binaries/ironclaw` and resolves the per-target file at bundle time using
the Rust target triple suffix (`-aarch64-apple-darwin` /
`-x86_64-apple-darwin` / `-universal-apple-darwin`).

Sidecar `sandbox_daemon-*-apple-darwin` is shipped alongside for skills
that opt in to the WASM sandbox.

`download.sh` fetches the legacy `ironclaw` and `sandbox_daemon` slices from
the upstream IronClaw release. The Reborn sidecar is not published in those
tarballs yet, so release CI builds it from a checked-out IronClaw source tree:

```bash
IRONCLAW_REPO_DIR=/path/to/nearai/ironclaw npm run build:reborn-sidecars
```

Before building the public universal macOS bundle, combine every per-arch
sidecar into the target files Tauri will resolve:

```bash
npm run prepare:universal-sidecars
ls src-tauri/binaries/ironclaw-universal-apple-darwin \
  src-tauri/binaries/ironclaw-reborn-universal-apple-darwin \
  src-tauri/binaries/sandbox_daemon-universal-apple-darwin
```
