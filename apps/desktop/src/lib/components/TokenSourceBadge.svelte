<script lang="ts">
  // Badge showing where the gateway-token was loaded from for a given
  // profile. Shipped in v0.2.9 to make the keychain-vs-file-fallback
  // story (see v0.2.8 / scripts/stage-token.sh) legible to users
  // without having to read RUST_LOG output.
  //
  // Pulls from src-tauri/src/keychain.rs:get_source via the
  // `get_token_source` IPC. Source is one of:
  //   - "keychain" — macOS Keychain ACL is healthy, normal path
  //   - "file"     — keychain timed out, file fallback served the token
  //   - "absent"   — neither store has a value (sign-in required)
  //
  // The badge polls on a slow cadence (10s) so a Settings re-enter of
  // the token (which writes both stores) flips the badge without a
  // full reload.

  import { onMount, onDestroy } from 'svelte';
  import { getTokenSource, type TokenSource } from '$lib/stores/settings.svelte';

  interface Props {
    /** Profile id to query. Defaults to "default" — passes through. */
    profileId?: string;
    /** Poll interval ms. 0 = one-shot. */
    pollMs?: number;
    /** Forced source for stories / unit tests — when provided, bypasses
     *  the IPC fetch entirely and renders that state. Useful for the
     *  playground (which mocks Tauri) and for callers that already
     *  resolved the source themselves. */
    forcedSource?: TokenSource;
  }

  let { profileId = 'default', pollMs = 10_000, forcedSource = undefined }: Props = $props();

  let liveSource = $state<TokenSource | 'loading'>('loading');
  let timer: ReturnType<typeof setInterval> | null = null;

  // When `forcedSource` is passed, the prop fully drives the displayed
  // state (re-renders if the parent flips it — useful for the playground
  // controls). Otherwise we surface the IPC-polled value.
  const source = $derived<TokenSource | 'loading'>(forcedSource ?? liveSource);

  async function refresh() {
    if (forcedSource) return;
    try {
      liveSource = await getTokenSource(profileId);
    } catch {
      // getTokenSource swallows its own errors; this is belt-and-braces
      liveSource = 'absent';
    }
  }

  onMount(() => {
    if (forcedSource) return;
    void refresh();
    if (pollMs > 0) {
      timer = setInterval(refresh, pollMs);
    }
  });

  onDestroy(() => {
    if (timer) clearInterval(timer);
  });

  const PRESENT: Record<
    TokenSource,
    { label: string; dotClass: string; chipClass: string; title: string }
  > = {
    keychain: {
      label: 'Keychain',
      dotClass: 'bg-accent-cyan',
      chipClass: 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30',
      title: 'Token loaded from macOS Keychain.'
    },
    file: {
      label: 'File fallback',
      dotClass: 'bg-accent-gold',
      chipClass: 'bg-accent-gold/10 text-accent-gold border-accent-gold/30',
      title:
        'Token loaded from a file, not Keychain. The Keychain prompt likely hung. Signed builds avoid this.'
    },
    absent: {
      label: 'No token',
      dotClass: 'bg-text-muted/50',
      chipClass: 'bg-text-muted/10 text-text-muted border-text-muted/30',
      title: 'No gateway token. Add one in the profile section to sign in.'
    }
  };
</script>

{#if source === 'loading'}
  <span
    class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-text-muted/10 text-text-muted/70 border border-text-muted/20"
    aria-label="Token source: loading"
  >
    <span class="w-1.5 h-1.5 rounded-full bg-text-muted/40 animate-pulse" aria-hidden="true"></span>
    …
  </span>
{:else}
  {@const info = PRESENT[source]}
  <span
    class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border {info.chipClass}"
    title={info.title}
    aria-label="Token source: {info.label}"
    data-testid="token-source-badge"
    data-source={source}
  >
    <span class="w-1.5 h-1.5 rounded-full {info.dotClass}" aria-hidden="true"></span>
    {info.label}
  </span>
{/if}
