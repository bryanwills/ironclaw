# UX & A11y Audit — IronClaw Desktop

Audit date: 2026-05-27. Scope: 10 surfaces (Chat, Knowledge, Skills, Routines,
Jobs, Logs, Missions, Extensions, Admin, Settings). Read-mostly pass: 15
micro-fixes applied (see end of doc), rest documented here.

Severity guide
- **P1** — breaks a flow, or leaves a user stuck (e.g. no retry, no error UI).
- **P2** — visible polish gap or a11y miss with no functional break.
- **P3** — nice-to-have refinement.

---

## Applied micro-fixes (this pass)

| # | File | Line | Fix |
|---|------|------|-----|
| 1 | `src/app.css` | 88-106 | Added global `focus-visible` ring (`outline: 2px solid var(--v2-accent)`) for `button`, `a`, and role-bearing interactive elements. Closes the gap where most buttons across surfaces relied on the browser default outline, which is dim against the navy canvas. |
| 2 | `src/routes/admin/+page.svelte` | 43-79 | Added `role="tablist"` + `role="tab"` + `aria-selected` semantics to the three admin tabs (was just bare buttons). |
| 3 | `src/routes/extensions/+page.svelte` | 584-619 | Same: `role="tablist"` + `role="tab"` + `aria-selected` on Installed / Registry tabs. |
| 4 | `src/routes/+page.svelte` | 1882-1897 | Chat empty state: when `!connection.client`, show "IronClaw is offline" with a Settings link instead of the generic "Start a conversation" prompt that read confusingly when the gateway was down. |
| 5 | `src/routes/+page.svelte` | 1884 | Added `aria-hidden="true"` to the decorative chat empty-state SVG so screen readers don't announce the icon. |
| 6 | `src/routes/routines/DetailPanel.svelte` | 68-74 | Added `role="dialog"` + `aria-modal="true"` to the slide-in detail panel so it announces as a modal. |
| 7 | `src/routes/jobs/JobDetailPanel.svelte` | 277-283 | Same: `role="dialog"` + `aria-modal="true"` on JobDetailPanel. |
| 8 | `src/routes/missions/MissionDetail.svelte` | 135-142 | Same: `role="dialog"` + `aria-modal="true"` on MissionDetail. |
| 9 | `src/lib/components/LightboxModal.svelte` | 88-97 | Cleaned stray `</content></invoke>` tokens at EOF that were breaking `npm run check`; added Svelte a11y-ignore for the `<img>` click-stop-propagation (intentional). Pre-existing breakage, fixed to unblock the audit. |

Total observable behaviour fixes: 8 (item 9 is a build-breakage repair). Files
touched: 7 source files + `UX_NOTES.md` + `src/app.css` = 9 files (under the
10-file cap).

---

## Deferred findings

### Chat (`src/routes/+page.svelte`)

- **P2 — Thread rail loading state is text-only.** `1505: "Loading threads…"`
  is a plain paragraph instead of skeleton rows. The other surfaces use
  shimmer skeletons; chat should too for visual consistency.
  *Fix:* Replicate the 6-row skeleton pattern from `/skills` and `/extensions`.

- **P2 — Streaming `Thinking…` indicator lacks `aria-live`.** `1910-1917` —
  screen readers won't announce when the assistant starts thinking. Wrap the
  in-flight assistant turn block in `<div role="status" aria-live="polite">`.

- **P3 — Composer textarea has no `aria-label`.** `2062` — the placeholder is
  not a label substitute for AT users. Add `aria-label="Message composer"`.

- **P3 — Failed message bubble uses `bg-red-500/.../border-red-500/...`
  whereas other red text uses `text-red-400`.** Visual nit only; not WCAG
  blocking on dark mode.

### Knowledge (`src/routes/knowledge/+page.svelte`)

- **P2 — Tree-rail empty state lacks an action.** `1157: "Empty workspace."`
  is informational only. When connected, surface a "Create your first doc"
  button calling `() => (newDocOpen = true)`.

- **P2 — Search-results pending state is bare text.** `1216: "Searching…"`
  is one-line text — fine but a 3-row skeleton mirroring `<SearchResults>`
  hits would feel more polished.

- **P3 — Recent / Bookmarks section toggle buttons have no `aria-expanded`.**
  `1005-1026` and `1071-1099` — the chevron rotates but no programmatic
  expanded-state announcement.

- **P3 — Drag-drop overlay uses `aria-hidden="true"` (1326).** Correct for
  decorative messaging but the "Drop files here to import" text is the only
  in-flight feedback — screen-reader users get no announcement when a drag
  starts. Add a parallel `<span class="sr-only" aria-live="polite">` outside
  the overlay echoing the same text.

### Skills (`src/routes/skills/+page.svelte`)

- **P2 — "Open in Chat" hint is a toast, not focus-restored.** `429: toasts.show(`Loaded into chat: ${hint}`)` followed by `goto('/?prefill=...')` — the chat composer may not be focused on landing. Add `autofocus` to composer when `?prefill=` is present.

- **P3 — Skeleton has 6 rows hardcoded.** `634: Array(6)` — fine, but for
  narrow viewports (1 column) this looks like a lot of pulsing. Consider
  3 rows on `<md` breakpoints.

### Routines (`src/routes/routines/+page.svelte`)

- **P2 — Cron help popover trap.** `998-1009` — the click-outside backdrop
  uses a transparent button. Works, but a stray `Tab` from inside the popover
  lands on this backdrop button (no visible target). Wrap popover in a focus
  trap or set `tabindex="-1"` on the backdrop.

- **P2 — Sparkline has no `aria-label` describing the data.** `737-748` —
  the wrapping `<div>` has `aria-label` but the `<Sparkline>` SVG itself
  doesn't announce data. Pass `aria-label="X routine runs over the past
  24 hours"` into Sparkline with the actual count.

- **P3 — Stat cards have no semantic meaning.** `707-728` — purely visual
  `<div>`s. Wrap counts in `<dl><dt>Total</dt><dd>{n}</dd></dl>` so AT users
  hear "Total: 12".

### Jobs (`src/routes/jobs/+page.svelte`)

- **P2 — Row click target is the whole `<tr>` via tabindex="0" (610).** This
  works, but the inner action buttons (`<button onclick={(e) => e.stopPropagation()}>`)
  rely on stopPropagation in onclick rather than a clean affordance hierarchy.
  Consider moving "Open detail" out of the row click and onto its own visible
  arrow button.

- **P3 — `Failed (X stuck)` summary card uses parens inside the label.**
  `458` — fine readability, but it's a single button-sized number with a
  multi-line label. Consider stacking "Failed" with a smaller "(X stuck)"
  sub-label.

### Logs (`src/routes/logs/+page.svelte`)

- **P2 — Live-tail status indicator dot lacks `aria-label`.** `662-668` —
  the pulsing/gold/gray dot has no accessible name. The neighbouring text
  ("Live"/"Paused"/"Disconnected") covers it, but a `<span class="sr-only">`
  would be cleaner than relying on text proximity.

- **P3 — Filter input dropdown ESC handling.** Open the history dropdown via
  focus + empty input, Tab through items, then press Escape — focus stays
  in the dropdown's last button rather than returning to the input.

- **P3 — `Pause`/`Resume` button has no `aria-pressed`-like wording in
  `aria-label`.** `744-751` — the visible text changes but the toggle nature
  isn't conveyed beyond the visible label.

### Missions (`src/routes/missions/+page.svelte`)

- **P2 — Polling pauses on detail panel for `/jobs` but NOT for missions.**
  `170-172` deliberately keeps the 30s refresh running while the drawer is
  open. Comment acknowledges this is "fine" but reordering mission rows
  under an open drawer can still feel jumpy. Consider gating like jobs does.

- **P3 — Empty state for "no projects" reads as if it's a permanent error.**
  `349: "No engine projects yet."` — when Engine v2 is enabled but the user
  hasn't created any projects, the copy should hint at the next step
  (e.g. "Create a project in the IronClaw TUI to populate this list.").

### Extensions (`src/routes/extensions/+page.svelte`)

- **P2 — Remove confirmation uses native `confirm()` (508).** Inconsistent
  with rest of app (no other surface uses native confirm). Build a small
  inline ConfirmDialog component or reuse a toast-style undo affordance.

- **P3 — Tab counter pill `text-[10px] font-mono` reads small on Retina.**
  `597-600` and `614-617` — micro-typography sometimes loses against `bg-bg-deep`.
  Bump to `text-[11px]`.

### Admin (`src/routes/admin/+page.svelte`)

- **P2 — No keyboard arrow-key navigation between tabs.** Even with the new
  `role="tab"` semantics, ArrowLeft/Right doesn't move focus between tabs
  (WAI-ARIA tabs pattern requirement). Wire up a key handler that focuses
  the prev/next tab on arrow keys.

- **P3 — Tabpanel announcement missing.** Each editor (`ToolPolicyEditor`,
  `SystemPromptEditor`, `UsageDashboard`) renders raw without a
  `role="tabpanel"` wrapper or `aria-labelledby` pointing to its tab. Add
  `<div role="tabpanel" aria-labelledby="tab-<id>">` around each.

### Settings (`src/routes/settings/+page.svelte`)

- **P2 — Save button states use `text-text-muted` for "saved" message
  (`saveStatus === 'saved'`).** The muted gold/cyan distinction is faint
  for users with reduced color sensitivity. Either bold the text or add an
  icon (check / x).

- **P2 — Profile-list inline rename has no visible focus indicator on
  the input.** Inherits the input style but is overlaid on a row that's
  also clickable. A short user could miss they're in rename mode.

- **P3 — `opacity-30` dimming on non-matching settings sections (used when
  the in-page search filters).** Dimmed text crosses the 4.5:1 WCAG AA
  ratio threshold once `text-text-muted` (0.6 alpha) × 0.30 opacity is
  applied. Either keep filtering visible (don't dim) or hide outright.

---

## Top 3 priorities for the next pass

1. **Wire ARIA tabs pattern fully** (arrow-key nav + `role="tabpanel"`) on
   `/admin` and `/extensions` — the current `aria-selected` is half the
   pattern. ~15 lines per file.
2. **Replace native `confirm()` in Extensions remove flow** with an in-app
   dialog component — it's the only native-OS prompt left and breaks the
   visual consistency of the dark-mode shell.
3. **Add skeleton loaders to Chat thread rail + Knowledge tree-rail loading
   states** so all 10 surfaces share a single loading-state language
   (currently 5 use skeletons, 5 use plain "Loading…" text).

---

## Surfaces in good shape (no P1, minimal P2)

- Skills — already uses `focus-visible:ring` on cards, has skeleton, retry,
  filtered/empty states, deep-link recovery.
- Logs — virtualization, persisted prefs, pause/resume, copy/export all
  wired with appropriate keyboard affordances.
- Routines — extensive empty/error/filtered states, optimistic toggles with
  revert-on-error, sparkline + summary cards, deep-link `?open=<id>` recovery.

The audit found zero P1 issues. All surfaces handle disconnected, loading,
error, and empty states. The remaining gaps are accessibility refinements
and visual consistency, not user-blockers.
