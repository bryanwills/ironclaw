<script lang="ts">
  import type { Extension } from '$lib/api/types';
  import { pins } from '$lib/stores/pins.svelte';

  type Props = {
    extension: Extension;
    /** Variant changes which actions render on the card footer. */
    variant: 'installed' | 'registry';
    onSetup?: (ext: Extension) => void;
    onToggleActivate?: (ext: Extension) => void;
    onRemove?: (ext: Extension) => void;
    onInstall?: (ext: Extension) => void;
    /** Click handler for the "N tools" badge. */
    onToggleTools?: (ext: Extension) => void;
    /** Tool names contributed by this extension (used for inline expansion). */
    toolNames?: string[];
    /** True when this card's tool list should render inline. */
    expanded?: boolean;
    busy?: boolean;
  };

  const {
    extension,
    variant,
    onSetup,
    onToggleActivate,
    onRemove,
    onInstall,
    onToggleTools,
    toolNames = [],
    expanded = false,
    busy = false
  }: Props = $props();

  /**
   * Map normalized category → badge styling. Unknown categories render a
   * neutral muted badge so they're still visible without pretending to mean
   * something specific.
   */
  type CategoryBadge = { label: string; classes: string };
  const title = $derived(extension.display_name ?? extension.name);

  const categoryBadge = $derived.by<CategoryBadge | null>(() => {
    const c = (extension.category ?? '').toLowerCase();
    if (!c) return null;
    if (c === 'mcp') {
      return {
        label: 'Knowledge',
        classes: 'border-accent-cyan/60 text-accent-cyan bg-accent-cyan/10'
      };
    }
    if (c === 'oauth') {
      return {
        label: 'Account',
        classes: 'border-accent-gold/60 text-accent-gold bg-accent-gold/10'
      };
    }
    if (c === 'channel') {
      return {
        label: 'Team chat',
        classes: 'border-emerald-400/60 text-emerald-300 bg-emerald-500/10'
      };
    }
    if (c === 'wasm_tool' || c === 'tool') {
      return {
        label: workspaceConnectorLabel(extension.name, title),
        classes: 'border-border-subtle text-text-muted bg-bg-deep'
      };
    }
    // builtin, local, etc. — humanize lightly and use a muted slate.
    const humanized = c.replace(/[_-]+/g, ' ').replace(/^./, (m) => m.toUpperCase());
    return {
      label: humanized,
      classes: 'border-border-subtle text-text-muted bg-bg-deep'
    };
  });

  /** Readiness dot + label. Only rendered on installed cards. */
  type ReadinessIndicator = {
    dot: string;
    label: string;
    title: string;
  };

  const readiness = $derived.by<ReadinessIndicator>(() => {
    const msg = extension.readiness_message ?? '';
    const normalized = msg.toLowerCase();
    // Explicit error state from /readiness wire.
    if (normalized.startsWith('error')) {
      return {
        dot: 'bg-red-500',
        label: 'Error',
        title: msg
      };
    }
    if (extension.ready === true || normalized === 'ready') {
      return {
        dot: 'bg-emerald-500',
        label: 'Ready',
        title: 'Authenticated and ready to use'
      };
    }
    if (normalized === 'needs_auth' || normalized.includes('needs_auth')) {
      return {
        dot: 'bg-accent-gold',
        label: 'Needs sign-in',
        title: 'Sign in to connect this workspace app'
      };
    }
    // Anything else (needs_setup, not_ready, unknown) is setup from the
    // user's POV. The tooltip carries the underlying reason so debugging is
    // still possible.
    return {
      dot: 'bg-accent-gold',
      label: 'Needs setup',
      title: msg || 'Setup required before this extension can run'
    };
  });

  const toolCount = $derived(extension.tool_count ?? 0);
  const toolsClickable = $derived(variant === 'installed' && toolCount > 0);

  // True when this installed extension is unconfigured (not ready, not in an
  // error state). Drives the prominent "Set up" CTA so "Needs setup" isn't a
  // dead-end label next to a cryptic gear.
  const needsSetup = $derived(
    variant === 'installed' &&
      (readiness.label === 'Needs setup' || readiness.label === 'Needs sign-in')
  );

  // A short, human hint about WHAT the setup needs, inferred from the
  // connector category. The exact fields come from the setup drawer once
  // opened; this just orients the user (token vs sign-in) before they click.
  const setupHint = $derived.by<string>(() => {
    const c = (extension.category ?? '').toLowerCase();
    const msg = (extension.readiness_message ?? '').toLowerCase();
    if (c === 'oauth' || msg === 'needs_auth') return `${oauthActionVerb(title)} ${title}`;
    if (c === 'channel') return 'Add a token to connect';
    if (c === 'mcp') return 'Add credentials or config';
    return 'Complete setup to enable';
  });

  const setupActionLabel = $derived.by(() => {
    const c = (extension.category ?? '').toLowerCase();
    const msg = (extension.readiness_message ?? '').toLowerCase();
    if (c === 'oauth' || msg === 'needs_auth') return `${oauthActionVerb(title)} ${title}`;
    return 'Set up';
  });

  // Pin star. Bound against extension.name (the stable id; display_name
  // is user-facing and may shift). Reactive against the pins store so
  // any other surface toggling this extension flips the card too.
  const pinned = $derived(pins.isPinned('extension', extension.name));

  function handlePinClick(event: MouseEvent) {
    // Don't propagate up to the card root (no card-level onclick today
    // but defensive against future "click to open detail" wiring).
    event.stopPropagation();
    pins.toggle('extension', extension.name, title);
  }

  function oauthActionVerb(label: string): string {
    const lower = label.toLowerCase();
    if (lower.includes('gmail') || lower.includes('google')) return 'Log in with';
    return 'Connect';
  }

  function workspaceConnectorLabel(name: string, label: string): string {
    const normalized = `${name} ${label}`.toLowerCase();
    if (normalized.includes('gmail') || normalized.includes('mail')) return 'Mail';
    if (normalized.includes('calendar') || normalized.includes('gcal')) return 'Calendar';
    if (normalized.includes('notion')) return 'Knowledge';
    if (normalized.includes('slack')) return 'Team chat';
    return 'Workspace';
  }
</script>

<div class="v2-interactive-card group relative flex flex-col p-4 min-h-[180px]">
  <!-- Top-right cluster: pin star + (optional) category badge. The
       star is always present so the affordance is consistent across
       cards; the badge only renders when the extension has a known
       category. Gold-filled = pinned; muted hollow = pinnable. -->
  <div class="absolute top-3 right-3 flex items-center gap-1.5">
    {#if categoryBadge}
      <span
        class={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded border ${categoryBadge.classes}`}
        title={`Category: ${categoryBadge.label}`}
      >
        {categoryBadge.label}
      </span>
    {/if}
    <button
      type="button"
      onclick={handlePinClick}
      title={pinned ? 'Unpin this extension' : 'Pin this extension'}
      aria-label={pinned ? `Unpin ${title}` : `Pin ${title}`}
      aria-pressed={pinned}
      class="inline-flex items-center justify-center w-5 h-5 rounded transition-colors hover:bg-bg-deep"
      class:text-accent-gold={pinned}
      class:text-text-muted={!pinned}
      class:hover:text-accent-gold={!pinned}
    >
      <svg
        viewBox="0 0 24 24"
        class="w-3.5 h-3.5"
        fill={pinned ? 'currentColor' : 'none'}
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polygon
          points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
        />
      </svg>
    </button>
  </div>

  <!-- pr-28 (112px) reserves enough space for the absolute top-right cluster
       (category badge up to ~80px wide + 6px gap + 20px pin
       star) so the title doesn't sit underneath the badge at narrow card
       widths (single-column grid <768px). flex-wrap lets the version chip
       flow to the next line when the title itself is long; min-w-0 on the
       title lets break-words actually break long names instead of forcing
       horizontal overflow. -->
  <div class="mb-2 pr-28 flex items-baseline gap-2 flex-wrap">
    <h3 class="text-sm font-semibold text-accent-cyan break-words min-w-0">
      {title}
    </h3>
    {#if extension.version}
      <span class="text-[10px] font-mono text-text-muted bg-bg-deep px-1.5 py-0.5 rounded">
        v{extension.version}
      </span>
    {/if}
  </div>

  <p
    class="text-xs text-text-muted leading-relaxed flex-1 overflow-hidden"
    style="display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;"
  >
    {extension.description || 'No description'}
  </p>

  <!-- Footer row: tool count + readiness on the left, action buttons on the
       right. flex-wrap so on the narrowest cards (1-col grid <768px viewport)
       the action button cluster drops to a second row instead of overlapping
       the readiness label / tool chip. The right-side cluster keeps its own
       grouping via flex-nowrap on the inner div so its 3 icon buttons never
       split mid-cluster. -->
  <div
    class="mt-3 pt-3 border-t border-border-subtle flex flex-wrap items-center justify-between gap-2"
  >
    <!-- Left: tool count (installed) or installed marker (registry-installed). -->
    {#if variant === 'installed'}
      <div class="flex items-center gap-2 min-w-0">
        <span
          class="inline-flex items-center gap-1.5 text-[11px] text-text-muted"
          title={readiness.title}
        >
          <span class={`w-2 h-2 rounded-full shrink-0 ${readiness.dot}`}></span>
          <span class="truncate">{readiness.label}</span>
        </span>
        {#if needsSetup}
          <span class="text-[10px] text-accent-gold/90 truncate" title={setupHint}>
            · {setupHint}
          </span>
        {/if}
        {#if toolsClickable}
          <button
            type="button"
            onclick={() => onToggleTools?.(extension)}
            aria-expanded={expanded}
            aria-label={expanded
              ? `Hide tools for ${title}`
              : `Show ${toolCount} tool${toolCount === 1 ? '' : 's'} for ${title}`}
            title={expanded ? 'Hide tools' : 'Show tool names'}
            class="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border border-transparent text-text-muted bg-bg-deep hover:text-accent-cyan hover:border-accent-cyan/40 transition-colors shrink-0"
            class:!text-accent-cyan={expanded}
            class:!border-accent-cyan={expanded}
          >
            {toolCount} tools
            <svg
              viewBox="0 0 24 24"
              class="w-3 h-3 transition-transform"
              class:rotate-180={expanded}
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        {:else}
          <span
            class="text-[10px] font-mono text-text-muted bg-bg-deep px-2 py-0.5 rounded shrink-0"
            title={`Contributes ${toolCount} tool${toolCount === 1 ? '' : 's'}`}
          >
            {toolCount} tools
          </span>
        {/if}
      </div>
    {:else if extension.installed}
      <span
        class="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-300"
        title="Already installed"
      >
        <svg
          viewBox="0 0 24 24"
          class="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
        Installed
      </span>
    {:else}
      <span></span>
    {/if}

    <!-- Right: action buttons. flex-nowrap + shrink-0 keeps the three icon
         buttons clustered as a unit; when the footer wraps under narrow
         widths the whole cluster drops to its own row instead of splitting. -->
    <div class="flex flex-nowrap items-center gap-1 shrink-0">
      {#if variant === 'installed'}
        {#if needsSetup}
          <!-- Unconfigured: a prominent labeled CTA (gold, matching the
               "Needs setup" dot) so the next action is obvious. -->
          <button
            type="button"
            onclick={() => onSetup?.(extension)}
            aria-label={`${setupActionLabel} — ${setupHint}`}
            title={setupHint}
            disabled={busy}
            class="inline-flex items-center gap-1.5 px-3 h-8 rounded-md border border-accent-gold/60 text-accent-gold bg-accent-gold/10 text-xs font-semibold hover:bg-accent-gold/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg
              viewBox="0 0 24 24"
              class="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path
                d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
              />
            </svg>
            {setupActionLabel}
          </button>
        {:else}
          <button
            type="button"
            onclick={() => onSetup?.(extension)}
            aria-label={`Configure ${title}`}
            title="Configure"
            disabled={busy}
            class="inline-flex items-center justify-center w-8 h-8 rounded-md border border-border-subtle text-text-muted hover:text-accent-cyan hover:border-accent-cyan/60 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg
              viewBox="0 0 24 24"
              class="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path
                d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
              />
            </svg>
          </button>
        {/if}
        <button
          type="button"
          onclick={() => onToggleActivate?.(extension)}
          aria-label={extension.active ? `Deactivate ${title}` : `Activate ${title}`}
          title={extension.active ? 'Deactivate' : 'Activate'}
          disabled={busy}
          class="inline-flex items-center justify-center w-8 h-8 rounded-md border transition disabled:opacity-50 disabled:cursor-not-allowed"
          class:border-accent-cyan={extension.active}
          class:text-accent-cyan={extension.active}
          class:border-border-subtle={!extension.active}
          class:text-text-muted={!extension.active}
          class:hover:text-accent-cyan={!extension.active}
          class:hover:border-accent-cyan={!extension.active}
        >
          {#if extension.active}
            <!-- pause -->
            <svg
              viewBox="0 0 24 24"
              class="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          {:else}
            <!-- play -->
            <svg viewBox="0 0 24 24" class="w-3.5 h-3.5" fill="currentColor" stroke="none">
              <polygon points="6 4 20 12 6 20 6 4" />
            </svg>
          {/if}
        </button>
        <button
          type="button"
          onclick={() => onRemove?.(extension)}
          aria-label={`Remove ${title}`}
          title="Remove"
          disabled={busy}
          class="inline-flex items-center justify-center w-8 h-8 rounded-md border border-border-subtle text-text-muted hover:text-red-400 hover:border-red-500/60 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg
            viewBox="0 0 24 24"
            class="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6M14 11v6" />
            <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      {:else if !extension.installed}
        <button
          type="button"
          onclick={() => onInstall?.(extension)}
          disabled={busy}
          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent-cyan text-bg-deep text-xs font-semibold hover:brightness-95 transition min-h-[32px] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {#if busy}
            <svg
              viewBox="0 0 24 24"
              class="w-3 h-3 animate-spin"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <circle cx="12" cy="12" r="10" opacity="0.25" />
              <path d="M22 12a10 10 0 0 0-10-10" />
            </svg>
            Installing…
          {:else}
            <svg
              viewBox="0 0 24 24"
              class="w-3 h-3"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Install
          {/if}
        </button>
      {/if}
    </div>
  </div>

  {#if expanded && toolsClickable}
    <div
      class="mt-3 pt-3 border-t border-border-subtle"
      role="region"
      aria-label={`Tools contributed by ${title}`}
    >
      {#if toolNames.length === 0}
        <p class="text-[11px] text-text-muted italic">No tool names</p>
      {:else}
        <ul class="flex flex-wrap gap-1.5">
          {#each toolNames as tool (tool)}
            <li
              class="text-[10px] font-mono text-text-muted bg-bg-deep border border-border-subtle/60 rounded px-1.5 py-0.5"
              title={tool}
            >
              {tool}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
