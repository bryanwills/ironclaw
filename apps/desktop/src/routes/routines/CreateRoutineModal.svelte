<script lang="ts">
  // Create-routine modal for the routines surface.
  //
  // Owns form state and validation; the parent supplies connection details and
  // decides how to refresh/insert a created routine.

  import { onMount } from 'svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { createRoutine, type Routine, type RoutineClientOptions } from '$lib/api/routines';

  type RoutineTemplateId = 'daily-morning-brief' | 'inbox-triage' | 'weekly-review' | 'custom';

  interface RoutineTemplate {
    id: RoutineTemplateId;
    label: string;
    description: string;
    schedule: string;
    prompt: string;
  }

  const routineTemplates: readonly RoutineTemplate[] = [
    {
      id: 'daily-morning-brief',
      label: 'Daily Morning Brief',
      description: 'Start each workday with priorities, risks, and follow-ups.',
      schedule: '0 8 * * *',
      prompt: 'Prepare a morning brief: priorities, calendar risks, and follow-ups that need me.'
    },
    {
      id: 'inbox-triage',
      label: 'Inbox Triage (hourly)',
      description: 'Scan incoming items and surface decisions that need attention.',
      schedule: '0 * * * *',
      prompt: 'Review new inbox items, group what matters, flag replies and decisions for me.'
    },
    {
      id: 'weekly-review',
      label: 'Weekly Review',
      description: 'Close the week with open loops and next priorities.',
      schedule: '0 17 * * 5',
      prompt: "Summarize the week: wins, open loops, risks, and next week's three priorities."
    },
    {
      id: 'custom',
      label: 'Custom',
      description: 'Write a schedule and prompt from scratch.',
      schedule: '',
      prompt: ''
    }
  ];

  interface Props {
    open: boolean;
    baseUrl: string;
    token: string | null;
    onclose: () => void;
    oncreated: (routine: Routine) => Promise<void> | void;
  }

  let { open, baseUrl, token, onclose, oncreated }: Props = $props();

  let name = $state('');
  let schedule = $state('');
  let prompt = $state('');
  let enabled = $state(true);
  let submitting = $state(false);
  let nameTouched = $state(false);
  let scheduleTouched = $state(false);
  let promptTouched = $state(false);
  let nameInputEl: HTMLInputElement | undefined = $state();
  let templateFieldsetEl: HTMLFieldSetElement | undefined = $state();
  let selectedTemplateId = $state<RoutineTemplateId>('daily-morning-brief');
  let detailsExpanded = $state(false);

  const trimmedName = $derived(name.trim());
  const trimmedSchedule = $derived(schedule.trim());
  const trimmedPrompt = $derived(prompt.trim());
  const nameError = $derived(nameTouched ? validateName(trimmedName) : null);
  const scheduleError = $derived(scheduleTouched ? validateSchedule(trimmedSchedule) : null);
  const promptError = $derived(promptTouched ? validatePrompt(trimmedPrompt) : null);
  const canSubmit = $derived(
    !submitting &&
      Boolean(token) &&
      validateName(trimmedName) === null &&
      validateSchedule(trimmedSchedule) === null &&
      validatePrompt(trimmedPrompt) === null
  );

  $effect(() => {
    if (open) {
      selectTemplate(routineTemplates[0]);
      queueMicrotask(() => {
        const firstTemplateInput = templateFieldsetEl?.querySelector<HTMLInputElement>(
          'input[name="routine-template"]'
        );
        firstTemplateInput?.focus();
      });
    } else {
      name = '';
      schedule = '';
      prompt = '';
      enabled = true;
      submitting = false;
      nameTouched = false;
      scheduleTouched = false;
      promptTouched = false;
      selectedTemplateId = 'daily-morning-brief';
      detailsExpanded = false;
    }
  });

  onMount(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!open) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onclose();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  function validateName(value: string): string | null {
    if (!value) return 'Name is required.';
    if (value.length > 128) return 'Name must be 128 characters or fewer.';
    return null;
  }

  function validateSchedule(value: string): string | null {
    if (!value) return 'Schedule is required.';
    if (value.length > 120) return 'Schedule must be 120 characters or fewer.';
    const parts = value.split(/\s+/);
    if (parts.length !== 5 || parts.some((part) => part.length === 0)) {
      return 'Use a five-field cron schedule.';
    }
    return null;
  }

  function validatePrompt(value: string): string | null {
    if (!value) return 'Prompt is required.';
    if (value.length > 4000) return 'Prompt must be 4000 characters or fewer.';
    return null;
  }

  function touchAll() {
    nameTouched = true;
    scheduleTouched = true;
    promptTouched = true;
  }

  function selectTemplate(template: RoutineTemplate | undefined) {
    if (!template) return;
    selectedTemplateId = template.id;
    name = template.id === 'custom' ? '' : template.label;
    schedule = template.schedule;
    prompt = template.prompt;
    detailsExpanded = template.id === 'custom';
    nameTouched = false;
    scheduleTouched = false;
    promptTouched = false;
  }

  function toggleDetails() {
    detailsExpanded = !detailsExpanded;
    if (detailsExpanded) {
      queueMicrotask(() => nameInputEl?.focus());
    }
  }

  function tryClose() {
    onclose();
  }

  async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    touchAll();
    if (!canSubmit) return;
    submitting = true;
    const opts: RoutineClientOptions = { baseUrl, token };
    try {
      const result = await createRoutine(opts, {
        name: trimmedName,
        schedule: trimmedSchedule,
        prompt: trimmedPrompt,
        enabled
      });
      if (!result.ok) {
        toasts.show('Routine creation needs a newer gateway', 'info');
        submitting = false;
        return;
      }
      await oncreated(result.routine);
      toasts.show(`Created routine "${result.routine.name}".`, 'success');
      onclose();
    } catch (err) {
      toasts.show(`Create routine failed: ${(err as Error).message}`, 'error');
      submitting = false;
    }
  }
</script>

{#if open}
  <button
    type="button"
    aria-label="Close create-routine modal"
    onclick={tryClose}
    class="fixed inset-0 z-40 bg-black/50 cursor-default"
  ></button>

  <div
    class="v2-modal-shell fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[min(92vw,560px)] flex flex-col overflow-hidden"
    role="dialog"
    aria-modal="true"
    aria-labelledby="create-routine-title"
  >
    <header class="flex items-center justify-between gap-4 px-5 py-4 border-b border-border-subtle">
      <div>
        <h2 id="create-routine-title" class="text-sm font-semibold text-text-primary">
          New routine
        </h2>
        <p class="mt-1 text-xs text-text-muted">Pick a starting point, then edit.</p>
      </div>
      <button
        type="button"
        onclick={tryClose}
        aria-label="Close"
        disabled={submitting}
        class="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-surface transition disabled:opacity-50"
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
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </header>

    <form onsubmit={handleSubmit} class="flex flex-col gap-4 px-5 py-4">
      <fieldset class="space-y-2" bind:this={templateFieldsetEl}>
        <legend class="block text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Template
        </legend>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {#each routineTemplates as template}
            <label
              class="relative rounded-md border border-border-subtle bg-bg-deep px-3 py-2 text-left transition-colors hover:border-accent-cyan focus-within:border-accent-cyan"
              class:border-accent-cyan={selectedTemplateId === template.id}
            >
              <input
                class="sr-only"
                type="radio"
                name="routine-template"
                value={template.id}
                checked={selectedTemplateId === template.id}
                onchange={() => selectTemplate(template)}
              />
              <span class="block text-xs font-medium text-text-primary">{template.label}</span>
              <span class="mt-1 block text-[11px] leading-4 text-text-muted">
                {template.description}
              </span>
            </label>
          {/each}
        </div>
      </fieldset>

      <button
        type="button"
        aria-expanded={detailsExpanded}
        aria-controls="routine-details"
        onclick={toggleDetails}
        class="inline-flex w-fit items-center gap-2 rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-muted transition hover:border-accent-cyan hover:text-text-primary"
      >
        <svg
          viewBox="0 0 24 24"
          class="h-3 w-3 transition-transform"
          class:rotate-90={detailsExpanded}
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        Edit details
      </button>

      <div id="routine-details" class="flex flex-col gap-4" class:hidden={!detailsExpanded}>
        <div class="space-y-1.5">
          <label
            for="routine-name"
            class="block text-[11px] font-semibold uppercase tracking-wider text-text-muted"
          >
            Name
          </label>
          <input
            id="routine-name"
            type="text"
            bind:this={nameInputEl}
            value={name}
            oninput={(event) => {
              name = (event.currentTarget as HTMLInputElement).value;
              nameTouched = true;
            }}
            maxlength="128"
            autocomplete="off"
            placeholder="Morning summary"
            class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors"
            class:border-red-500={nameError}
          />
          {#if nameError}
            <p class="text-[11px] text-red-400">{nameError}</p>
          {/if}
        </div>

        <div class="space-y-1.5">
          <label
            for="routine-schedule"
            class="block text-[11px] font-semibold uppercase tracking-wider text-text-muted"
          >
            Schedule
          </label>
          <input
            id="routine-schedule"
            type="text"
            value={schedule}
            oninput={(event) => {
              schedule = (event.currentTarget as HTMLInputElement).value;
              scheduleTouched = true;
            }}
            placeholder="0 9 * * *"
            autocomplete="off"
            spellcheck="false"
            class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors"
            class:border-red-500={scheduleError}
            aria-describedby="routine-schedule-help"
          />
          <p id="routine-schedule-help" class="text-[11px] text-text-muted">
            Cron format: minute hour day-of-month month day-of-week.
          </p>
          {#if scheduleError}
            <p class="text-[11px] text-red-400">{scheduleError}</p>
          {/if}
        </div>

        <div class="space-y-1.5">
          <label
            for="routine-prompt"
            class="block text-[11px] font-semibold uppercase tracking-wider text-text-muted"
          >
            Prompt
          </label>
          <textarea
            id="routine-prompt"
            rows="8"
            value={prompt}
            oninput={(event) => {
              prompt = (event.currentTarget as HTMLTextAreaElement).value;
              promptTouched = true;
            }}
            placeholder="What should this routine run?"
            class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors resize-none"
            class:border-red-500={promptError}
          ></textarea>
          {#if promptError}
            <p class="text-[11px] text-red-400">{promptError}</p>
          {/if}
        </div>
      </div>

      <div
        class="flex items-center justify-between gap-4 rounded-md border border-border-subtle bg-bg-deep px-3 py-2"
      >
        <span>
          <span class="block text-xs font-medium text-text-primary">Enabled</span>
          <span class="block text-[11px] text-text-muted"
            >Start this routine after creating it.</span
          >
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={enabled ? 'Disable new routine' : 'Enable new routine'}
          onclick={() => (enabled = !enabled)}
          class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors"
          class:bg-accent-cyan={enabled}
          class:bg-border-subtle={!enabled}
        >
          <span
            class="inline-block h-3.5 w-3.5 transform rounded-full bg-bg-deep transition-transform"
            class:translate-x-4={enabled}
            class:translate-x-1={!enabled}
          ></span>
        </button>
      </div>

      <div
        class="pt-1 flex items-center justify-end gap-2 border-t border-border-subtle -mx-5 px-5 pt-3"
      >
        <button
          type="button"
          onclick={tryClose}
          disabled={submitting}
          class="px-3 py-1.5 rounded-md border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent-cyan transition text-xs disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          class="inline-flex items-center gap-2 px-4 py-1.5 rounded-md bg-accent-cyan text-bg-deep text-xs font-semibold hover:brightness-95 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {#if submitting}
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
            Creating…
          {:else}
            Create
          {/if}
        </button>
      </div>
    </form>
  </div>
{/if}
