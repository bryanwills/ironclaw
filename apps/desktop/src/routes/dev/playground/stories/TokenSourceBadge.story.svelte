<script lang="ts" module>
  export const meta = {
    title: 'TokenSourceBadge',
    description:
      'v0.2.9 surface telling the user which backing store served the gateway-token. Cyan = Keychain (normal), gold = file fallback (keychain ACL likely wedged), muted = absent.'
  };
</script>

<script lang="ts">
  import TokenSourceBadge from '$lib/components/TokenSourceBadge.svelte';
  import type { TokenSource } from '$lib/stores/settings.svelte';

  let forced = $state<TokenSource>('keychain');
  const ALL: TokenSource[] = ['keychain', 'file', 'absent'];

  const snippet = $derived(`<TokenSourceBadge forcedSource="${forced}" />`);
</script>

<div class="grid grid-cols-[1fr_280px] gap-6 h-full">
  <div class="space-y-6 overflow-y-auto pr-2">
    <header>
      <h1 class="text-xl font-semibold text-text-primary">{meta.title}</h1>
      <p class="text-sm text-text-muted mt-1">{meta.description}</p>
    </header>

    <section class="surface p-10 flex items-center justify-center min-h-[140px]">
      <TokenSourceBadge forcedSource={forced} />
    </section>

    <section>
      <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 mb-2 font-semibold">
        All states
      </h2>
      <div class="surface p-6 flex flex-wrap items-center gap-3">
        {#each ALL as s (s)}
          <div class="flex items-center gap-2">
            <TokenSourceBadge forcedSource={s} />
            <code class="text-[10px] text-text-muted font-mono">{s}</code>
          </div>
        {/each}
      </div>
    </section>

    <section>
      <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 mb-2 font-semibold">
        Background
      </h2>
      <div class="surface p-4 text-xs text-text-muted leading-relaxed space-y-2">
        <p>
          Shipped in v0.2.9 to make the keychain-vs-file-fallback story (see v0.2.8 / <code
            >scripts/stage-token.sh</code
          >) legible without RUST_LOG.
        </p>
        <p>
          The badge polls every 10s by default — re-entering the token via Settings (which writes
          both stores) flips the source from
          <code>file</code>
          back to
          <code>keychain</code> without a full reload, provided the macOS keychain ACL grant survives
          the new binary's signature.
        </p>
        <p>
          On a signed Developer-ID build the badge should sit on
          <code>keychain</code> permanently. Persistent
          <code>file</code> on a release build is a signal the signing identity isn't trusted for the
          existing keychain entries.
        </p>
      </div>
    </section>

    <section>
      <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 mb-2 font-semibold">
        Example
      </h2>
      <pre
        class="bg-bg-deep border border-border-subtle rounded-md p-3 text-xs font-mono text-text-primary overflow-x-auto"><code
          >{snippet}</code
        ></pre>
    </section>
  </div>

  <aside class="border-l border-border-subtle pl-4 space-y-4 text-xs overflow-y-auto">
    <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 font-semibold">Controls</h2>

    <fieldset class="block">
      <legend class="block text-text-muted mb-1">Forced source</legend>
      <div class="space-y-1">
        {#each ALL as s (s)}
          <label class="flex items-center gap-2 text-text-primary cursor-pointer">
            <input
              type="radio"
              bind:group={forced}
              value={s}
              class="accent-accent-cyan"
              name="forced-source"
            />
            <span class="font-mono">{s}</span>
          </label>
        {/each}
      </div>
    </fieldset>

    <div class="text-text-muted/70 leading-relaxed">
      <p>
        <code>forcedSource</code> bypasses the IPC fetch — the badge renders the picked state directly.
        Drop the prop in production callers to enable the auto-poll.
      </p>
    </div>
  </aside>
</div>
