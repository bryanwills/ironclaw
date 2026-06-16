<script lang="ts">
  // IronHub catalog browser.
  //
  // Pulls the upstream WASM-tool + SKILL.md catalog from
  // github.com/nearai/ironhub via the three Tauri commands in
  // `ironhub.svelte.ts`. The Rust side caches the catalog response for an
  // hour; "Refresh" passes a force flag to bypass.
  //
  // Three actions per card:
  //   1. View SKILL.md — opens a modal with the rendered markdown
  //   2. Copy SKILL.md — copies to clipboard, fires a toast
  //   3. Install (local sidecar) — writes the SKILL.md into the local
  //      sidecar's skills dir; disabled when the sidecar isn't running
  //   4. Install via gateway — uses the gateway's own
  //      `/api/skills/install` endpoint. Independent path: lands in
  //      `installed_skills/`, not `skills/`.
  //
  // After a successful install we refresh the existing `/skills` catalog
  // via `surfaceRefresh` so the next visit to that page picks up the new
  // entry without a manual reload.

  import { onMount, type Component } from 'svelte';
  import { goto } from '$app/navigation';
  import { connection } from '$lib/stores/connection.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import {
    fetchIronHubSkill,
    installIronHubSkillLocal,
    listIronHubCatalog,
    type IronHubCatalog,
    type IronHubCatalogEntry,
    type IronHubSkillBlob
  } from '$lib/stores/ironhub.svelte';

  type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

  let MarkdownView = $state<Component<any> | null>(null);
  let loadState = $state<LoadState>('idle');
  let loadError = $state<string | null>(null);
  let catalog = $state<IronHubCatalog | null>(null);
  let refreshing = $state(false);

  // Modal state for the SKILL.md preview. `previewSkill` holds the SKILL.md
  // body once it's been fetched (the preview button kicks off the fetch
  // lazily so we never hammer GitHub for skills the user doesn't open).
  let previewSlug = $state<string | null>(null);
  let previewBlob = $state<IronHubSkillBlob | null>(null);
  let previewLoading = $state(false);
  let previewError = $state<string | null>(null);

  // Per-card "install in flight" tracking so we can disable the right
  // buttons during a slow GitHub fetch + write.
  const installingLocal = $state(new Set<string>());
  const installingGateway = $state(new Set<string>());

  // Reactive flags so the layout responds to the connection/sidecar
  // state without re-reading the connection store from every handler.
  const localSidecarRunning = $derived(connection.sidecarStatus === 'running');
  const gatewayClient = $derived(connection.client);

  // Skeleton card count for the loading state. Matches the two-section
  // layout (3 + 6) so the grid doesn't visually re-shuffle on resolve.
  const SKELETON_TOOLS = 3;
  const SKELETON_SKILLS = 6;

  onMount(async () => {
    MarkdownView = (await import('$lib/components/MarkdownView.svelte')).default;
    void load();
  });

  async function load(force = false) {
    if (loadState === 'loading') return;
    loadState = 'loading';
    loadError = null;
    refreshing = force;
    try {
      const data = await listIronHubCatalog(force);
      if (!data) {
        // The wrapper logs and swallows the underlying error. The most
        // common cause inside Tauri is a GitHub rate-limit or network
        // failure; outside Tauri the wrapper returns null because the
        // IPC isn't there. Either way the empty-state explains it.
        loadError = 'Could not load IronHub catalog. Check network and try again.';
        loadState = 'error';
        return;
      }
      catalog = data;
      loadState = 'loaded';
    } catch (err) {
      loadError = (err as Error).message;
      loadState = 'error';
    } finally {
      refreshing = false;
    }
  }

  function closePreview() {
    previewSlug = null;
    previewBlob = null;
    previewLoading = false;
    previewError = null;
  }

  async function openPreview(entry: IronHubCatalogEntry, kind: 'tool' | 'skill') {
    previewSlug = entry.name;
    previewBlob = null;
    previewError = null;
    // Tools don't ship a SKILL.md — they're WASM artefacts with a README.
    // Surface the README excerpt instead so the modal still does something
    // useful when the user clicks View on a tool card.
    if (kind === 'tool') {
      const body = entry.readme_excerpt ?? 'No README excerpt available.';
      previewBlob = {
        slug: entry.name,
        content: body,
        sha: '',
        fetched_at: Math.floor(Date.now() / 1000)
      };
      return;
    }
    previewLoading = true;
    try {
      const blob = await fetchIronHubSkill(entry.name);
      if (!blob) {
        previewError = 'Could not fetch SKILL.md from GitHub.';
        return;
      }
      previewBlob = blob;
    } finally {
      previewLoading = false;
    }
  }

  async function copySkill(entry: IronHubCatalogEntry) {
    try {
      const blob = await fetchIronHubSkill(entry.name);
      if (!blob) {
        toasts.show("Couldn't fetch SKILL.md", 'error');
        return;
      }
      await navigator.clipboard.writeText(blob.content);
      toasts.show('Copied', 'success');
    } catch (err) {
      toasts.show(`Copy failed: ${(err as Error).message}`, 'error');
    }
  }

  async function installLocal(entry: IronHubCatalogEntry) {
    if (!localSidecarRunning) {
      toasts.show('Local sidecar not running', 'error');
      return;
    }
    if (installingLocal.has(entry.name)) return;
    installingLocal.add(entry.name);
    try {
      const res = await installIronHubSkillLocal(entry.name);
      if (!res) {
        toasts.show('Install failed (see Settings → Logs)', 'error');
        return;
      }
      toasts.show(`Installed ${entry.name}`, 'success');
      // If the local sidecar's gateway is reachable, ask it to re-scan
      // installed skills. The gateway picks up SKILL.md files on the
      // skills page next time it loads, so this just primes the cache.
      const client = gatewayClient;
      if (client) {
        try {
          await client.listSkills();
        } catch {
          /* non-fatal — the user can refresh /skills manually */
        }
      }
    } finally {
      installingLocal.delete(entry.name);
    }
  }

  async function tryGatewayInstall(entry: IronHubCatalogEntry) {
    const client = gatewayClient;
    if (!client) {
      toasts.show('Gateway offline', 'error');
      return;
    }
    if (installingGateway.has(entry.name)) return;
    installingGateway.add(entry.name);
    try {
      const res = await client.installSkill(entry.name);
      if (res.ok) {
        toasts.show(`Queued ${entry.name} via gateway`, 'success');
      } else {
        toasts.show(`Gateway refused install for ${entry.name}`, 'error');
      }
    } catch (err) {
      toasts.show(`Gateway install failed: ${(err as Error).message}`, 'error');
    } finally {
      installingGateway.delete(entry.name);
    }
  }

  /** Cap a README excerpt at ~100 chars for the card body. */
  function shortExcerpt(raw: string | null): string {
    if (!raw) return 'No description';
    const cleaned = raw
      // Drop a leading `# title` line so the excerpt doesn't lead with the
      // skill name (which is already the card heading).
      .replace(/^#[^\n]*\n+/, '')
      .replace(/[#*_`>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length <= 110) return cleaned || 'No description';
    return cleaned.slice(0, 107).trimEnd() + '…';
  }

  function formatTimestamp(secs: number): string {
    try {
      return new Date(secs * 1000).toLocaleString();
    } catch {
      return '—';
    }
  }
</script>

<svelte:head>
  <title>IronHub catalog · IronClaw</title>
</svelte:head>

<section class="p-8 h-full flex flex-col overflow-hidden">
  <header class="mb-5 flex items-start justify-between gap-4 flex-wrap">
    <div class="min-w-0">
      <div class="flex items-center gap-2">
        <button
          type="button"
          onclick={() => goto('/skills')}
          class="text-xs text-text-muted hover:text-accent-cyan transition"
          aria-label="Back to installed skills"
        >
          ← Skills
        </button>
      </div>
      <h1 class="text-2xl font-semibold text-text-primary mt-1">IronHub catalog</h1>
      <p class="text-text-muted text-sm mt-1">
        Browse skills and tools from
        <code class="font-mono text-accent-cyan">github.com/nearai/ironhub</code>.
        {#if catalog}
          <span class="text-text-muted/70">·</span>
          <span class="text-text-muted">
            {catalog.skills.length} skills · {catalog.tools.length} tools
          </span>
          <span class="text-text-muted/70">·</span>
          <span class="text-text-muted">fetched {formatTimestamp(catalog.fetched_at)}</span>
        {/if}
      </p>
    </div>
    <div class="flex items-center gap-2">
      <button
        type="button"
        onclick={() => load(true)}
        disabled={loadState === 'loading' || refreshing}
        class="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent-cyan transition text-xs min-h-[36px] disabled:opacity-50 disabled:cursor-not-allowed"
        title="Re-fetch from GitHub now"
      >
        <svg
          viewBox="0 0 24 24"
          class="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
        {refreshing ? 'Refreshing…' : 'Refresh catalog'}
      </button>
    </div>
  </header>

  <div
    class="mb-5 rounded-lg border border-border-subtle bg-bg-deep/60 px-4 py-3 text-xs text-text-muted leading-relaxed"
  >
    Pulled from <code class="font-mono text-accent-cyan">github.com/nearai/ironhub</code>. Skills
    install into your sidecar's catalog when local mode is active. Remote-mode gateways need the
    gateway's own install endpoint
    <span class="text-text-muted/70">(button on the right of each card)</span>.
  </div>

  <div class="flex-1 overflow-auto -mx-2 px-2">
    {#if loadState === 'error'}
      <div class="surface p-10 flex flex-col items-center justify-center text-center min-h-[280px]">
        <div class="text-sm text-red-400 mb-2">Failed to load IronHub catalog</div>
        <div class="text-xs text-text-muted font-mono mb-4 max-w-md break-words">
          {loadError ?? 'Unknown error'}
        </div>
        <button
          type="button"
          onclick={() => load(true)}
          class="px-4 py-2 rounded-md border border-accent-cyan text-accent-cyan text-sm font-semibold hover:bg-accent-cyan hover:text-bg-deep transition min-h-[40px]"
        >
          Retry
        </button>
      </div>
    {:else if loadState === 'loading' && !catalog}
      <!-- Loading skeleton. Two sections (tools + skills) with a few
           placeholder cards each so the grid doesn't jitter on resolve. -->
      <div class="space-y-8">
        {#each [{ id: 'tools', label: 'Tools', count: SKELETON_TOOLS }, { id: 'skills', label: 'Skills', count: SKELETON_SKILLS }] as section (section.id)}
          <div>
            <h2 class="text-xs font-semibold uppercase tracking-wide text-text-muted mb-3">
              {section.label}
            </h2>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              {#each Array(section.count) as _, i (i)}
                <div
                  class="rounded-lg border border-border-subtle bg-bg-surface p-4 min-h-[180px] animate-pulse"
                >
                  <div class="h-4 w-1/3 bg-border-subtle rounded mb-3"></div>
                  <div class="h-3 w-full bg-border-subtle rounded mb-2"></div>
                  <div class="h-3 w-4/5 bg-border-subtle rounded mb-6"></div>
                  <div class="flex gap-2">
                    <div class="h-7 w-20 bg-border-subtle rounded"></div>
                    <div class="h-7 w-20 bg-border-subtle rounded"></div>
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {:else if catalog}
      <div class="space-y-8 pb-4">
        <!-- Tools section -->
        <section>
          <div class="flex items-baseline justify-between mb-3">
            <h2 class="text-xs font-semibold uppercase tracking-wide text-text-muted">
              Tools
              <span class="ml-2 text-[10px] font-mono text-text-muted/70">
                ({catalog.tools.length})
              </span>
            </h2>
          </div>
          {#if catalog.tools.length === 0}
            <div class="surface px-4 py-3 text-xs text-text-muted">No tools listed</div>
          {:else}
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              {#each catalog.tools as entry (entry.path)}
                <article
                  class="rounded-lg border border-border-subtle bg-bg-surface p-4 flex flex-col min-h-[180px]"
                >
                  <header class="mb-2">
                    <h3 class="text-sm font-semibold text-accent-cyan break-words">
                      {entry.name}
                    </h3>
                    <div class="mt-1 text-[10px] font-mono text-text-muted truncate">
                      {entry.path}
                    </div>
                  </header>
                  <p
                    class="text-xs text-text-muted leading-relaxed flex-1 overflow-hidden"
                    style="display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;"
                  >
                    {shortExcerpt(entry.readme_excerpt)}
                  </p>
                  <footer
                    class="mt-3 pt-3 border-t border-border-subtle flex items-center gap-2 flex-wrap"
                  >
                    <button
                      type="button"
                      onclick={() => openPreview(entry, 'tool')}
                      class="inline-flex items-center px-3 py-1.5 rounded-md border border-border-subtle text-xs text-text-muted hover:text-text-primary hover:border-accent-cyan transition min-h-[32px]"
                    >
                      View README
                    </button>
                    <button
                      type="button"
                      disabled={!gatewayClient || installingGateway.has(entry.name)}
                      onclick={() => tryGatewayInstall(entry)}
                      title={!gatewayClient
                        ? 'Gateway offline'
                        : `Ask the gateway to installSkill("${entry.name}")`}
                      class="inline-flex items-center px-3 py-1.5 rounded-md border border-accent-cyan/40 text-xs text-accent-cyan hover:bg-accent-cyan/10 transition min-h-[32px] disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {installingGateway.has(entry.name) ? 'Installing…' : 'Try via gateway'}
                    </button>
                  </footer>
                </article>
              {/each}
            </div>
          {/if}
        </section>

        <!-- Skills section -->
        <section>
          <div class="flex items-baseline justify-between mb-3">
            <h2 class="text-xs font-semibold uppercase tracking-wide text-text-muted">
              Skills
              <span class="ml-2 text-[10px] font-mono text-text-muted/70">
                ({catalog.skills.length})
              </span>
            </h2>
          </div>
          {#if catalog.skills.length === 0}
            <div class="surface px-4 py-3 text-xs text-text-muted">No skills listed</div>
          {:else}
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              {#each catalog.skills as entry (entry.path)}
                <article
                  class="rounded-lg border border-border-subtle bg-bg-surface p-4 flex flex-col min-h-[200px]"
                >
                  <header class="mb-2">
                    <h3 class="text-sm font-semibold text-accent-cyan break-words">
                      {entry.name}
                    </h3>
                    <div class="mt-1 text-[10px] font-mono text-text-muted truncate">
                      {entry.path}
                    </div>
                  </header>
                  <p
                    class="text-xs text-text-muted leading-relaxed flex-1 overflow-hidden"
                    style="display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;"
                  >
                    {shortExcerpt(entry.readme_excerpt)}
                  </p>
                  <footer
                    class="mt-3 pt-3 border-t border-border-subtle flex items-center gap-2 flex-wrap"
                  >
                    <button
                      type="button"
                      onclick={() => openPreview(entry, 'skill')}
                      class="inline-flex items-center px-3 py-1.5 rounded-md border border-border-subtle text-xs text-text-muted hover:text-text-primary hover:border-accent-cyan transition min-h-[32px]"
                    >
                      View SKILL.md
                    </button>
                    <button
                      type="button"
                      onclick={() => copySkill(entry)}
                      class="inline-flex items-center px-3 py-1.5 rounded-md border border-border-subtle text-xs text-text-muted hover:text-text-primary hover:border-accent-cyan transition min-h-[32px]"
                    >
                      Copy
                    </button>
                    <button
                      type="button"
                      disabled={!localSidecarRunning || installingLocal.has(entry.name)}
                      onclick={() => installLocal(entry)}
                      title={localSidecarRunning
                        ? `Write SKILL.md into the local sidecar's skills dir`
                        : 'Start the local sidecar (Settings → Connection) to enable this'}
                      class="inline-flex items-center px-3 py-1.5 rounded-md bg-accent-gold text-bg-deep text-xs font-semibold hover:brightness-95 transition min-h-[32px] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100"
                    >
                      {installingLocal.has(entry.name) ? 'Installing…' : 'Install (local)'}
                    </button>
                    <button
                      type="button"
                      disabled={!gatewayClient || installingGateway.has(entry.name)}
                      onclick={() => tryGatewayInstall(entry)}
                      title={!gatewayClient
                        ? 'Gateway offline'
                        : `Ask the gateway to installSkill("${entry.name}")`}
                      class="inline-flex items-center px-3 py-1.5 rounded-md border border-accent-cyan/40 text-xs text-accent-cyan hover:bg-accent-cyan/10 transition min-h-[32px] disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {installingGateway.has(entry.name) ? 'Trying…' : 'Try via gateway'}
                    </button>
                  </footer>
                </article>
              {/each}
            </div>
          {/if}
        </section>
      </div>
    {/if}
  </div>
</section>

{#if previewSlug}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <button
    type="button"
    aria-label="Close preview"
    onclick={closePreview}
    class="fixed inset-0 z-40 bg-black/50 cursor-default"
  ></button>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
    role="dialog"
    aria-modal="true"
    aria-labelledby="ironhub-preview-title"
  >
    <div
      class="pointer-events-auto bg-bg-surface border border-border-subtle rounded-lg w-full max-w-3xl max-h-[80vh] flex flex-col shadow-[0_20px_60px_rgba(0,0,0,0.5)]"
    >
      <header
        class="flex items-center justify-between gap-4 px-5 py-4 border-b border-border-subtle"
      >
        <div class="min-w-0">
          <h2 id="ironhub-preview-title" class="text-sm font-semibold text-accent-cyan break-words">
            {previewSlug}
          </h2>
          {#if previewBlob && previewBlob.sha}
            <div class="text-[10px] font-mono text-text-muted truncate mt-0.5">
              sha {previewBlob.sha.slice(0, 12)}
            </div>
          {/if}
        </div>
        <button
          type="button"
          onclick={closePreview}
          aria-label="Close preview"
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
      <div class="flex-1 overflow-auto px-5 py-4">
        {#if previewLoading}
          <div class="text-xs text-text-muted">Loading SKILL.md…</div>
        {:else if previewError}
          <div class="text-xs text-red-400">{previewError}</div>
        {:else if previewBlob}
          <MarkdownView markdown={previewBlob.content} />
        {/if}
      </div>
    </div>
  </div>
{/if}
