# Design-pass research synthesis — 2026-06-10

Distilled from: NEAR Private Chat competitor kit (per-screen precedents + 89 screenshots), the three IronClaw competitive PDFs, the June 1 desktop design program (vision / gaps / hostile review / soul-md / grounded-redo / program / state-pass), and the desktop copy audit. Read together with the same-day live design audit (44 screenshots, /tmp/design-audit/) whose findings are tracked separately.

Context: the June 1 program and copy audit were written against the old Svelte client. The current app is the rebuilt static UI (i18n'd, 11 languages); nav is Chat / Workspace / Projects / Jobs / Missions / Automations / Routines / Extensions / Settings / Admin + Login + Onboarding. Today/Desk/Work/Canvas from the June 1 vision do not exist in this build, while DESIGN.md still mandates them.

## A. Desktop-applicable competitor patterns (priority-tagged)

1. **Receipt card for agent actions** (Claude: icon + "✓ 1 New Client Entry Created" + field rows + deep link). Lands in tool-result rendering and any handled/receipts feed; gold attribution. HIGH.
2. **File artifact chip with preview/download** (Claude: kind icon + name + "Spreadsheet · XLSX" + download). Lands on document-preview-on-chip-click; same chip grammar for generated work products, not just uploads. HIGH.
3. **One-line collapsed tool steps inline in the answer** (Claude's quiet "🔍 Searched: …" row; avoid ChatGPT's heavy thinking-trace cards). Existing aggregates ("explored 3 files") become the only in-answer chrome, expandable to Details/Parameters/Result. HIGH.
4. **No-bubble assistant messages, flush on canvas; user message in a subtle bubble** (Claude + ChatGPT). HIGH.
5. **Single "+" on the composer opening a small sheet; no persistent tool-chip row** (Gemini pill primary, ChatGPT "+"-sheet secondary; ChatGPT's persistent chip row is the named failure). HIGH.
6. **Model picker: chip → list with plain-language one-liners, grouped (Active / Ready / Needs setup), "Manage providers" escape hatch** (Claude positive, Gemini header-dropdown negative). MEDIUM.
7. **Attachment thumbnails above the user bubble as rounded images** (ChatGPT, Gemini). MEDIUM.
8. **Citations grammar, only when real** (Perplexity: superscript pills, source rail above answer, tap → detail with favicon/domain/title/snippet/Open/Copy; domain shown as `example.com`). Gated on the gateway actually doing web search. MEDIUM.
9. **Compact "N sources" pill for condensed modes** (Perplexity voice). LOW.
10. **Empty-state restraint** (Claude calm; Perplexity recents-only-if-recents-exist). Enforce caps: ≤3 suggestions, resume rail only when threads exist, no setup-recovery card as primary. MEDIUM (guard).
11. **In-chat permission/auth gate as quiet inline card with one action** (Claude's permission row). Existing authGate is the right shape; style as a distinct card, never a modal interrupt. MEDIUM.
12. **"Connect the tools you already use" + recognizable logos** for connectors (Claude, Gemini). Lands in Extensions registry + onboarding provider step. MEDIUM.
13. **Settings: sections + search + advanced behind disclosure** (Claude reference; avoid ChatGPT depth). Demote operator-grade tabs below daily ones. MEDIUM.
14. **Rich inline widgets as contained rounded cards with expand affordance** (Gemini map card). Mermaid/Plotly. LOW.

## B. Previously-identified gaps still open

1. **The anticipation law has no surface** (vision, gaps DT-1, DESIGN.md): app opens to greeting+suggestions, not a prepared brief. Largest unresolved decision: fold needs-you gates + handled receipts above the chat greeting, restore a Today surface, or amend DESIGN.md.
2. **Document preview / artifact home** (grounded-redo): chip-click preview coming; extend to artifact promotion (save answer/document into a Project).
3. **Render == export invariant** (hostile review reproduced byte-level loss: lists/links/blockquotes/math/escaped-pipe tables; DOCX without numbering.xml; no whole-conversation export on default path; no PDF). Carry into DESIGN.md as law; re-verify on this codebase.
4. **Persona/system-prompt delivery** (hostile review #1/#2: per-thread prompts silently dropped; voided by attachments while a gold chip claimed otherwise). New i18n has no per-thread-prompt strings — decide surface; wire-verify delivery on the attachment path if it returns.
5. **soul.md personalization + format contract** (designed in full; absent from build).
6. **Scheduled-work IA fragmentation**: Missions / Automations / Routines are three sibling stories ("Execution loops" / "Scheduled work" / "run or pause them without leaving v2" — jargon leak). One story needed.
7. **Approval enforcement breadth** (June 1 ship-gate): UI now gates tool calls with risk labels + "Approve & always allow" — looks right, but enforcement is a wire property; keep on the verification list.
8. **Copy carry-overs**: login hero "Local agent control without losing the operator trail" = the over-explained jargon the audit cut; "operator" = fourth persona word; "TEE Attestation" as user-facing title; Projects empty states lecture.
9. **Design-test series never run against this build**: DT-1 cold-open, DT-2 primary-action dominance, DT-3 bicolor attribution, DT-4 calm density, DT-5 empty/loading dignity, DT-6 gate craft — the acceptance harness for this pass.
10. **Notarization** (ship gate, infra).
11. **Mermaid/Plotly image export** (P1 in grounded-redo; no evidence of fix).

## C. Anti-patterns to enforce

- Wallpaper trust signals: TEE shield stays icon-only click-to-disclose; popover title in plain language; never a banner.
- Jargon in primary copy (attestation, enclave, hash, endpoint, console, "Gateway v2", the "operator" family). Digest values: prefix…suffix + copy button (Phantom pattern), never hex walls.
- Accent discipline: one blue action per screen; gold strictly agency. Risk: dense tables (Jobs/Admin), mission cards, blue status chips.
- Chip soup near the composer: greeting + resume + suggestions + model chip + Auto-review + Work-locally ≈ six chip families already; cap and collapse.
- Shimmer/pulse skeletons, spinner-as-content: calm fade only (DT-4/DT-5).
- False-state copy: never render a capability the gateway can't back ("Not available on this gateway yet" is the designed state). Risk: Extensions registry, provider rows.
- Two dominant actions on one surface (DT-2): Missions "Fire now"; Projects "New project" vs "Create from chat" vs "Open workspace".
- Setup as a permanent surface: onboarding provider picker must not persist after first run.
- AI-tell microcopy: triads/quads, "not X but Y", em-dash padding. Risk: Projects, onboarding.
- Exception note: the NPC kit bans Inter as an AI-default — that was iOS house style; IronClaw DESIGN.md locks Inter Variable and wins.

## D. Auth flow precedents

- Screen shape: Claude's auth — one sentence of promise, stacked full-width provider buttons, legal as quiet footnote; avoid ChatGPT modal-stack onboarding. Make NEAR AI the visually-default card; keep token-paste as the no-account path.
- The bundled wallet window already has the right choreography: status line progressing "Choose a wallet to continue… → Approve the signature in your wallet… → Signed. You can close this window," clean cancel/failure, result posted back. The in-app NEAR sign-in window keeps this three-step status-line pattern + the resume state ("Found an existing NEAR AI session — connecting…"); signed-in account as prefix…suffix.
- Mid-session auth belongs inline (authGate cards), never modal.
- From the PDFs: friction is the killer (credit-card walls, manual account creation = #1 complaint; every competitor starts free); "60 seconds to your first agent" time budget; keep an account-free path alive (avoid Grok's posture).
- Copy: system-behavior language — "not recorded," "cannot be linked," "verified"; never bare "anonymous," never "fully secured."

## E. Top 12 synthesis (ordered)

1. Resolve the front-door contradiction (prepared brief vs greeting) — everything inherits from this.
2. Document preview as the Claude artifact chip (side panel: kind icon, name, size, extraction state, page/sheet-aware text, Open/Save); same chip for agent-generated files.
3. NEAR sign-in window around the proven choreography (promise sentence, NEAR dominant, three-step status line, resume state, prefix…suffix account, token-paste quiet fallback).
4. Receipt-card grammar for every completed agent action (✓ outcome, fields, deep link, undo where real, gold attribution).
5. One-line tool rows as the only in-answer chrome; assistant prose bubble-less and flush.
6. Gate craft to DT-6 (plain action, what it touches, what leaves the machine, risk labels, "Nothing sent yet," blue Approve ⌘⏎ / quiet Deny Esc, gold context header) + wire-verify enforcement.
7. Terminology sweep: one persona word (retire "operator"), one scheduled-work story, "IronClaw Desktop" not "console," kill "v2" leakage; table the lexicon in DESIGN.md.
8. De-jargon the trust surface ("Verified runtime" title; digests in detail rows with copy buttons).
9. Write render==export into DESIGN.md as law and re-verify (same markdown AST both sides; real lists/links/tables in DOCX/HTML; whole-conversation export; PDF; diagram image export).
10. Empty/loading dignity pass (DT-5) over all 13 surfaces.
11. File-type honesty for .doc/.xls: specific "Save as DOCX/XLSX and re-attach" guidance.
12. Run the design-test series (DT-1/2/3/4/6) as the acceptance gate, each closed with rendered before/after evidence.

Scope note: research/ironclaw-design-handoff is the ironclaw.com WEBSITE kit (FK Grotesk/black-bg) — confirms #0091fd and keeps the mascot off product surfaces; otherwise not applicable to the desktop app.
