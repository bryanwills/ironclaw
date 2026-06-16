# IronClaw Desktop — Buildout & Implementation Plan

> The **build sequence** to take the app from "live but not yet trustworthy" to elite, as
> shippable milestones. This is the execution roadmap; the granular task catalog (lanes,
> owned files, acceptance) lives in [`CODEX-WORKPLAN.md`](./CODEX-WORKPLAN.md) and is
> referenced by task id (e.g. `DIST-1`).
>
> Grounded in the **verified current state below (2026-06-11)** — not the older research,
> which described the retired SvelteKit app.

---

## 0. Current state (verified)

**What ships.** A native macOS Tauri v2 app whose webview loads the **static UI**
(`crates/ironclaw_webui_v2_static/static`, React 19 + htm + Tailwind), backed by a bundled
`ironclaw-reborn` Rust sidecar on loopback. Public at
**github.com/nearai/ironclaw-desktop-app** (`main` = `f8b19c7`), version **0.4.158**.

**The four live surfaces** (all real, not stubs):
- **Chat** — NEAR AI Cloud-first model access; legacy provider plumbing is hidden from the
  normal desktop surface. Document attachments with on-device extraction (PDF + offline OCR,
  `.docx/.xlsx/.pptx`) are inlined to the model; work-product
  export (MD / HTML / JSON / **byte-accurate PDF** / DOCX) via a native save dialog.
- **Automations** — hits the real `/api/webchat/v2/automations`.
- **Extensions** — one-click **Notion** (zero-config DCR), **web-access/Exa** (the web-search
  unlock), **Google** (BYO client-id), GitHub + NEAR AI Cloud; installed / channels / MCP /
  registry tabs.
- **Settings** — Inference (real provider management) + Language (11 packs).

**Registered-but-hidden, stubbed** (TODO against missing backend endpoints):
workspace, projects, jobs, routines, missions, admin. These are **backend-blocked**, not
client bugs.

**Auth.** System-browser OAuth, macOS Keychain storage (with a documented 0600 file fallback
for the ACL-hang wedge), per-profile tokens, never written to `settings.json`/exports.

**Gate baseline.** 32 static `node:test` suites (the real shipped-UI gate), 30 Rust tests
(incl. SSRF/keychain), **161 vitest specs that mostly test the dead Svelte app**, svelte-check,
static smoke, release build, packaged WebView gauntlet — all green.

**The honest gaps (what "not yet trustworthy/elite" means today):**
1. **No release is cut** — the in-app updater polls a `latest.json` that doesn't exist (404s);
   builds are **unsigned + un-notarized** → Gatekeeper quarantines them.
2. **103k lines of dead SvelteKit `src/`** still in the repo; "green" is inflated by 161 specs
   testing a ghost.
3. **Approval enforcement is wire-only** — the gate card silently drops `tool metadata` +
   `allow_always`; non-chat dispatch paths aren't guarded for when they light up.
4. **The front door is only partially backed** — the static chat home now has a prepared
   Desk-lite panel for backed `Needs you` thread state and `Handled` automation/thread receipts,
   but true cross-thread pending gates and recent run receipts still need gateway/user-scoped
   feed support.
5. **Latent bugs**: the two-writer `err-${runId}` clobber, thread-export silently dropping
   tool/thinking/image turns.
6. **Visualization/export parity is incomplete** — Mermaid now renders lazily and safely in
   chat; exports preserve labeled Mermaid source across MD/HTML/JSON/PDF/DOCX; DOCX exports now
   carry real heading styles, table XML, editable bullet/ordered lists, and external hyperlink
   relationships; whole-thread export now supports MD/JSON/PDF/DOCX. DOCX/PDF do not yet embed
   the rendered diagram image from the same render path; competitor chat patterns (completed-action
   receipt cards, generated-document artifact headers, generated-file artifact chips with original-byte
   save, quiet tool rows, bubble-less assistant prose, image thumbnails, and the single composer "+"
   sheet) are now explicit in chat. Remaining competitor chat work is live NEAR/Reborn proof that
   generated file bytes arrive from real assistant runs, not static UI plumbing.

**Standing decisions (this session):** Desk-lite front door · mine-then-remove the legacy
`src/` · ship-ready then leap.

---

## How this gets built

- **Execution unit = a `codex exec` worktree lane**, one per task in `CODEX-WORKPLAN.md`,
  owning only its files; PR-per-lane; merge in dependency order. Each milestone below names
  the tasks it pulls and which run in parallel.
- **Every PR passes the gate stack:** `npm run test:static` · `npm run test` · `cargo test
  --release` · `npm run smoke:webui-static` · `npm run smoke:gate-enforcement` ·
  `npm run test:design-static` · `node scripts/tauri-cli.mjs build` · packaged gauntlet —
  plus the static-UI Playwright/axe.
- **Two blockers need a human, not Codex:** (a) an **Apple Developer ID cert + notarization
  credentials** for M1; (b) the **M2 main-sidecar adoption decision** (`UP-6`). Everything
  else is buildable now.
- **Cadence guide** (1–2 engineers + parallel Codex lanes): M1 ≈ days, M2 ≈ 1–2 weeks,
  M3 ≈ 2–3 weeks, M4 ≈ 2–4 weeks, M5 tracks the gateway. Sizes are relative, not commitments.

---

## M1 — Trustworthy install  *(cut the first real public release)*

**Goal.** A user downloads the DMG, opens it **without Gatekeeper friction**, and gets
**auto-updates**. Today none of that is true. This is the smallest increment that makes the
public repo more than a code drop.

**Buildout (sequenced — all own `release.yml`, so serial):**
1. `DIST-1` — generate + attach a correct multi-arch `latest.json` (the updater contract the
   client already expects); fix the README's false "auto-generates" claim. *Cheapest win —
   signing keys already exist.*
2. `DIST-2` — Developer-ID codesign → notarytool submit → staple in CI; add
   `Entitlements.plist` + hardened-runtime; document exactly which secrets to provision
   (`docs/RELEASE-SIGNING.md`). **← needs your Apple cert.**
3. `DIST-3` — universal (fat) DMG so one download runs on Apple Silicon + Intel; verify the
   per-arch `externalBin` sidecars resolve under the universal target.
4. `DIST-4` (parallel, separate files) — release preflight: hard-fail if the signing key is
   absent or the three version files skew.
5. `DIST-5` — unblock GitHub Actions (resolve the historical billing block), prove a green
   `workflow_dispatch`, then **tag `v0.5.0`** — the first notarized, auto-updating release.

**Cross-check lane (parallel):** `SEC-7` — review the entitlements so notarization doesn't
quietly gut the CSP (no `allow-unsigned-executable-memory`/`disable-library-validation`
without a documented sidecar need).

**Deliverable.** `v0.5.0`: a notarized universal DMG + a working `latest.json`. **Exit:**
`spctl -a -vvv` → *Notarized Developer ID*; `stapler validate` ok; `curl …/latest.json | jq
'.platforms|keys'` returns the darwin keys; a prior build auto-updates to it.

---

## M2 — Honest foundation  *(kill the ghost, make green==real, lock safety)*

**Goal.** The repo tells the truth: `src/` is gone, every gate exercises the **shipped** app,
the latent bugs are fixed, the security guards survive the cut, and **every dispatch path
gates**. This is the foundation everything else builds on.

**Track A — legacy cut (sequenced, the spine):**
1. `LEG-1` — port the only two genuinely-wanted utils (`approval-enforcement` policy,
   `redact`) into the static UI with `node:test`.
2. `SEC-1` (parallel, must land before LEG-3) — **migrate the native-security regression guard**
   to the static-UI harness; it dies with `src/` otherwise. Extend it (pin `img-src`,
   externalBin, interpreter paths).
3. `TCI-5/6/7` (parallel) — retarget the design-token guard, build the DT-1..6 harness, stand
   up a **static-UI Playwright project** — so deletion doesn't drop the design/E2E/a11y nets.
4. `LEG-2` → `LEG-3` → `LEG-4` — migrate/triage the 161 vitest specs, **delete `src/` + the
   Svelte build/CI hooks**, scrub the docs. `TCI-8` retires the legacy test surface.

**Track B — latent bugs + debt (parallel lanes, file-disjoint):**
- `DEBT-1` — extract `lib/messageUpsert.js`, fix the `err-id` clobber → `DEBT-2` — thread
  export from the messages array (stop dropping tool/thinking/image turns).
- `DEBT-3` (lib.rs dispatcher dedup), `DEBT-4` (unify the two OAuth poll engines), `DEBT-6`
  (capability-manifest guard), `DEBT-7` (i18n completeness baseline).
- `TCI-1/2/3/4` — cover the SSE parser, the connect chain, sidecar.rs helpers, the
  save-dialog traversal guard.

**Track C — security hardening (parallel, file-disjoint):**
- `SEC-2` DONE (gateway_http_fetch: redirect-none + header strip + body cap; verified by
  `cargo test --manifest-path src-tauri/Cargo.toml --lib gateway_ssrf_tests --locked`), `SEC-3`
  DONE (token-lock the OCR loopback server; verified by `cargo test --manifest-path
  src-tauri/Cargo.toml --lib ocr_assets --locked` plus `pdf-text-extract.test.mjs`), `SEC-4`
  DONE (provider credentials keychain-only, local bearer fallback only after keychain failure, and
  `docs/ARCHITECTURE.md` threat model), `SEC-5` DONE (no bare `http://*` image source;
  guarded by `tauri-security.test.mjs`).

**Track D — universal approval enforcement (the safety ship-gate):**
- `APPR-1` → `APPR-2` (carry tool metadata + `allow_always`; fix the requestId footgun) →
  `APPR-4` (mock-sidecar wire-probe harness) + `APPR-6` (DT-6 gate craft). `APPR-3` hardens
  the risk taxonomy from the legacy kinds *before* `src/` deletion. `APPR-5` guards future
  dispatch surfaces. `APPR-7` files the upstream enforcement-breadth question.

**Deliverable.** `v0.6.0`: `src/` gone (~103k lines), `git ls-files src/` empty; the gate
stack runs only against the real app; the two data-loss bugs fixed; gateway/OCR/keychain
hardened; every dispatch path provably gates (wire-probe green). **Exit:** all of M2's tasks
merged with green gates; `npm run test` count drops to the retargeted set; `node
scripts/smoke-gate-enforcement.mjs` exits 0.

> ⚠ **Sequencing rule:** `LEG-3` (delete) lands **last** in Track A — only after SEC-1 +
> TCI-5/6/7 prove the replacement guards exist. `lib.rs` lanes (`DEBT-3`, `SEC-2`, `TCI-4`)
> serialize; `useChatEvents.js` lanes (`DEBT-1`, `APPR-2`) serialize.

---

## M3 — The front door + product craft  *(the north-star)*

**Goal.** Realize DESIGN.md's *anticipation* law and the elite chat patterns: the app opens
to a prepared brief, agent work is legible, and every surface is calm and on-brand.

**Track A — Desk-lite front door (the headline; sequenced):**
1. `DESK-1` — define the front-door data contract: probe the sidecar for cross-thread
   *pending gates* + *recent handled runs/automations* (file an upstream `/api` ask if the
   feed isn't readable).
2. `DESK-2` — the **needs-you** gate strip above the greeting (ranked ≤5, gold, one action
   each) → `DESK-3` — the **handled** receipts feed → `DESK-4` — composition + honest empty
   state (calm greeting when nothing is backed).

**Track B — chat craft (parallel lanes, the 14 competitor patterns):**
`CHAT-1` receipt cards for completed tool results (shipped) · `CHAT-2` artifact chips
(incl. agent-generated markdown, generated binary-file chips, original-byte save, and saved `/work` reader) ·
`CHAT-3` one-line tool rows · `CHAT-4` bubble-less assistant · `CHAT-5` "+"-sheet composer
(kill chip soup) · `CHAT-6` attachment thumbnails above user bubbles (shipped for available
image payloads; metadata-only reload images stay as chips) · `CHAT-7` grouped model picker
(shipped for normal chat: Active/Available grouping, NEAR labels, expert-only raw model id
override).

**Track C — design-system + a11y (parallel):**
`DSYS-1` calm density (kill shimmer) · `DSYS-2` empty/loading dignity · `DSYS-3` accent
discipline · `DSYS-4` terminology/de-jargon sweep + lexicon in DESIGN.md · `DSYS-5` AI-tell
copy-lint · `A11Y-1` axe gate · `A11Y-2` semantic-token sweep (~348 raw status colors) ·
`A11Y-3` keyboard/focus · `A11Y-4` reduced-motion + AA contrast.

**Deliverable.** `v0.7.0`: the app opens to a prepared Desk-lite brief; chat reads like an
elite assistant; zero shimmer, one accent per screen, axe-clean. **Exit:** DT-1 (cold-open)
/ DT-2 (dominance) / DT-3 (bicolor) / DT-6 (gate) score green; DT-4/DT-5 show zero shimmer +
one-accent-per-screen; axe reports no serious/critical violations.

---

## M4 — Capability leap

**Goal.** The model can do visibly more without leaving the app, and connectors feel
one-click, obvious, and honest.

- **Visualizations:** `VIZ-1` SVG/table CSS hardening → `VIZ-2` **mermaid** (lazy, sanitized,
  on-click, now shipped) → `VIZ-3` the **render==export law** (same AST screen↔export; real lists/links/
  tables in DOCX; whole-conversation export; diagram image export — building on the
  byte-accurate PDF/DOCX already shipped).
- **Connector parity:** `CONN-1` connected-state chips + disconnect · `CONN-2` in-chat
  "Connect X" affordance when the model lacks a tool · `CONN-3` custom remote MCP add
  (shipped client-side for unauthenticated HTTPS/local MCP URLs; OAuth custom MCP remains upstream).
- **Native macOS:** `MAC-1` Spotlight thread indexing (wire the existing `spotlight.rs`) ·
  `MAC-2` TTS · `MAC-3` Notes/file thread export · `MAC-4` vibrancy + traffic-light inset ·
  `MAC-5` tray status + sidecar-death notification.
- **Deferred-from-earlier:** `SEC-6` (tamper-evident settings/SSRF), `PERF-3/5/6` (route
  code-split, transcript virtualization, OCR/startup tuning).

**Deliverable.** `v0.8.0`: diagrams render and export losslessly; connectors connect in one
clear action; Spotlight finds threads, TTS speaks, vibrancy lands. **Exit:** a `mermaid` fence
renders + exports as an image; a generated DOCX appears as an artifact chip → preview → save;
Spotlight surfaces a thread by content.

---

## M5 — Backend-dependent surfaces  *(tracks the gateway, filed not faked)*

**Goal.** Light up the hidden surfaces honestly **as the gateway gains the endpoints**, and
keep the "Not available on this gateway yet" stub everywhere it can't.

- **File the upstream asks now** (`UP-1..6`): hosted Google OAuth (B1), generated images
  (B2), live token validation (B3), work-item persistence, council multi-model + the gateway
  delete/revoke/usage holes, and the **M2 main-sidecar adoption decision** (enumerate the 42
  bundled-binary patches vs what main buys).
- **Un-hide surfaces as their api libs leave stub state** — `workspace`, `projects`, `jobs`,
  `routines`, `missions`, `admin` (and the hidden Settings tabs: agent/channels/networking/
  tools/skills/users). Each ships only when its endpoint is real (honest-by-construction).

**Deliverable.** Continuous: each hidden surface flips visible the sprint its backend lands.
**Exit (per surface):** real endpoint wired, capability-probed, no false-ready state.

---

## Dependency view (the backbone)

```
M1  DIST-1 → DIST-2 → DIST-3 → DIST-5 → tag v0.5.0      (DIST-4, SEC-7 parallel)
M2  SEC-1 ─┐
    TCI-5/6/7 ─┼─→ LEG-2 → LEG-3 → LEG-4 → TCI-8        (delete gated on guards existing)
    LEG-1 ────┘
    DEBT-1 → DEBT-2 ;  DEBT-3/4/6/7, TCI-1-4, SEC-2-5  (parallel)
    APPR-1 → APPR-2 → APPR-4/APPR-6 ;  APPR-3, APPR-5  → v0.6.0
M3  DESK-1 → DESK-2 → DESK-3 → DESK-4                   (CHAT-*, DSYS-*, A11Y-* parallel) → v0.7.0
M4  VIZ-1 → VIZ-2 → VIZ-3 ;  CONN-*, MAC-*, SEC-6, PERF-3/5/6 → v0.8.0
M5  UP-1..6 filed ;  un-hide surfaces as endpoints land
```

## Risks & human decisions (unchanged but restated for this plan)

- **M1 blocker:** the Apple Developer ID cert + notarization credentials. Code lands now;
  proves green only once you provision them.
- **M2 decision:** `UP-6` main-sidecar adoption — enumerate the 42 uncommitted bundled-binary
  patches before deciding; it's a tradeoff, not a build.
- **Notarization trap:** hardened-runtime entitlements too tight → the wasm/sidecar crashes
  on notarized builds; too loose → guts the CSP. `SEC-7` gates this.
- **`SEC-4` keychain fallback is DO-NOT-REMOVE** (a real 6-hour production incident) — only
  make the local-token write conditional.
- **Re-verify before executing:** all line numbers (code moves); the universal-binary sidecar
  resolution (`DIST-3`); whether tray/notifications already exist (`MAC-5`); the DESK-1 data
  sources (may surface a real upstream `/api` need).

---

*Companion: [`CODEX-WORKPLAN.md`](./CODEX-WORKPLAN.md) holds the per-task lanes, owned files,
and acceptance checks. This document is the milestone sequence; that one is the task catalog.*
