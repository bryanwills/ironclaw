<script lang="ts">
  // Slash-command autocomplete for the chat composer. Shows a dropdown
  // anchored above the textarea when the user has typed a `/` token at
  // the start of the message or after whitespace. Filter is a fuzzy
  // subsequence match on the skill name + usage_hint; keyboard cycles
  // (↓/↑ Enter Tab Esc), mouse clicks insert.
  //
  // The parent owns the textarea, the textual `input` value, and the
  // current `caret` position. We compute the slash slice ourselves so
  // the parent doesn't have to know about token boundaries, and we
  // return a replacement instruction (start/end indices + text) on
  // `onPick` so the parent's draft-save effect runs through its normal
  // input pipeline.

  import { untrack } from 'svelte';
  import type { Skill } from '$lib/api/types';
  import { slashUsage } from '$lib/stores/slash-usage.svelte';
  import {
    composerInsert,
    templates,
    templatesModal,
    type PromptTemplate
  } from '$lib/stores/templates.svelte';

  /**
   * Weight applied to the usage score when blending with the
   * subsequence match rank. Picked so a frequently-run skill bubbles
   * up among ties but a tight prefix match still wins. Tune here if
   * the dropdown feels too "sticky" on history.
   */
  const USAGE_WEIGHT = 0.5;

  interface Props {
    /** Composer textarea — used to anchor the dropdown above its top edge. */
    anchor: HTMLTextAreaElement | null;
    /** Current composer text. Read-only from this component's perspective. */
    value: string;
    /** Caret offset in `value`. */
    caret: number;
    /** Full skill list (already cached by the parent). */
    skills: Skill[];
    /**
     * Notify parent that a pick happened. The parent splices
     * `value[0..start] + text + value[end..]` and moves the caret to
     * `start + text.length`.
     */
    onPick: (start: number, end: number, text: string) => void;
  }

  let { anchor, value, caret, skills, onPick }: Props = $props();

  // -- token detection -------------------------------------------------------
  /**
   * Locate the active slash token. Returns the start index of the `/` and
   * the query characters that follow it (up to the caret), or null if the
   * caret isn't sitting inside a slash token. A token only counts when the
   * `/` is the FIRST character of the buffer or is preceded by whitespace,
   * and the query so far contains no whitespace.
   */
  function findSlashToken(text: string, pos: number): { start: number; query: string } | null {
    if (pos <= 0 || pos > text.length) return null;
    // Walk backwards from the caret looking for the `/` that anchors this
    // token. Stop at any whitespace, which would terminate the token.
    let i = pos - 1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === '/') {
        // Validate the boundary BEFORE the slash.
        if (i === 0 || /\s/u.test(text[i - 1] ?? '')) {
          return { start: i, query: text.slice(i + 1, pos) };
        }
        return null;
      }
      if (/\s/u.test(ch ?? '')) return null;
      i -= 1;
    }
    return null;
  }

  const token = $derived(findSlashToken(value, caret));
  const open = $derived(token !== null);

  // -- filtering -------------------------------------------------------------
  // Subsequence match: query chars must appear in order inside `target`
  // (case-insensitive). Returns the matched index array for highlight
  // rendering, or null if no match.
  function subseq(target: string, query: string): number[] | null {
    if (query.length === 0) return [];
    const t = target.toLowerCase();
    const q = query.toLowerCase();
    const idx: number[] = [];
    let j = 0;
    for (let i = 0; i < t.length && j < q.length; i += 1) {
      if (t[i] === q[j]) {
        idx.push(i);
        j += 1;
      }
    }
    return j === q.length ? idx : null;
  }

  /**
   * Tagged-union match record so a single ranked list can hold skill
   * AND template rows without losing type information on the way out
   * to the template renderer + pick handler. Templates carry the
   * full PromptTemplate so the variable-resolution path doesn't have
   * to re-look it up against the store on pick.
   */
  type Match =
    | {
        kind: 'skill';
        skill: Skill;
        /** Display label — usage_hint preferred, falls back to `/${name}`. */
        label: string;
        /** Highlighted indices on the label. */
        labelMatches: number[];
        /** Match-tightness rank — lower is better (rooted in `rankMatch`). */
        rank: number;
        /** Raw usage score from the slash-usage store; 0 when never run. */
        usageScore: number;
        /** Blended sort key — lower wins. Combines `rank` with a usage
         *  bonus so a frequently-run skill floats over a marginally
         *  tighter subsequence match. */
        sortKey: number;
      }
    | {
        kind: 'template';
        template: PromptTemplate;
        /** Display label — `/<slug>` derived from the template name. */
        label: string;
        /** Highlighted indices on the label. */
        labelMatches: number[];
        rank: number;
        /** Templates carry their own usage score: a count × recency
         *  blend on `useCount` + `lastUsedAt`, mirroring the
         *  slash-usage formula. */
        usageScore: number;
        sortKey: number;
      };

  /**
   * Convert a template's display name into the `/slug` form the user
   * types into the composer. Drops punctuation other than dash/underscore
   * and collapses whitespace to single dashes so the resulting label is
   * a safe matcher target. Case-folded to lowercase since the matcher
   * already lowercases on both sides.
   */
  function templateSlug(name: string): string {
    const slug = name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-');
    return slug || 'untitled';
  }

  /**
   * Recency-decayed usage score for a template — same shape as the
   * slash-usage formula but operating on the template's own
   * `useCount` + `lastUsedAt`. 7-day half-life mirrors slash-usage
   * (so ranking parity holds when both kinds compete for the same
   * sort slot). Returns 0 when there's no use record yet.
   */
  function templateUsageScore(t: PromptTemplate): number {
    if (t.useCount <= 0 || !t.lastUsedAt) return 0;
    const last = Date.parse(t.lastUsedAt);
    if (Number.isNaN(last)) return 0;
    const ageMs = Date.now() - last;
    if (ageMs < 0) return t.useCount;
    const ageDays = ageMs / 86400000;
    const ZERO_DAYS = 14;
    if (ageDays >= ZERO_DAYS) return 0;
    return t.useCount * (1 - ageDays / ZERO_DAYS);
  }

  function rankMatch(
    label: string,
    name: string,
    query: string
  ): { matches: number[] | null; rank: number } {
    // Match against the label first because that's what the user sees and
    // most commonly types (`/code-review` not `code-review`). Fall back
    // to the skill name (without the leading `/`) for skills that don't
    // ship a usage_hint.
    const stripped = label.startsWith('/') ? label.slice(1) : label;
    const q = query.replace(/^\//u, '');
    // Try several targets — pick the one with the tightest match.
    const targets = [stripped, name];
    let best: { matches: number[]; rank: number } | null = null;
    for (const target of targets) {
      const m = subseq(target, q);
      if (m === null) continue;
      // Rank: prefix-match beats sparse match. Use the gap between the
      // first and last matched index as a rough tightness metric, with
      // a strong bonus for matching at index 0.
      const tightness = m.length > 0 ? m[m.length - 1] - m[0] : 0;
      const prefixBonus = m.length > 0 && m[0] === 0 ? 0 : 1;
      const rank = prefixBonus * 100 + tightness;
      if (!best || rank < best.rank) {
        // Translate name-matches back to label-matches if we used the
        // label target. For name matches we don't highlight on the label
        // (the label is the primary display, but the name fallback only
        // fires when the labels were ALL non-matching, so this is rare).
        const labelMatches =
          target === stripped ? m.map((i) => i + (label.startsWith('/') ? 1 : 0)) : [];
        best = { matches: labelMatches, rank };
      }
    }
    return best ? { matches: best.matches, rank: best.rank } : { matches: null, rank: 0 };
  }

  // Note on the blended sort key:
  // - `rank` is "lower is better" (a tightness metric from
  //   `rankMatch`, scaled by a prefixBonus).
  // - `usageScore` is "higher is better" (count × recency from the
  //   slash-usage store).
  // The brief spec writes the blend in higher-is-better terms
  // (`usageScore * 0.5 + matchScore * 1.0`). We invert by SUBTRACTING
  // the weighted usage score from rank so the existing "lower wins"
  // sort still does the right thing — skills with no usage history
  // see no penalty (sortKey == rank) and frequently-run skills nudge
  // upward as their usage score grows.
  const matches = $derived<Match[]>(
    (() => {
      if (!token) return [];
      const out: Match[] = [];
      for (const s of skills) {
        const label = s.usage_hint && s.usage_hint.startsWith('/') ? s.usage_hint : `/${s.name}`;
        const { matches: m, rank } = rankMatch(label, s.name, token.query);
        if (m === null) continue;
        const usageScore = slashUsage.score(s.name);
        const sortKey = rank - usageScore * USAGE_WEIGHT;
        out.push({
          kind: 'skill',
          skill: s,
          label,
          labelMatches: m,
          rank,
          usageScore,
          sortKey
        });
      }
      // Mix in templates under the same `/<slug>` matcher. Templates
      // outrank skills only when their tightness is genuinely tighter
      // OR when usage has nudged them above; we don't seed them with
      // a positional bonus so existing skill ranking stays stable.
      for (const t of templates.templates) {
        const label = `/${templateSlug(t.name)}`;
        const { matches: m, rank } = rankMatch(label, t.name, token.query);
        if (m === null) continue;
        const usageScore = templateUsageScore(t);
        const sortKey = rank - usageScore * USAGE_WEIGHT;
        out.push({
          kind: 'template',
          template: t,
          label,
          labelMatches: m,
          rank,
          usageScore,
          sortKey
        });
      }
      out.sort((a, b) => a.sortKey - b.sortKey);
      return out.slice(0, 8);
    })()
  );

  // -- keyboard navigation ---------------------------------------------------
  let active = $state(0);

  // Reset selection whenever the candidate list shrinks underneath us so
  // `active` doesn't point past the end. We only depend on the list
  // length; the read of `active` is wrapped in `untrack` to prevent a
  // self-retriggering effect.
  $effect(() => {
    const len = matches.length;
    untrack(() => {
      if (active >= len) active = 0;
    });
  });

  /**
   * Public-ish: parent calls this in the textarea's keydown handler
   * BEFORE its own logic runs. Returns true if we consumed the event
   * (so the parent should preventDefault + skip its own send-on-Enter).
   */
  export function handleKey(e: KeyboardEvent): boolean {
    if (!open) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (matches.length > 0) active = (active + 1) % matches.length;
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (matches.length > 0) active = (active - 1 + matches.length) % matches.length;
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      // Only consume if we actually have a match to insert. An empty list
      // (e.g. user typed `/zzzzz`) should fall through so Enter still sends.
      if (matches.length === 0) return false;
      e.preventDefault();
      pick(active);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      // We have no internal close state — caret-position changes drive
      // visibility. Pretend the parent consumed the event by moving the
      // dropdown out of the way: we re-emit `onPick` with the same range
      // and no change so the parent re-renders without a token? Simpler:
      // we expose a `dismiss` flag that the parent reads.
      dismissed = true;
      return true;
    }
    return false;
  }

  // Esc dismissal — sticky until the user types something new or moves
  // the caret out of the token. Re-enables when the token boundary shifts.
  let dismissed = $state(false);
  let lastTokenStart = $state<number | null>(null);
  $effect(() => {
    const start = token?.start ?? null;
    if (start !== lastTokenStart) {
      dismissed = false;
      lastTokenStart = start;
    }
  });

  const visible = $derived(open && !dismissed && matches.length > 0);

  // -- pick handler ----------------------------------------------------------
  function pick(i: number) {
    if (!token) return;
    const m = matches[i];
    if (!m) return;
    if (m.kind === 'skill') {
      // Replace [token.start .. caret] with the canonical label. Append
      // a trailing space so the user can keep typing arguments without
      // re-triggering the dropdown.
      const replacement = `${m.label} `;
      onPick(token.start, caret, replacement);
      dismissed = true;
      return;
    }
    // Template branch. Pick semantics differ from skills: skills splice
    // their label into the composer for the user to keep typing
    // arguments after; templates REPLACE the slash token with the
    // rendered body. Templates with `{vars}` route through the modal so
    // the user can fill the variable inputs inline, matching the modal's
    // own variable-input flow. Templates without variables splice their
    // body directly via the composer bus.
    const tpl = m.template;
    // First, clear the slash token from the composer so the inserted
    // text doesn't end up appended to a stray `/foo` fragment.
    onPick(token.start, caret, '');
    dismissed = true;
    if (tpl.variables.length > 0) {
      // Defer to the modal so the user gets the same inline
      // variable-input view (one input per `{var}`) they'd see from
      // Cmd+Shift+T. The modal handles `templates.recordUse()` and
      // the composer-bus push itself.
      templatesModal.show(tpl.id);
    } else {
      composerInsert.push(tpl.body, tpl.id);
      templates.recordUse(tpl.id);
    }
  }

  function truncate(s: string | undefined, n: number): string {
    if (!s) return '';
    return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
  }

  // -- rendering helpers -----------------------------------------------------
  // Pre-compute a highlight segments array for each match label so the
  // template stays declarative. Each segment is { text, hit }.
  interface Seg {
    text: string;
    hit: boolean;
  }
  function highlightSegments(label: string, hits: number[]): Seg[] {
    if (hits.length === 0) return [{ text: label, hit: false }];
    const segs: Seg[] = [];
    let cursor = 0;
    for (const idx of hits) {
      if (idx > cursor) segs.push({ text: label.slice(cursor, idx), hit: false });
      segs.push({ text: label.charAt(idx), hit: true });
      cursor = idx + 1;
    }
    if (cursor < label.length) segs.push({ text: label.slice(cursor), hit: false });
    return segs;
  }

  // -- positioning -----------------------------------------------------------
  // The dropdown is rendered inside this component but absolutely positioned
  // RELATIVE TO ITS PARENT WRAPPER, which the consumer places adjacent to
  // the textarea. We don't measure the textarea ourselves — the parent
  // composer sets `position: relative` on the immediate ancestor, and we
  // anchor `bottom: 100%` so the dropdown grows upward. The `anchor` prop
  // is unused today; kept on the API for future caret-anchored positioning.
  $effect(() => {
    void anchor;
  });
</script>

{#if visible}
  <div
    class="absolute left-0 right-0 bottom-full mb-2 z-30 max-h-72 overflow-y-auto rounded-md border border-border-subtle bg-bg-surface shadow-xl"
    role="listbox"
    aria-label="Slash commands"
  >
    <ul class="py-1">
      {#each matches as m, i (m.kind === 'skill' ? `s:${m.skill.name}` : `t:${m.template.id}`)}
        {@const isActive = i === active}
        {@const segs = highlightSegments(m.label, m.labelMatches)}
        {@const subtitle =
          m.kind === 'skill'
            ? (m.skill.description ?? '')
            : `Template${m.template.variables.length > 0 ? ` · ${m.template.variables.length} var${m.template.variables.length === 1 ? '' : 's'}` : ''}`}
        <!--
          "recent" badge — surfaces on the FIRST result with a non-zero
          usage score so the user has a subtle cue that ranking has
          shifted because of their history. We only mark the top hit
          to keep the row scannable; multiple gold badges in a row
          would compete with the active-row highlight.
        -->
        {@const showRecent = i === 0 && m.usageScore > 0}
        <li>
          <button
            type="button"
            role="option"
            aria-selected={isActive}
            onmousedown={(e) => {
              // Prevent the textarea from losing focus before the click
              // fires — the blur would otherwise close the dropdown.
              e.preventDefault();
            }}
            onclick={() => pick(i)}
            onmouseenter={() => (active = i)}
            class="w-full flex items-start gap-2 px-3 py-2 text-left transition-colors"
            class:bg-accent-cyan={isActive}
            class:text-bg-deep={isActive}
            class:hover:bg-bg-deep={!isActive}
            class:text-text-primary={!isActive}
          >
            <svg
              viewBox="0 0 24 24"
              class="w-4 h-4 mt-0.5 shrink-0"
              class:text-bg-deep={isActive}
              class:text-accent-gold={!isActive}
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <div class="flex-1 min-w-0">
              <div
                class="font-mono text-xs truncate flex items-center gap-1.5"
                class:text-bg-deep={isActive}
                class:text-accent-cyan={!isActive}
              >
                <span class="truncate">
                  {#each segs as seg, idx (idx)}
                    {#if seg.hit}
                      <span class="font-bold" class:underline={isActive}>{seg.text}</span>
                    {:else}
                      <span>{seg.text}</span>
                    {/if}
                  {/each}
                </span>
                {#if showRecent}
                  <!-- Gold tint, small font — flags the usage-bonus boost
                       without dominating the row. Inverts when the row
                       is active so it stays legible against the cyan
                       active-row background. -->
                  <span
                    class="shrink-0 text-[9px] uppercase tracking-wider px-1 py-px rounded border"
                    class:text-bg-deep={isActive}
                    class:border-bg-deep={isActive}
                    class:text-accent-gold={!isActive}
                    class:border-accent-gold={!isActive}
                    aria-label="Recently used"
                    title="Recently used">recent</span
                  >
                {/if}
              </div>
              <div
                class="text-[11px] truncate"
                class:text-bg-deep={isActive}
                class:text-text-muted={!isActive}
              >
                {truncate(subtitle, 60)}
              </div>
            </div>
          </button>
        </li>
      {/each}
    </ul>
  </div>
{/if}
