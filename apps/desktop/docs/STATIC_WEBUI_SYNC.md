# Static WebUI Sync

IronClaw Desktop packages the Reborn static WebUI directly through Tauri.
The shipped desktop surface is:

```text
crates/ironclaw_webui_v2_static/static
```

`src-tauri/tauri.conf.json` must keep:

```json
{
  "build": {
    "frontendDist": "../crates/ironclaw_webui_v2_static/static",
    "devUrl": "http://localhost:1420/index.html",
    "beforeDevCommand": "npm run dev:webui-static",
    "beforeBuildCommand": "npm run prepare:webui-static"
  }
}
```

The legacy `src/` SvelteKit tree is not the packaged desktop UI. Svelte tests
can still be useful for legacy/reference behavior, but they are not proof that
the shipped app works.

## Preview Vs Desktop Runtime

`npm run dev:webui-static` is a browser preview of the shared static WebUI. It
does not start the Tauri shell, does not spawn the bundled Reborn sidecar, and
does not provide the native auth bridge used by NEAR AI Cloud sign-in. If you
open `/v2/welcome` from that preview without a gateway already running behind
`IRONCLAW_GATEWAY_ORIGIN`, the sign-in buttons should remain disabled.

Use the desktop runtime for product/auth verification:

```bash
npm run tauri dev
```

Use the static server for deterministic UI checks:

```bash
npm run dev:webui-static
npm run smoke:webui-static
```

Do not claim live OAuth, connector execution, or sidecar behavior from a
browser-only static preview.

## Source Of Truth

- Reborn source repo:
  `/path/to/ironclaw`
- Reborn branch to compare:
  `origin/reborn-integration`
- Reborn static source:
  `crates/ironclaw_webui_v2_static/static`
- Desktop packaged copy:
  `crates/ironclaw_webui_v2_static/static`

## Safe Sync Procedure

Do not overwrite the desktop static tree while either repo has unrelated dirty
work. Desktop currently carries product fixes for packaged bootstrap, model
readiness, connector truthfulness, chat attachments, and export controls. Those
must either be upstreamed to Reborn first or intentionally reconciled.

Use a clean Reborn worktree for comparison:

```bash
git -C /path/to/ironclaw fetch origin reborn-integration
git -C /path/to/ironclaw worktree add --detach /tmp/ironclaw-reborn-integration-clean origin/reborn-integration
diff -qr -x main.bundle.js -x tailwind.generated.css -x vendor \
  /tmp/ironclaw-reborn-integration-clean/crates/ironclaw_webui_v2_static/static \
  crates/ironclaw_webui_v2_static/static
```

After any static sync or reconciliation:

```bash
npm run verify:static-frontend
npm run prepare:webui-static
npm run smoke:webui-static
npm run tauri -- build --bundles app
npm run smoke:packaged
```

## Current Sync Status

As of `origin/reborn-integration` commit
`26eac9f31a38788cab5065fc46bae32334bb4a18`, the desktop repo does not have a
remote `reborn-integration` branch. The adjacent Reborn repo has that branch,
but its local worktree is dirty and behind the fetched remote.

Comparison against a clean detached Reborn worktree found 191 non-generated
static differences, excluding `main.bundle.js`, `tailwind.generated.css`, and
`vendor/`. This lane is RED until desktop static deltas are upstreamed or
reconciled file by file.

## Guardrail

Run:

```bash
npm run verify:static-frontend
```

This fails if Tauri stops packaging the static Reborn WebUI, if the local static
entry points are missing, if the static page depends on external browser/CDN
assets, or if the generated bundle is stale.
