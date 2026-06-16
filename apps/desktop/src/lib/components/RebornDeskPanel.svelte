<script lang="ts">
  // "The Desk" — the proactive chief-of-staff home: the "Needs you"
  // approval-gate inbox plus the read-only "Handled" recent activity feed.
  // Pending gates render as cards the user approves/denies in place, while
  // handled jobs show what the agent has recently run without fabricating
  // outcomes.
  //
  // The Desk store is injected (defaulting to the app-wide singleton) so the
  // render tests can drive it with a seeded controller and no I/O.

  import { onMount } from 'svelte';
  import { rebornDesk, RebornDesk } from '$lib/stores/reborn-desk.svelte';

  interface Props {
    desk?: RebornDesk;
  }
  let { desk = rebornDesk }: Props = $props();

  const gateCards = $derived(desk.gateCards);
  const caughtUp = $derived(desk.caughtUp);
  const handledCards = $derived(desk.handledCards);
  const loopCards = $derived(desk.loopCards);

  let loopDraft = $state('');

  function addLoop() {
    const text = loopDraft.trim();
    if (!text) return;
    desk.addLoop(text);
    loopDraft = '';
  }

  function receiptPanelId(jobId: string): string {
    return `desk-receipt-${jobId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  }

  onMount(() => {
    void desk.loadHandled();
  });
</script>

<div class="desk" data-testid="reborn-desk">
  <header class="desk__head">
    <h1 class="desk__title">The Desk</h1>
    <p class="desk__sub">What needs you, and what your chief of staff handled.</p>
  </header>

  <section class="desk__section" aria-label="Needs you">
    <h2 class="desk__section-title">
      Needs you
      {#if gateCards.length > 0}<span class="desk__count">{gateCards.length}</span>{/if}
    </h2>

    {#if caughtUp}
      <div class="desk__empty" data-testid="desk-caught-up">
        <p class="desk__empty-title">You're all caught up</p>
        <p class="desk__empty-sub">Nothing is waiting on your approval.</p>
        <a class="desk__empty-action" href="/chat">Start a conversation →</a>
      </div>
    {:else}
      {#each gateCards as card (card.id)}
        <article class="desk-card" class:desk-card--auth={card.kind === 'auth_required'}>
          <div class="desk-card__body">
            <span class="desk-card__kind">
              {card.kind === 'auth_required' ? 'Authorization' : 'Approval'}
            </span>
            <p class="desk-card__headline">{card.headline}</p>
            {#if card.body}<p class="desk-card__detail">{card.body}</p>{/if}
          </div>
          <div class="desk-card__actions">
            <button type="button" class="desk-btn desk-btn--primary" onclick={() => desk.approve()}>
              Approve
            </button>
            <button type="button" class="desk-btn" onclick={() => desk.deny()}>Deny</button>
          </div>
        </article>
      {/each}
    {/if}
  </section>

  <section class="desk__section" aria-label="Handled">
    <h2 class="desk__section-title">
      Handled
      {#if handledCards.length > 0}<span class="desk__count desk__count--muted"
          >{handledCards.length}</span
        >{/if}
    </h2>

    {#if handledCards.length === 0}
      <div class="desk__empty desk__empty--compact" data-testid="desk-handled-empty">
        <p class="desk__empty-title">Nothing handled yet</p>
        <p class="desk__empty-sub">Run a mission and results land here.</p>
      </div>
    {:else}
      <div class="desk-handled-list" data-testid="desk-handled-list">
        {#each handledCards as card (card.id)}
          {@const expanded = desk.expandedHandledId === card.id}
          {@const receipt = desk.receiptsById[card.id]}
          {@const loadingReceipt = desk.receiptLoadingById[card.id] === true}
          <article class="desk-handled-item">
            <button
              type="button"
              class="desk-handled-row"
              aria-expanded={expanded}
              aria-controls={receiptPanelId(card.id)}
              onclick={() => void desk.toggleHandled(card.id)}
            >
              <div class="desk-card__body">
                <p class="desk-card__headline">{card.title}</p>
                {#if card.detail}<p class="desk-card__detail">{card.detail}</p>{/if}
              </div>
              <span class="desk-handled-row__meta">
                <span
                  class="desk-status-pill"
                  class:desk-status-pill--done={card.status === 'done'}
                  class:desk-status-pill--running={card.status === 'running'}
                  class:desk-status-pill--failed={card.status === 'failed'}
                >
                  {card.status}
                </span>
                <span class="desk-disclosure" aria-hidden="true">{expanded ? '−' : '+'}</span>
              </span>
            </button>
            {#if expanded}
              <div
                id={receiptPanelId(card.id)}
                class="desk-receipt"
                data-testid={`desk-receipt-${card.id}`}
              >
                {#if loadingReceipt && !receipt}
                  <p class="desk-receipt__muted">Loading result receipt…</p>
                {:else}
                  <p class="desk-receipt__state">
                    Final state <span>{receipt?.state ?? card.detail ?? 'unknown'}</span>
                  </p>
                  <p class="desk-receipt__summary">
                    {receipt?.summary ?? 'No result detail.'}
                  </p>
                  <div class="desk-receipt__foot">
                    {#if (receipt?.fileCount ?? 0) > 0}
                      <span class="desk-receipt__files">
                        {receipt?.fileCount}
                        {receipt?.fileCount === 1 ? 'file' : 'files'}
                      </span>
                    {/if}
                    <a
                      class="desk-receipt__link"
                      href={`/jobs?open=${encodeURIComponent(card.id)}`}
                    >
                      View full job →
                    </a>
                  </div>
                {/if}
              </div>
            {/if}
          </article>
        {/each}
      </div>
    {/if}
  </section>

  <section class="desk__section" aria-label="Open loops">
    <h2 class="desk__section-title">
      Open loops
      {#if loopCards.length > 0}<span class="desk__count desk__count--muted"
          >{loopCards.length}</span
        >{/if}
    </h2>
    <form
      class="desk-loop-add"
      onsubmit={(e) => {
        e.preventDefault();
        addLoop();
      }}
    >
      <input
        class="desk-loop-add__input"
        bind:value={loopDraft}
        placeholder="Track a commitment…"
        aria-label="Track a commitment"
      />
      <button
        type="submit"
        class="desk-btn desk-btn--primary"
        disabled={loopDraft.trim().length === 0}
      >
        Add
      </button>
    </form>
    {#each loopCards as loop (loop.id)}
      <article class="desk-card desk-card--loop">
        <div class="desk-card__body">
          <p class="desk-card__headline">{loop.text}</p>
        </div>
        <div class="desk-card__actions">
          <button
            type="button"
            class="desk-btn desk-btn--primary"
            onclick={() => desk.resolveLoop(loop.id)}
          >
            Done
          </button>
          <button type="button" class="desk-btn" onclick={() => desk.dismissLoop(loop.id)}>
            Dismiss
          </button>
        </div>
      </article>
    {/each}
  </section>
</div>

<style>
  .desk {
    height: 100%;
    overflow-y: auto;
    padding: 1.5rem 1.75rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }
  .desk__head {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .desk__title {
    font-size: 1.35rem;
    font-weight: 650;
    color: var(--v2-text, #e6ebf2);
  }
  .desk__sub {
    font-size: 0.875rem;
    color: var(--v2-text-muted, #8a93a6);
  }
  .desk__section {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .desk__section-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--v2-text-muted, #8a93a6);
  }
  .desk__count {
    display: inline-flex;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 0.35rem;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: var(--v2-accent, #4ca7e6);
    color: #fff;
    font-size: 0.7rem;
    font-weight: 700;
  }
  .desk__count--muted {
    background: var(--v2-surface-2, rgba(255, 255, 255, 0.12));
    color: var(--v2-text-muted, #8a93a6);
  }
  .desk__empty {
    padding: 1.5rem;
    border: 1px dashed var(--v2-border, rgba(255, 255, 255, 0.12));
    border-radius: 0.8rem;
    text-align: center;
  }
  .desk__empty--compact {
    padding: 1rem;
    text-align: left;
  }
  .desk__empty-title {
    font-weight: 600;
    color: var(--v2-text, #e6ebf2);
  }
  .desk__empty-sub {
    font-size: 0.85rem;
    color: var(--v2-text-muted, #8a93a6);
  }
  .desk__empty-action {
    display: inline-block;
    margin-top: 0.75rem;
    font-size: 0.85rem;
    font-weight: 550;
    color: var(--v2-accent-text, #8fc8f2);
    text-decoration: none;
  }
  .desk__empty-action:hover {
    text-decoration: underline;
  }
  .desk-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.9rem 1rem;
    border: 1px solid var(--v2-accent, #4ca7e6);
    border-radius: 0.8rem;
    background: var(--v2-accent-soft, rgba(76, 167, 230, 0.14));
  }
  .desk-card--auth {
    border-color: var(--v2-warning, #e6b04c);
    background: var(--v2-warning-soft, rgba(230, 176, 76, 0.14));
  }
  .desk-card--loop {
    border-color: var(--v2-border, rgba(255, 255, 255, 0.12));
    background: var(--v2-surface, rgba(255, 255, 255, 0.04));
  }
  .desk-handled-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--v2-border, rgba(255, 255, 255, 0.12));
    border-radius: 0.55rem;
    overflow: hidden;
    background: var(--v2-surface, rgba(255, 255, 255, 0.04));
  }
  .desk-handled-row {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.7rem 0.8rem;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    font: inherit;
    cursor: pointer;
  }
  .desk-handled-row:hover,
  .desk-handled-row:focus-visible {
    background: var(--v2-surface-2, rgba(255, 255, 255, 0.06));
  }
  .desk-handled-row:focus-visible {
    outline: 2px solid var(--v2-accent, #4ca7e6);
    outline-offset: -2px;
  }
  .desk-handled-item {
    border-bottom: 1px solid var(--v2-border, rgba(255, 255, 255, 0.08));
  }
  .desk-handled-item:last-child {
    border-bottom: 0;
  }
  .desk-handled-row__meta {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    flex: 0 0 auto;
  }
  .desk-disclosure {
    width: 1rem;
    color: var(--v2-text-muted, #8a93a6);
    font-family: var(--v2-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
    font-size: 0.9rem;
    line-height: 1;
    text-align: center;
  }
  .desk-receipt {
    padding: 0.75rem 0.85rem 0.85rem;
    border-top: 1px solid var(--v2-border, rgba(255, 255, 255, 0.08));
    background: var(--v2-surface-2, rgba(255, 255, 255, 0.06));
  }
  .desk-receipt__state {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--v2-text-muted, #8a93a6);
  }
  .desk-receipt__state span {
    color: var(--v2-text, #e6ebf2);
  }
  .desk-receipt__summary {
    margin-top: 0.35rem;
    color: var(--v2-text, #e6ebf2);
    font-size: 0.85rem;
    line-height: 1.35;
    word-break: break-word;
  }
  .desk-receipt__muted {
    color: var(--v2-text-muted, #8a93a6);
    font-size: 0.85rem;
  }
  .desk-receipt__foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.7rem;
    margin-top: 0.55rem;
  }
  .desk-receipt__files {
    color: var(--v2-text-muted, #8a93a6);
    font-size: 0.78rem;
  }
  .desk-receipt__link {
    color: var(--v2-accent-text, #8fc8f2);
    font-size: 0.8rem;
    font-weight: 600;
    text-decoration: none;
  }
  .desk-receipt__link:hover {
    text-decoration: underline;
  }
  .desk-card__body {
    min-width: 0;
  }
  .desk-card__kind {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--v2-text-muted, #8a93a6);
  }
  .desk-card__headline {
    margin-top: 0.15rem;
    color: var(--v2-text, #e6ebf2);
    font-weight: 550;
    word-break: break-word;
  }
  .desk-card__detail {
    margin-top: 0.25rem;
    font-size: 0.85rem;
    color: var(--v2-text-muted, #8a93a6);
    word-break: break-word;
  }
  .desk-card__actions {
    display: flex;
    gap: 0.5rem;
    flex: 0 0 auto;
  }
  .desk-status-pill {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    min-height: 1.4rem;
    padding: 0 0.45rem;
    border: 1px solid var(--v2-border, rgba(255, 255, 255, 0.14));
    border-radius: 999px;
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .desk-status-pill--done {
    border-color: var(--v2-success, rgba(87, 196, 133, 0.35));
    background: var(--v2-success-soft, rgba(87, 196, 133, 0.12));
    color: var(--v2-success-text, #7ee6a5);
  }
  .desk-status-pill--running {
    border-color: var(--v2-warning, rgba(230, 176, 76, 0.35));
    background: var(--v2-warning-soft, rgba(230, 176, 76, 0.12));
    color: var(--v2-warning-text, #e6c37a);
  }
  .desk-status-pill--failed {
    border-color: var(--v2-danger, rgba(239, 92, 92, 0.4));
    background: var(--v2-danger-soft, rgba(239, 92, 92, 0.12));
    color: var(--v2-danger-text, #ff8f8f);
  }
  .desk-loop-add {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .desk-loop-add__input {
    flex: 1 1 auto;
    padding: 0.5rem 0.7rem;
    border-radius: 0.55rem;
    border: 1px solid var(--v2-border, rgba(255, 255, 255, 0.12));
    background: var(--v2-surface, rgba(255, 255, 255, 0.04));
    color: var(--v2-text, #e6ebf2);
    font: inherit;
  }
  .desk-btn {
    padding: 0.5rem 0.9rem;
    border-radius: 0.55rem;
    border: 1px solid var(--v2-border, rgba(255, 255, 255, 0.14));
    background: var(--v2-surface-2, rgba(255, 255, 255, 0.06));
    color: var(--v2-text, #e6ebf2);
    cursor: pointer;
  }
  .desk-btn--primary {
    background: var(--v2-accent, #4ca7e6);
    border-color: var(--v2-accent, #4ca7e6);
    color: #fff;
  }
</style>
