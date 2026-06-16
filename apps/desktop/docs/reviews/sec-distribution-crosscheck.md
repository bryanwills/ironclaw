# SEC-7 Distribution Signing Cross-Check - 2026-06-11

Status: YELLOW / externally blocked on Apple signing secrets.

This review covers the public macOS distribution boundary after the release pipeline, updater
manifest, Developer ID signing hooks, universal sidecar preparation, and NEAR-only provider
UI patch landed on `codex/ship-ironclaw-desktop`.

## User Promise Verified

- A public IronClaw Desktop release should be Developer ID signed, notarized, stapled, and
  auto-updatable.
- The shipped Tauri app should not ask for broad macOS hardened-runtime entitlements unless a
  concrete notarized runtime failure proves they are required.
- Updater signing private material must live in CI secrets, not in the repository.
- The release CI should fail honestly before uploading a broken public artifact.

## Reviewed Files

- `.github/workflows/release.yml`
- `scripts/check-release-readiness.sh`
- `scripts/check-release-readiness.test.mjs`
- `docs/RELEASE-SIGNING.md`
- `src-tauri/Entitlements.plist`
- `src-tauri/tauri.conf.json`
- `src-tauri/capabilities/default.json`

## Live GitHub Actions Evidence

Command run:

```bash
gh workflow run release.yml --repo abbyshekit/ironclaw-desktop --ref codex/ship-ironclaw-desktop
gh run watch 27374375126 --repo abbyshekit/ironclaw-desktop --exit-status
```

Run:

- URL: `https://github.com/abbyshekit/ironclaw-desktop/actions/runs/27374375126`
- Head SHA: `3f1326aa60a149be71f7a1a14e7deabf6b4e6be8`
- Result: failed at `Release readiness preflight`, before artifact upload.

Passing steps before the preflight failure:

- Checkout desktop branch.
- Checkout IronClaw Reborn source.
- Install Rust and Node.
- Restore Rust cache.
- Download sidecar binaries.
- Build Reborn sidecar binaries from source on the macOS runner.
- Prepare universal sidecar binaries.
- Run `npm ci`.
- Resolve package version.

Preflight failure:

```text
[release-readiness] APPLE_CERTIFICATE is required for Developer ID signing/notarization
[release-readiness] APPLE_CERTIFICATE_PASSWORD is required for Developer ID signing/notarization
[release-readiness] APPLE_API_KEY is required for Developer ID signing/notarization
[release-readiness] APPLE_API_ISSUER is required for Developer ID signing/notarization
[release-readiness] APPLE_API_KEY_PATH or APPLE_API_KEY_P8 is required for notarization
[release-readiness] Provision the GitHub Actions Apple signing secrets before cutting a public release.
```

The log showed `TAURI_SIGNING_PRIVATE_KEY` was present and masked by GitHub Actions. That means
the updater signing secret exists in CI, while Apple Developer ID and notarization secrets are
still missing.

## Entitlements Verdict

Keep `src-tauri/Entitlements.plist` empty with `bundle.macOS.hardenedRuntime: true`.

Reject adding these entitlements unless a future notarized runtime failure is reproduced and
reviewed separately:

- `com.apple.security.cs.allow-unsigned-executable-memory`
- `com.apple.security.cs.disable-library-validation`
- `com.apple.security.cs.allow-jit`
- `com.apple.security.app-sandbox`

Reasoning:

- The static UI runs inside WKWebView; it does not require JIT or unsigned executable memory.
- The local gateway uses loopback and Tauri HTTP permissions, not a broad network entitlement.
- Sidecars are bundled external executables launched through Tauri shell permissions. They are
  not injected dynamic libraries, so disabling library validation is not justified by the current
  architecture.
- The app is not currently sandboxed; adding App Sandbox would require a separate file-access,
  sidecar, updater, and Keychain compatibility pass.

## Updater Key Verdict

Pass with one caveat:

- `src-tauri/tauri.conf.json` contains only the updater public key.
- The live GitHub Actions run confirms `TAURI_SIGNING_PRIVATE_KEY` is available as a masked CI
  secret.
- Repository grep for private-key material found only docs and test placeholders:
  - `docs/RELEASE-SIGNING.md`
  - `scripts/check-release-readiness.test.mjs`

No updater private key or Apple `.p8` key material is committed.

## CSP And Capability Verdict

Accepted for the current static UI bridge:

- `frame-src 'none'`, `object-src 'none'`, and `base-uri 'self'` are pinned.
- `img-src` is restricted to self/data/blob/Tauri, loopback, localhost, and HTTPS; no bare
  `http://*` wildcard remains.
- `connect-src` permits loopback/localhost, HTTPS, and WebSocket variants required by the local
  Reborn gateway and development bridge.
- `script-src` still includes `wasm-unsafe-eval` and inline script support. Keep this covered by
  static security tests until vendored static UI constraints are removed.
- `src-tauri/capabilities/default.json` restricts shell execute/kill to bundled IronClaw sidecars:
  `binaries/ironclaw-reborn` and `binaries/ironclaw`.
- HTTP plugin access is loopback/localhost plus HTTPS. Shell open is HTTPS plus loopback/localhost.

## Still RED / YELLOW

- RED: Provision missing GitHub Actions secrets:
  - `APPLE_CERTIFICATE`
  - `APPLE_CERTIFICATE_PASSWORD`
  - `APPLE_API_KEY`
  - `APPLE_API_ISSUER`
  - `APPLE_API_KEY_P8` or `APPLE_API_KEY_PATH`
- RED: Re-run `release.yml` after secrets are installed and prove:
  - `spctl -a -vvv --type exec IronClaw.app` reports accepted Developer ID notarization.
  - `xcrun stapler validate IronClaw.app` passes.
  - `xcrun stapler validate IronClaw_*.dmg` passes.
  - `lipo -archs` reports both `x86_64` and `arm64` for the app binary and all sidecars.
  - `release-artifacts/latest.json` contains both macOS updater platforms with non-empty
    signatures.
- YELLOW: GitHub Actions emitted a Node 20 deprecation warning. Track and update affected actions
  before GitHub's September 16, 2026 enforcement window.

## Next Agent Should Start Here

1. Add the missing Apple secrets in GitHub repository settings.
2. Re-run:

   ```bash
   gh workflow run release.yml --repo abbyshekit/ironclaw-desktop --ref codex/ship-ironclaw-desktop
   gh run watch <run-id> --repo abbyshekit/ironclaw-desktop --exit-status
   ```

3. If the workflow reaches notarization, inspect and archive the verification logs for `spctl`,
   `stapler`, `lipo`, and `latest.json`.
4. If notarization fails for an entitlement reason, do not add broad entitlements directly. Capture
   the exact failure and open a focused entitlement review.

## Do Not Touch

- Do not commit `TAURI_SIGNING_PRIVATE_KEY`, Apple `.p8` files, exported `.p12` certificates, or
  passwords.
- Do not add JIT, unsigned executable memory, disabled library validation, or App Sandbox
  entitlements as a speculative fix.
- Do not upload unsigned or unnotarized development artifacts as a public release.
