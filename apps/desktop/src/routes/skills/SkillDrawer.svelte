<script lang="ts">
  import type { Skill } from '$lib/api/types';
  import { goto } from '$app/navigation';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { composerInsert } from '$lib/stores/templates.svelte';
  import { revealInFinder } from '$lib/stores/settings.svelte';

  type Props = {
    skill: Skill;
    onClose: () => void;
    /**
     * Fired when the user launches the skill from the drawer (Open in Chat).
     * Optional — callers that don't care about launch tracking can omit it.
     * Used by the skills page to mark the skill as recently used.
     */
    onLaunch?: (skill: Skill) => void;
  };

  const { skill, onClose, onLaunch }: Props = $props();

  let input = $state('');
  let sourceExpanded = $state(false);

  /**
   * Prefer the server-provided `usage_hint` over the client-derived
   * `/${name}` heuristic. The server emits a sentence like
   * "Type `/foo` in chat to force-activate this skill." — pull the
   * backtick-delimited token out. Fall back to the slash heuristic if
   * the hint is missing or doesn't parse.
   */
  const usageHint = $derived.by(() => {
    const raw = skill.usage_hint;
    if (raw) {
      const m = raw.match(/`([^`]+)`/);
      if (m) return m[1];
      const trimmed = raw.trim();
      if (trimmed.startsWith('/')) return trimmed.split(/\s+/)[0];
    }
    return `/${skill.name}`;
  });

  type BadgeClass = {
    label: string;
    classes: string;
    warn: boolean;
  };

  const trustBadge = $derived.by<BadgeClass | null>(() => {
    const t = skill.trust;
    if (!t) return null;
    switch (t) {
      case 'Bundled':
        return {
          label: 'Bundled',
          classes: 'border-accent-cyan/60 text-accent-cyan bg-accent-cyan/10',
          warn: false
        };
      case 'Verified':
        return {
          label: 'Verified',
          classes: 'border-emerald-400/60 text-emerald-300 bg-emerald-500/10',
          warn: false
        };
      case 'Unverified':
        return {
          label: 'Unverified',
          classes: 'border-accent-gold/60 text-accent-gold bg-accent-gold/10',
          warn: true
        };
      default:
        return null;
    }
  });

  const isUnverified = $derived(skill.trust === 'Unverified');

  function pillClasses(active: boolean | undefined): string {
    return active
      ? 'border-accent-cyan/60 text-accent-cyan bg-accent-cyan/10'
      : 'border-border-subtle text-text-muted/70 bg-transparent';
  }

  function openInChat() {
    const prefix = input.trim().length > 0 ? `${usageHint} ${input.trim()}` : usageHint;
    // Hand the rendered invocation (+ any typed arguments) to the chat
    // composer via the one-shot bus. The active chat surface — v1 page or
    // v2 panel — drains it on arrival.
    composerInsert.push(prefix);
    // Notify the parent first so "recently used" state is updated before
    // the navigation tears this drawer down.
    onLaunch?.(skill);
    toasts.show(`Loaded into chat: ${usageHint}`, 'info');
    void goto('/chat');
  }

  async function reveal() {
    if (!skill.bundle_path) return;
    try {
      await revealInFinder(skill.bundle_path);
    } catch (err) {
      toasts.show(`Could not reveal in Finder: ${(err as Error).message}`, 'error');
    }
  }

  function handleBackdropKey(event: KeyboardEvent) {
    if (event.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={handleBackdropKey} />

<!-- Backdrop -->
<button
  type="button"
  aria-label="Close drawer"
  onclick={onClose}
  class="fixed inset-0 z-40 bg-black/40 cursor-default"
></button>

<!-- Drawer -->
<div
  class="v2-drawer-shell fixed top-0 right-0 z-50 h-full w-full md:w-[40%] min-w-[360px] max-w-[640px] border-l border-border-subtle flex flex-col overflow-hidden"
  role="dialog"
  aria-modal="true"
  aria-labelledby="skill-drawer-title"
>
  <!-- Header -->
  <header class="flex items-start justify-between gap-4 px-6 py-5 border-b border-border-subtle">
    <div class="min-w-0">
      <h2 id="skill-drawer-title" class="text-lg font-semibold text-accent-cyan break-words">
        {skill.name}
      </h2>
      <div class="mt-1 flex flex-wrap items-center gap-2">
        <span class="text-[10px] font-mono text-text-muted bg-bg-deep px-2 py-0.5 rounded">
          v{skill.version || '—'}
        </span>
        {#if trustBadge}
          <span
            class={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded border ${trustBadge.classes}`}
            title={trustBadge.warn
              ? 'Unverified skill — review the source before running on production data.'
              : `Trust level: ${trustBadge.label}`}
          >
            {#if trustBadge.warn}
              <svg
                viewBox="0 0 24 24"
                class="w-2.5 h-2.5"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path
                  d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
                />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            {/if}
            {trustBadge.label}
          </span>
        {/if}
        <span
          class={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded border ${pillClasses(skill.has_requirements)}`}
          title="This skill declares external dependencies"
          aria-label={skill.has_requirements ? 'Declares dependencies' : 'No declared dependencies'}
        >
          deps
        </span>
        <span
          class={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded border ${pillClasses(skill.has_scripts)}`}
          title="This skill ships executable scripts"
          aria-label={skill.has_scripts ? 'Ships executable scripts' : 'No executable scripts'}
        >
          scripts
        </span>
      </div>
    </div>
    <button
      type="button"
      onclick={onClose}
      aria-label="Close"
      class="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-md border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent-cyan transition"
    >
      <svg
        viewBox="0 0 24 24"
        class="w-4 h-4"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  </header>

  <!-- Body -->
  <div class="flex-1 overflow-auto px-6 py-5 space-y-6">
    <!-- Description -->
    <section>
      <h3 class="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2">
        Description
      </h3>
      <p class="text-sm text-text-primary leading-relaxed whitespace-pre-wrap">
        {skill.description || 'No description'}
      </p>
    </section>

    <!-- Provenance: source + bundle path -->
    {#if skill.source || skill.bundle_path}
      <section>
        <h3 class="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2">
          Provenance
        </h3>
        <dl class="space-y-2 text-xs">
          {#if skill.source}
            <div class="flex flex-col gap-1">
              <dt class="text-text-muted">Source</dt>
              <dd>
                <button
                  type="button"
                  onclick={() => (sourceExpanded = !sourceExpanded)}
                  title={sourceExpanded ? 'Click to collapse' : 'Click to expand'}
                  class={`w-full text-left font-mono text-text-primary bg-bg-deep border border-border-subtle hover:border-accent-cyan/60 transition rounded px-2 py-1 ${sourceExpanded ? 'whitespace-pre-wrap break-all' : 'truncate'}`}
                >
                  {skill.source}
                </button>
              </dd>
            </div>
          {/if}
          {#if skill.bundle_path}
            <div class="flex flex-col gap-1">
              <dt class="text-text-muted">Bundle path</dt>
              <dd class="flex items-stretch gap-2">
                <span
                  class="flex-1 min-w-0 font-mono text-text-primary bg-bg-deep border border-border-subtle rounded px-2 py-1 truncate"
                  title={skill.bundle_path}
                >
                  {skill.bundle_path}
                </span>
                <button
                  type="button"
                  onclick={reveal}
                  class="shrink-0 inline-flex items-center gap-1 px-2.5 rounded border border-border-subtle text-text-muted hover:text-accent-cyan hover:border-accent-cyan/60 transition text-[11px]"
                  aria-label="Reveal bundle in Finder"
                  title="Reveal in Finder"
                >
                  <svg
                    viewBox="0 0 24 24"
                    class="w-3 h-3"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path
                      d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"
                    />
                  </svg>
                  Reveal
                </button>
              </dd>
            </div>
          {/if}
        </dl>
      </section>
    {/if}

    <!-- Run skill -->
    <section>
      <h3 class="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2">Run skill</h3>
      <label for="skill-input" class="block text-xs text-text-muted mb-1">
        Input / arguments
      </label>
      <textarea
        id="skill-input"
        bind:value={input}
        rows="4"
        placeholder="Optional arguments…"
        class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors resize-y"
      ></textarea>

      {#if isUnverified}
        <div
          class="mt-3 flex items-start gap-2 rounded-md border border-accent-gold/40 bg-accent-gold/10 px-3 py-2 text-xs text-accent-gold"
          role="note"
        >
          <svg
            viewBox="0 0 24 24"
            class="w-4 h-4 mt-0.5 shrink-0"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path
              d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
            />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>Unverified. Review the source before running on production data.</span>
        </div>
      {/if}

      <div class="mt-3 flex items-center gap-3">
        <button
          type="button"
          onclick={openInChat}
          class="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-accent-gold text-bg-deep text-sm font-semibold hover:brightness-95 transition min-h-[40px]"
        >
          <svg viewBox="0 0 24 24" class="w-3.5 h-3.5" fill="currentColor" stroke="none">
            <polygon points="6 4 20 12 6 20 6 4" />
          </svg>
          Open in Chat
        </button>
      </div>
    </section>

    <!-- Output placeholder -->
    <section>
      <h3 class="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2">Output</h3>
      <div class="surface p-4 text-xs text-text-muted leading-relaxed">
        Skill execution coming in v1.1 — for now, invoke via chat with
        <code class="font-mono text-accent-cyan bg-bg-deep px-1.5 py-0.5 rounded">
          {usageHint}{input.trim() ? ' ' + input.trim() : ' {input}'}
        </code>
        .
      </div>
    </section>
  </div>
</div>
