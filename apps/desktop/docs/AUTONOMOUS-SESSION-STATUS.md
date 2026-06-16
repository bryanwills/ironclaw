# Autonomous build session — status snapshot

Captured at the end of the ~3-hour autonomous build window the lead
delegated. This is the "what landed, what's pending, what's broken"
sheet — read this first when you come back.

## CURRENT — v0.4.141 (read this first)

The trail has continued well past the v0.3.3 snapshot below. As of v0.4.141 the
app shipped the Workspace OS surfaces (Today/dashboard, Desk, Streams, Canvas,
Memory, Mini, IronHub) and a multi-agent product review (ICD-001…010) covering
home/IA reconciliation, token-storage truth, provider honesty, a shared confirm
dialog, a lightweight streaming renderer, lazy-mounted overlays, and an
accessibility sweep across all 15 routes. The current route map, shortcuts,
token-storage model (Keychain + owner-only 0600 fallback), and security model
are documented in [`README.md`](../README.md) and
[`ARCHITECTURE.md`](../ARCHITECTURE.md) — those are the sources of truth.

Everything below this line is a **historical snapshot from the v0.3.3 window**;
its "pending/broken" items have since been addressed or superseded. Keep it for
provenance, not as a live to-do list.

## EARLIER — v0.3.3 + production build validated (historical snapshot)

Trail now **v0.2.20 → v0.3.3** (10 tags). Since the v0.3.0 cut:

- **R89/R68 recap** shipped — a non-destructive "Recap" panel that
  summarizes a thread (summarize util + one-off completion, never mutates
  the transcript) and shows **R92 thread stats** (count / est. tokens /
  span) from the same history.
- **Waves 6 & 7** added six pure utils. Honest finding: only three had a
  _safe_ consumer and are wired — `format-time`→streams, `fuzzy`→omnibar
  recall, `thread-stats`→recap. The other three (`cost-estimate`,
  `text-diff`, `contrast`) are tested library code with **no safe consumer
  today** (usage dashboard uses server-provided costs; prompt-diff has a
  working bespoke LCS; tints are curated presets). I deliberately did NOT
  retrofit working surfaces just to use a util — that's over-engineering.
- **Production build validated** (`npm run tauri build`, exit 0):
  `IronClaw.app` refreshed to **0.3.3** (was stale at 0.2.10), DMG (~52 MB)
  builds. Updater `.sig` needs `TAURI_SIGNING_PRIVATE_KEY` (CI secret) —
  local bundle unsigned by design.
- A focused **second review** of the post-v0.3.0 code is queued/running.

Candor: the app is feature- and test-complete (60 test files, 457+ cases,
0 type errors). Genuine high-value work has thinned — I've stopped
manufacturing util waves and am pacing on real QA + release validation
rather than padding. Standing blockers unchanged: **R76 GitHub billing
(your action)** and the gateway sub-agents endpoint.

---

## v0.3.0 cut

**The elite milestone shipped: tag `v0.3.0` is pushed.** Second window
extended the trail to **v0.2.18 → v0.3.0** (tags v0.2.20, .21, .22, .23,
.24, then v0.3.0).

Sequence this window:

1. Landed all of Waves 1–5 (R49–R88) to `main` — sub-agents (graceful
   404 degrade), workspace files, spatial canvas + canvas v2 (nodes
   dispatch sub-agents), the R85/86/87 utils, and their UI integration
   (HTML export menu, omnibar message search).
2. Ran an **Opus 4.8 full-codebase + functionality review** (the lead's
   explicit ask). Verdict: "high-quality, security-conscious." It found
   **one P0** — an AppleScript injection in `notes_export.rs` (untrusted
   body interpolated into script source) — now fixed by switching to the
   `on run argv` pattern (+2 Rust tests). Plus two P1s in the new Wave-5
   code (omnibar per-keystroke IDB fan-out → cached per-open; canvas
   effect over-write → diff-guarded) and two P2 hardenings. All in
   v0.2.24.
3. R71 a11y pass on the new surfaces (streams filter `aria-pressed`; the
   rest were already clean). Cut **v0.3.0**.

Health at v0.3.0: **408/408 vitest, 0 svelte-check errors, cargo check +
Rust unit tests clean, production build OK, bundle budget within limits.**

### Still open

- **R76 (GitHub Actions billing)** — jobs fail to start (~3s) with a
  spending-limit message. NOT code-fixable: the lead must update
  **GitHub → Settings → Billing & plans**. The signed-DMG release
  workflow fires on the `v0.3.0` tag once billing is restored (re-run
  the tag or push a patch tag). Local pre-push hook runs the full
  check+test suite, so correctness stays gated meanwhile.
- **R68 / R89 (auto-summarization wiring)** — the `summarize.ts` util is
  shipped + tested, but folding old turns into a summary stub mutates the
  transcript; that UX (destructive replace vs. non-destructive recap,
  persistence, expand/collapse) deserves a design call rather than an
  autonomous guess. Left as a focused follow-up; the util is ready to wire.
- **R74 (fresh-user simulation v3)** — needs a real app launch / DMG;
  deferred until the build artifact exists (gated by R76).
- The bundled `IronClaw.app` on disk is still old — rebuild via
  `npm run tauri build` (or the CI release once billing is back).

## What shipped (eight tags)

| Tag         | Highlights                                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v0.2.10** | First public release of the v0.2.x trail                                                                                                                                                       |
| **v0.2.11** | Chat attachments — PDF/DOCX/XLSX/PPTX/CSV/TXT/MD/JSON (was image-only)                                                                                                                         |
| **v0.2.12** | R49 lazy-load routes, R50 TTS, R52 chat tabs, R53 Mermaid/Plotly/KaTeX, R55 Omnibar, R60 Spotlight, R62 IDB cache, R63 vibrancy, R65 skill editor, R69 editable bubbles                        |
| **v0.2.13** | R73 review P0 security batch — XSS sanitization on the three renderers, dev-shim backdoor patched, TTS length cap, Omnibar SvelteKit `goto`, ChatTabs nested-button fix, R51 voice answer mode |
| **v0.2.14** | R54 thread sync long-poll, R58 replay UI, R59 replay wire, R64 mini-mode, R79 reply-thread wire, R82 generative widgets, bundle budget bumped 110→1500 KB for Plotly lazy chunk                |
| **v0.2.15** | R77+R78 Dashboard + tiles, R83 model presence strip on Council                                                                                                                                 |
| **v0.2.16** | R67 /imagine slash command, R80 reply-thread UI panel, R81 streams route                                                                                                                       |
| **v0.2.17** | R61 Apple Notes export, chat-tabs Cmd+W close + Cmd+1..9 jump                                                                                                                                  |

365/365 vitest passing at HEAD. 0 svelte-check errors. Cargo check
clean.

## What's still in flight

- **R66 Python REPL block runner** — codex agent dispatched at end of
  session, brief at `docs/codex-tasks/66-python-repl.md`. Should land
  shortly after session end. Check `.codex-worktrees/r66/` and run
  the cherry-pick + push cycle when it finishes.
- **R56 sub-agent dispatch wire** — BLOCKED. The gateway endpoint
  `/api/v1/tasks` returned 404 against baremetal3 v0.29 on probe.
  Either land the endpoint upstream OR ship a graceful "not
  supported" fallback in the client. R57 (sub-agent UI) is gated on
  this.

## Known issues / follow-ups

### From the v0.2.12 elite review (`R73` output)

**Resolved** (P0):

- ✅ XSS via Mermaid (DOMPurify on output)
- ✅ XSS via KaTeX (sanitize + trust:false + strict:'ignore')
- ✅ XSS via Plotly (recursive sanitize, drop javascript: URIs)
- ✅ Dev shim refuses to install when `protocol === 'tauri:'`

**Resolved** (P1):

- ✅ Omnibar uses SvelteKit `goto` (no full-page reloads)
- ✅ TTS length cap (4 KB)
- ✅ ChatTabs nested-button fix

**Still outstanding** (P1 — reviewer flagged but not yet addressed):

- **Cmd+Space ↔ macOS Spotlight collision** — review claimed conflict.
  Inside the app window, our handler wins because the focused app
  consumes the keydown before the OS routes to Spotlight. Verify
  in the rebuilt `.app`; if it actually conflicts in production,
  swap to Cmd+J or Cmd+Shift+Space and update docs.
- **`reveal_in_finder` takes arbitrary path from JS** — restrict to
  paths under `app_data_dir`.
- **`http:default` capability allows `https://**`** — lock to
`127.0.0.1:\*` + the configured remote.
- **Spotlight index has no aggregate size cap** — add LRU sweep at
  ~100 MB.
- **`+page.svelte` is now ~3900 LOC, `settings/+page.svelte` ~4000** —
  decompose. Not blocking ship; tech debt.
- **20+ stores + 20+ components have no test coverage** — see review
  for the list.

### Operational

- **GH Actions still blocked on billing** (R76, unchanged through
  the session). Fix at github.com/settings/billing then delete +
  re-push the tags to trigger signed-DMG release builds:
  `git tag -d v0.2.17 && git push origin :refs/tags/v0.2.17 &&`
  `git tag v0.2.17 && git push origin v0.2.17`
- **The bundled `.app` is still v0.2.10** at
  `~/openclaw-knowledge/ironclaw-desktop/src-tauri/target/release/bundle/macos/IronClaw.app`.
  Run `npm run tauri build` to get v0.2.17 with all new features
  including Dashboard, replay bar, mini-mode, voice answer, etc.

## What's pending (by priority for next session)

1. **R66 Python REPL** — let the codex agent finish, cherry-pick.
2. **R56 unblock** — either land `/api/v1/tasks` upstream OR document
   the client-side fallback path so R57 can ship.
3. **R71 a11y v2 audit** — scan-only pass over the eight new
   surfaces shipped this session.
4. **R72 E2E expansion** — at least one Playwright spec per
   v0.2.13–v0.2.17 surface (omnibar, replay, dashboard, mini, voice,
   editable bubble, skill editor, streams, reply-thread).
5. **R84 spatial canvas (tldraw)** — the only Wave 3+ feature not
   yet attempted.
6. **The "Cmd+Space conflict" check** — verify by hand once the .app
   is rebuilt; either close the review thread or swap shortcut.
7. **`reveal_in_finder` + `http:default` capability tightening** —
   small Rust changes, P1 security debt.

## Where things live

- Roadmap + waves: `docs/ROADMAP-ELITE.md`
- Workspace OS architectural shift (Dashboard / Streams / etc.): `docs/WORKSPACE-OS.md`
- Lane discipline + file ownership: `docs/SWIMMING-LANES.md`
- Codex task briefs: `docs/codex-tasks/`
- Parallel dispatcher: `scripts/codex-dispatch.sh`
- This status doc: `docs/AUTONOMOUS-SESSION-STATUS.md` (you're reading it)

## Stack snapshot

- Tauri v2.2 + macos-private-api + window-vibrancy 0.5
- SvelteKit 2.x + Svelte 5 runes (`$state`, `$derived`, `$effect`)
- TailwindCSS 3
- TypeScript ~5.x (strict)
- Vitest 4.x (365 tests)
- Rust 1.80+ (cargo check clean)
- Gateway: IronClaw v0.29 on baremetal3.agents.near.ai via SSH tunnel `18789`

## Tunable knobs to try first when something looks broken

1. `npm run check && npm run test` — full local CI gate (fastest)
2. `bash scripts/check-bundle-size.sh` — bundle budget
3. `cargo check --manifest-path src-tauri/Cargo.toml` — Rust health
4. `npm run tauri build` — produce a fresh `.app` (5-10 min)

If launching the `.app` shows "Disconnected": (a) verify SSH tunnel
is up (`pgrep ssh.*18789`), (b) check
`~/Library/Application Support/com.openclaw.ironclaw-desktop/settings.json`
points at `http://127.0.0.1:18789`, (c) check
`tokens/gateway-token_default.token` has the 64-char bearer.

## Worktrees state

```
.codex-worktrees/
  r66/    ← in flight (Python REPL)
.claude-worktrees/
  r77/    ← merged, can remove
```

Cleanup command for stale entries:

```
git worktree prune
git branch -D $(git branch --list 'codex/r6*' 'claude/r7*' | xargs)
```

Session ended at v0.2.17.
