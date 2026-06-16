<script lang="ts">
  // RecentSkillsTile — dashboard widget surfacing the most-recently-used
  // skills.
  //
  // Data source: `client.listSkills()` filtered to installed skills,
  // crossed with the `slashUsage` store's per-skill usage timestamps.
  // The brief calls for "most-recently-used 6 (or just first 6 if no
  // usage stamps)" — we get this for free because `slashUsage`
  // already tracks per-slash invocations and exposes them as a sorted
  // list. Skills without a usage stamp fall to the end in source
  // order.
  //
  // Render: a 2x3 grid of skill cards. Each card is a button that
  // routes to /skills?focus=<name> so the user can inspect / run it
  // there. Slash invocation from the dashboard composer is a follow-up.

  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { connection } from '$lib/stores/connection.svelte';
  import { slashUsage } from '$lib/stores/slash-usage.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import type { Skill } from '$lib/api/types';

  let skills = $state<Skill[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let didFail = false;

  async function load() {
    if (!connection.client) {
      loading = false;
      return;
    }
    loading = true;
    loadError = null;
    try {
      skills = await connection.client.listSkills();
    } catch (err) {
      loadError = (err as Error).message;
      if (!didFail) {
        toasts.show(`Failed to load skills: ${(err as Error).message}`, 'error');
        didFail = true;
      }
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  // Cross with the usage store. The store keeps a Map<name, UsageEntry>
  // where each entry carries `lastUsedAt` (ISO). We read the timestamp
  // directly off the entries map; missing entries fall to the end of
  // the sort. Slice to 6 per the brief.
  const recentSkills = $derived(
    [...skills]
      .sort((a, b) => {
        const ea = slashUsage.entries.get(a.name);
        const eb = slashUsage.entries.get(b.name);
        const ta = ea ? Date.parse(ea.lastUsedAt) : -Infinity;
        const tb = eb ? Date.parse(eb.lastUsedAt) : -Infinity;
        return tb - ta;
      })
      .slice(0, 6)
  );

  function openSkill(name: string) {
    void goto(`/skills?focus=${encodeURIComponent(name)}`);
  }
</script>

{#if loadError && recentSkills.length === 0}
  <p class="text-xs text-danger" data-testid="recent-skills-error">
    Couldn't load skills. {loadError}
  </p>
{:else if loading}
  <div class="grid grid-cols-3 gap-2" aria-busy="true" data-testid="recent-skills-skeleton">
    {#each Array(6) as _, i (i)}
      <div class="h-14 rounded-md bg-bg-base/60"></div>
    {/each}
  </div>
{:else if recentSkills.length === 0}
  <p class="text-xs text-text-muted">No skills installed. Browse /skills to add some.</p>
{:else}
  <div class="grid grid-cols-3 gap-2" data-testid="recent-skills-list">
    {#each recentSkills as skill (skill.name)}
      <button
        type="button"
        onclick={() => openSkill(skill.name)}
        class="text-left p-2.5 rounded-md hover:bg-bg-base/60 transition-colors border border-border-subtle/60 min-h-[4.25rem] flex flex-col gap-1"
        title={skill.description}
      >
        <span class="truncate text-xs font-medium text-text-primary">{skill.name}</span>
        <span class="line-clamp-2 text-[10px] text-text-muted leading-tight">
          {skill.description || 'No description'}
        </span>
      </button>
    {/each}
  </div>
{/if}
