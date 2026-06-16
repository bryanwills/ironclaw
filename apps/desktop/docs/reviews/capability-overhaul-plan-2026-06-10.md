# Capability Overhaul Plan — 2026-06-10

Source: 4-auditor workflow (Gmail OAuth / downloads / visualizations / gate UX) + skeptical classifier,
all verdicts anchored to the constraint **"don't go ahead of the code in main branch."**
Empirical anchors: the bundled sidecar AND the main-built candidate (`/tmp/ironclaw-reborn-main-candidate`)
were both spawned hermetically and probed; the running app was probed read-only.

## Headline inversions of prior assumptions

1. **One-click Gmail/Google OAuth needs NO sidecar swap.** The bundled binary already contains the
   complete Reborn product-auth surface (routes, PKCE flow, signed state, gate challenge with
   `authorization_url`). Proven by spawning it with `GOOGLE_CLIENT_ID` + `GOOGLE_OAUTH_REDIRECT_URI`:
   `POST /api/webchat/v2/extensions/gmail/setup/oauth/start` → 200 with a real
   `accounts.google.com/o/oauth2/v2/auth` URL — byte-equivalent to main. The "Paste access token"
   card exists because `src-tauri/src/sidecar.rs` passes the WRONG env: the Railway relay vars
   (`IRONCLAW_OAUTH_EXCHANGE_URL`…) appear ZERO times in the binary's strings — dead weight from the
   legacy lineage. Without Google env, the challenge provider returns None and the UI defaults to
   `manual_token`. Our static UI is already fully built for the OAuth path (auth-oauth-card,
   BroadcastChannel completion, SSE-driven gate clear).
2. **Downloads shipped broken because the fix half-exists, unused.** `save_text_dialog`
   (lib.rs:1036, dialog plugin initialized) has ZERO JS callers; every export uses blob-URL +
   anchor-click, a silent no-op in Tauri v2 WKWebView. The smoke only tested blob builders, never
   file-on-disk — which is exactly why this shipped.
3. **The role==='image' bubble branch is dead code** on both lineages (no image MessageKind, no SSE
   variant). "Generated images" is an upstream ask, not a UI bug.

## Fixability table

| # | Capability | Verdict | Effort | Depends |
|---|-----------|---------|--------|---------|
| D1 | `save_bytes_dialog` Rust cmd + `saveBlob` JS shim (desktop→dialog, hosted→anchor) | CLIENT | M | — |
| D2 | Per-message MD/HTML/PDF/DOCX/JSON exports → saveBlob | CLIENT | S | D1 |
| D3 | Thread MD/JSON export → saveBlob + toast | CLIENT | S | D1 |
| D4 | Settings export → saveBlob | CLIENT | S | D1 |
| D5 | Save original attachment from preview modal | CLIENT | S | D1 |
| D6 | Headless file-on-disk smoke proof (dialog-bypass seam under smoke mode) — ships WITH D1 | CLIENT | S | D1 |
| A1 | `window.open` → `openExternalUrl` (auth-oauth-card.js:51, useExtensions.js ×3, configure-modal.js) — raw window.open spawns a cookie-less child webview; OAuth cannot complete in it | CLIENT | S | — |
| O1 | Gmail OAuth env wiring: pass `GOOGLE_CLIENT_ID` (+opt secret) and `GOOGLE_OAUTH_REDIRECT_URI=http://127.0.0.1:{port}/api/reborn/product-auth/oauth/google/callback`; delete dead relay vars; settings field for BYO client id | CLIENT | M | A1 + user's Google client |
| O2 | Gate-card UX: provider display map, why-explanation, "Get a token" via openExternalUrl, scope chips from setup route, reveal toggle, success beat | CLIENT | M | A1 |
| A2 | Cancel feedback ("Run stopped — credential not provided") | CLIENT | S | — |
| A3 | "Resuming run…" status off blocked_auth→running transition | CLIENT | S | — |
| A4 | Pre-emptive connect: gate-card deep link to the existing-but-orphaned `?setup=1&focus=<ext>` Extensions flow | CLIENT | M | O2 |
| V0 | SVG max-width + table overflow CSS hardening | CLIENT | XS | — |
| V1 | Mermaid (lazy vendored v11, on-click render, sanitized) — **ahead of main's UI; owner gate** (model emits mermaid fences unprompted; recommend YES) | CLIENT* | M | owner |
| V2 | Charts — no plotly anywhere on main; mermaid pie/xychart only if V1 | CLIENT* | S | V1 |
| V3 | KaTeX math — main shows raw $…$ too; **recommend SKIP for parity** | CLIENT* | M | owner |
| M1 | Approval-gate `allow_always` flag (main-only field) | MAIN | S | Phase 2 |
| M2 | Main-sidecar adoption — **NOT needed for Gmail** (proven); buys M1 + Notion DCR + #4717; costs the 42 uncommitted patches. **Defer.** | MAIN | L | owner |
| B1 | Hosted/zero-config OAuth (no BYO Google client) — no default client upstream; relay unread by this lineage | BLOCKED | — | upstream |
| B2 | Generated images — no image MessageKind/SSE variant on either lineage | BLOCKED | — | upstream |
| B3 | Live token validation + scopes/help_url on the auth prompt | BLOCKED | — | upstream |

## Sequence

**Phase 1 (no decisions needed):** D1+D6 → D2–D5 → A1 → A2+A3+V0 → O1 (after two empirical checks:
full consent round-trip with a real client; token exchange with/without client secret) → O2 → A4.

**Phase 2 (deferred):** main-sidecar adoption is a genuine tradeoff (42 uncommitted patches vs
M1/Notion-DCR/#4717). Before asking the owner to decide: enumerate the 42 patches one line each.

**Phase 3 (owner gates + upstream):** V1/V2 mermaid (recommend yes), V3 KaTeX (recommend no);
file B1/B2/B3 issues on nearai/ironclaw.

## What the user must supply for O1 (cannot be code'd around — B1)

A Google Cloud OAuth client (Desktop-app type; loopback redirect with variable port is allowed for
Desktop clients), with Gmail scopes on the consent screen. Until a NEAR-hosted verified client
exists upstream (B1), this is bring-your-own; the settings surface + setup guide make it a
5-minute, one-time step. Token-paste remains the working fallback.
