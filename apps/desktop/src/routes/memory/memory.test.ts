// Memory inspector route tests.
//
// Mock the connection store + IronClawClient surface the route reads from,
// then render `+page.svelte` and assert against the DOM. Same mocking
// pattern as `src/lib/components/Sidebar.snap.test.ts`: hoisted stubs +
// `vi.mock` factories that capture them. The shared `vi.hoisted` block
// is what lets a test mutate `clientStub.getMemoryTree` and still have
// the mocked module reflect the change at render time.
//
// What we cover (≥6 cases):
//   1. List renders N entries from `getMemoryTree`.
//   2. Search input filters the visible list down to a substring match.
//   3. Selecting a card fetches `readMemory` and shows content.
//   4. Edit → Save fires `writeMemory` and updates the rendered content.
//   5. Delete with two-click confirm fires `deleteMemory` and removes the
//      row from the list.
//   6. Refresh button re-fires `getMemoryTree` (and the second call
//      reflects new server state).
//   7. New-memory submission fires `writeMemory` and prepends the row.
//   8. Filter shows a "No entries match" empty state when nothing matches.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';

type MarkdownRendererOptions = {
  markdown?: string;
};

function mountMarkdownStub(anchor: Node, markdown: string): Record<string, never> {
  const el = document.createElement('div');
  el.className = 'markdown';
  el.textContent = markdown;
  anchor.parentNode?.insertBefore(el, anchor);
  return {};
}

// ---- Stubs (hoisted so vi.mock factories can capture them) -----------------
const { connectionStub, toastsStub, surfaceRefreshStub, clientStub } = vi.hoisted(() => {
  type MemoryNode = {
    path: string;
    type: 'file' | 'dir';
    size?: number;
    updated_at?: string;
  };

  const client = {
    getMemoryTree: vi.fn<() => Promise<MemoryNode[]>>(),
    listMemory: vi.fn<() => Promise<MemoryNode[]>>(),
    readMemory: vi.fn<(path: string) => Promise<{ content: string; metadata?: unknown }>>(),
    writeMemory:
      vi.fn<(path: string, content: string) => Promise<{ ok: boolean; path?: string }>>(),
    deleteMemory: vi.fn<(path: string) => Promise<{ ok: boolean }>>(),
    searchMemory:
      vi.fn<
        (
          query: string,
          limit?: number
        ) => Promise<Array<{ path: string; snippet: string; score: number }>>
      >()
  };

  const connection = {
    status: 'connected' as 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error',
    client: client as unknown,
    init: vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  };

  const toasts = {
    show: vi.fn<(message: string, kind?: string) => number>().mockReturnValue(0),
    dismiss: vi.fn(),
    clear: vi.fn(),
    toasts: [] as Array<{ id: number; message: string; kind: string }>
  };

  const surfaceRefresh = {
    register: vi.fn(),
    unregister: vi.fn(),
    invoke: vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
  };

  return {
    connectionStub: connection,
    toastsStub: toasts,
    surfaceRefreshStub: surfaceRefresh,
    clientStub: client
  };
});

vi.mock('$app/state', () => ({
  page: { url: { pathname: '/memory' } },
  navigating: null,
  updated: { current: false }
}));

vi.mock('$app/navigation', () => ({
  goto: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('$lib/stores/connection.svelte', () => ({
  connection: connectionStub
}));

vi.mock('$lib/stores/toasts.svelte', () => ({
  toasts: toastsStub
}));

vi.mock('$lib/stores/surface-refresh.svelte', () => ({
  surfaceRefresh: surfaceRefreshStub
}));

// MarkdownView has its own focused tests. This route spec only needs to prove
// selected content reaches the renderer; a tiny stub avoids timing flakes from
// dynamically importing the full markdown stack under the full vitest run.
vi.mock('$lib/components/MarkdownView.svelte', async () => ({
  default: function MarkdownViewStub(anchor: Node, props: MarkdownRendererOptions) {
    return mountMarkdownStub(anchor, props?.markdown ?? '');
  }
}));

// Import AFTER mocks land so the route picks them up.
import MemoryPage from './+page.svelte';

// ---- Fixtures --------------------------------------------------------------
const NODES = [
  {
    path: 'projects/alpha/notes.md',
    type: 'file' as const,
    updated_at: '2026-05-28T10:00:00Z'
  },
  {
    path: 'contacts/bob.md',
    type: 'file' as const,
    updated_at: '2026-05-27T10:00:00Z'
  },
  {
    path: 'observations/today.md',
    type: 'file' as const,
    updated_at: '2026-05-26T10:00:00Z'
  },
  // A directory entry — should be filtered out at load time, not rendered.
  {
    path: 'projects',
    type: 'dir' as const,
    updated_at: undefined
  }
];

// ---- Test bootstrap --------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  // Re-seed default mocks so each test starts from a known state.
  clientStub.getMemoryTree.mockResolvedValue(NODES);
  clientStub.readMemory.mockResolvedValue({ content: '# Hello\n\nbody.' });
  clientStub.writeMemory.mockResolvedValue({ ok: true, path: 'projects/alpha/notes.md' });
  clientStub.deleteMemory.mockResolvedValue({ ok: true });
  connectionStub.client = clientStub;
  connectionStub.status = 'connected';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Memory inspector route', () => {
  it('renders one card per file node (dirs are filtered out)', async () => {
    const { findAllByTestId, queryByText } = render(MemoryPage);

    // 3 file nodes from NODES; the `projects` directory is filtered.
    const cards = await findAllByTestId('memory-card');
    expect(cards).toHaveLength(3);
    expect(cards[0].textContent).toContain('projects/alpha/notes.md');
    expect(cards[1].textContent).toContain('contacts/bob.md');
    expect(cards[2].textContent).toContain('observations/today.md');

    // Count badge reflects file count, not raw tree size.
    expect(queryByText('3')).not.toBeNull();
  });

  it('search input filters the list to a substring match', async () => {
    const { findAllByTestId, queryAllByTestId, getByLabelText } = render(MemoryPage);
    await findAllByTestId('memory-card');

    const search = getByLabelText(/filter memory entries/i) as HTMLInputElement;
    await fireEvent.input(search, { target: { value: 'contacts' } });

    // Debounce is 200ms — the route reads `filter` after the timer fires.
    await waitFor(() => {
      const filtered = queryAllByTestId('memory-card');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].textContent).toContain('contacts/bob.md');
    });
  });

  it('shows an empty-state message when filter matches nothing', async () => {
    const { findAllByTestId, queryAllByTestId, getByLabelText, findByText } = render(MemoryPage);
    await findAllByTestId('memory-card');

    const search = getByLabelText(/filter memory entries/i) as HTMLInputElement;
    await fireEvent.input(search, { target: { value: 'nonexistent-xyz' } });

    await waitFor(() => {
      expect(queryAllByTestId('memory-card')).toHaveLength(0);
    });
    expect(await findByText(/No entries match/i)).toBeTruthy();
  });

  it('clicking a card loads content via readMemory and shows it', async () => {
    clientStub.readMemory.mockResolvedValueOnce({ content: '# Bob' });
    const { findAllByTestId, container } = render(MemoryPage);
    const cards = await findAllByTestId('memory-card');

    // Click the second card (`contacts/bob.md`).
    await fireEvent.click(cards[1]);

    expect(clientStub.readMemory).toHaveBeenCalledWith('contacts/bob.md');
    // MarkdownView renders into a `.markdown` wrapper — wait for the
    // text to land inside it.
    await waitFor(() => {
      const md = container.querySelector('.markdown');
      expect(md?.textContent).toContain('Bob');
    });
  });

  it('edit → save fires writeMemory and updates the rendered content', async () => {
    clientStub.readMemory.mockResolvedValueOnce({ content: 'old body' });
    clientStub.writeMemory.mockResolvedValueOnce({
      ok: true,
      path: 'projects/alpha/notes.md'
    });

    const { findAllByTestId, findByRole, findByTestId, getByText, container } = render(MemoryPage);
    const cards = await findAllByTestId('memory-card');
    await fireEvent.click(cards[0]);
    // Wait for the markdown body to render once.
    await waitFor(() => {
      const md = container.querySelector('.markdown');
      expect(md?.textContent).toContain('old body');
    });

    // Click Edit.
    await fireEvent.click(await findByRole('button', { name: /edit memory/i }));

    // Body is now a textarea.
    const textarea = (await findByTestId('memory-edit-textarea')) as HTMLTextAreaElement;
    await fireEvent.input(textarea, { target: { value: 'new body' } });

    // Click Save.
    await fireEvent.click(getByText('Save'));

    await waitFor(() => {
      expect(clientStub.writeMemory).toHaveBeenCalledWith('projects/alpha/notes.md', 'new body');
    });

    // Back to render mode; markdown reflects the saved body.
    await waitFor(() => {
      const md = container.querySelector('.markdown');
      expect(md?.textContent).toContain('new body');
    });
  });

  it('delete with two-click confirm fires deleteMemory and removes the card', async () => {
    const { findAllByTestId, findByRole, queryAllByTestId } = render(MemoryPage);
    const cards = await findAllByTestId('memory-card');
    await fireEvent.click(cards[0]);

    // First click arms the button (label flips to "Confirm delete").
    const armBtn = await findByRole('button', { name: /^delete memory$/i });
    await fireEvent.click(armBtn);

    // Second click triggers the actual delete. We use `findByRole` so the
    // armed label can resolve asynchronously.
    const confirmBtn = await findByRole('button', { name: /confirm delete memory/i });
    await fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(clientStub.deleteMemory).toHaveBeenCalledWith('projects/alpha/notes.md');
    });

    // Card removed from the list.
    await waitFor(() => {
      const remaining = queryAllByTestId('memory-card');
      expect(remaining).toHaveLength(2);
      const paths = remaining.map((el) => el.textContent ?? '');
      expect(paths.some((p) => p.includes('projects/alpha/notes.md'))).toBe(false);
    });
  });

  it('refresh button re-fires getMemoryTree and reflects new server state', async () => {
    const { findAllByTestId, getByLabelText } = render(MemoryPage);
    await findAllByTestId('memory-card');
    expect(clientStub.getMemoryTree).toHaveBeenCalledTimes(1);

    // Server grew a new node since first load.
    clientStub.getMemoryTree.mockResolvedValueOnce([
      ...NODES,
      {
        path: 'fresh/entry.md',
        type: 'file' as const,
        updated_at: '2026-05-28T11:00:00Z'
      }
    ]);

    const refresh = getByLabelText(/refresh memory list/i);
    await fireEvent.click(refresh);

    await waitFor(() => {
      expect(clientStub.getMemoryTree).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      const cards = document.querySelectorAll('[data-testid="memory-card"]');
      expect(cards.length).toBe(4);
    });
  });

  it('new-memory submit fires writeMemory and prepends the new card', async () => {
    clientStub.writeMemory.mockResolvedValueOnce({
      ok: true,
      path: 'notes/observation.md'
    });
    // After writeMemory the route also re-selects via readMemory.
    clientStub.readMemory.mockResolvedValueOnce({ content: 'fresh note' });

    const { findAllByTestId, getByLabelText, findByTestId, queryAllByTestId } = render(MemoryPage);
    await findAllByTestId('memory-card');

    // Open the New-memory modal.
    await fireEvent.click(getByLabelText(/new memory entry/i));
    const modal = await findByTestId('new-memory-modal');
    expect(modal).toBeTruthy();

    // Fill in path + content, submit.
    const pathInput = modal.querySelector('#new-memory-path') as HTMLInputElement;
    const contentArea = modal.querySelector('#new-memory-content') as HTMLTextAreaElement;
    await fireEvent.input(pathInput, { target: { value: 'notes/observation.md' } });
    await fireEvent.input(contentArea, { target: { value: 'fresh note' } });

    const submit = modal.querySelector('button[type="submit"]') as HTMLButtonElement;
    await fireEvent.click(submit);

    await waitFor(() => {
      expect(clientStub.writeMemory).toHaveBeenCalledTimes(1);
      const [pathArg, bodyArg] = clientStub.writeMemory.mock.calls[0];
      expect(pathArg).toBe('notes/observation.md');
      expect(bodyArg).toContain('fresh note');
    });

    // The new card is at the top of the list (4 total now).
    await waitFor(() => {
      const cards = queryAllByTestId('memory-card');
      expect(cards.length).toBe(4);
      expect(cards[0].textContent).toContain('notes/observation.md');
    });
  });
});
