import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generatedMissions } from './generated-missions.svelte';
import { connection } from './connection.svelte';
import { composerInsert } from './templates.svelte';
import { workItems } from './work-items.svelte';
import type { GeneratedMission } from '$lib/util/mission-generator';

function installLocalStorageShim() {
  const store = new Map<string, string>();
  const shim = {
    get length() {
      return store.size;
    },
    key(i: number) {
      return Array.from(store.keys())[i] ?? null;
    },
    getItem(k: string) {
      return store.has(k) ? (store.get(k) as string) : null;
    },
    setItem(k: string, v: string) {
      store.set(String(k), String(v));
    },
    removeItem(k: string) {
      store.delete(k);
    },
    clear() {
      store.clear();
    }
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: shim });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: shim });
  }
}

function mission(overrides: Partial<GeneratedMission> = {}): GeneratedMission {
  return {
    id: 'm1',
    title: 'Review the vendor contract',
    item: 'Inbox item',
    why: 'There are approval-sensitive terms.',
    mode: 'approval',
    run_instruction: 'Review the document and prepare red flags.',
    deliverable: 'Risk memo',
    domain: 'legal',
    domains: [],
    context: [
      {
        label: 'Document(s) to review',
        state: 'available',
        provenance: 'Inbox item'
      }
    ],
    risky_actions: [
      {
        action: 'Send markup',
        kind: 'send',
        payload: 'Send the markup to the counterparty.',
        reason: 'External message.'
      }
    ],
    expected_artifacts: [{ type: 'risk-memo', title: 'Risk memo', provenance: ['Inbox item'] }],
    watches: [],
    ...overrides
  };
}

function setClient(c: unknown): void {
  Object.defineProperty(connection, 'client', { configurable: true, get: () => c });
}

describe('generatedMissions.run', () => {
  beforeEach(() => {
    installLocalStorageShim();
    setClient(null);
    workItems.items = [];
    (workItems as unknown as { hydrated: boolean }).hydrated = false;
    generatedMissions.reset();
    composerInsert.consume();
  });

  it('creates a durable work product without inserting the mission into chat', async () => {
    const result = await generatedMissions.run(mission());

    expect(result).toMatchObject({
      status: 'created',
      title: 'Review the vendor contract',
      artifactTitle: 'Risk memo',
      draftStatus: 'planned'
    });
    expect(workItems.items).toHaveLength(1);
    expect(workItems.items[0].domain).toBe('legal');
    expect(workItems.items[0].runbookIds).toEqual(['legal']);
    expect(workItems.items[0].dossier.some((entry) => entry.state === 'available')).toBe(true);
    expect(workItems.items[0].approvalBoundaries.some((gate) => gate.kind === 'send')).toBe(true);
    expect(workItems.items[0].artifacts.some((artifact) => artifact.type === 'risk-memo')).toBe(
      true
    );
    expect(workItems.items[0].links.some((link) => link.kind === 'mission')).toBe(true);
    expect(composerInsert.consume()).toBeNull();
  });

  it('keeps unknown-domain work visible as a blocked work item instead of chat text', async () => {
    const result = await generatedMissions.run(mission({ domain: 'unknown', context: [] }));

    expect(result.status).toBe('created');
    expect(workItems.items).toHaveLength(1);
    expect(workItems.items[0].status).toBe('blocked');
    expect(workItems.items[0].domain).toBe('general');
    expect(workItems.items[0].nextAction).toContain('What domain should I route this through');
    expect(composerInsert.consume()).toBeNull();
  });

  it('does not draft blocked generated missions before routing is clarified', async () => {
    const createResponse = vi.fn(async () => '# Should not be called');
    setClient({ createResponse });

    const result = await generatedMissions.run(mission({ domain: 'unknown', context: [] }));

    expect(result.status).toBe('created');
    expect(createResponse).not.toHaveBeenCalled();
    expect(workItems.items[0].status).toBe('blocked');
    expect(workItems.items[0].artifacts[0]).toMatchObject({
      title: 'Risk memo',
      status: 'planned'
    });
    expect(workItems.items[0].artifacts[0].content).toBeUndefined();
    expect(workItems.items[0].approvalBoundaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'Send markup', status: 'pending' })
      ])
    );
  });

  it('creates a fallback artifact when model output omits deliverable and expected artifacts', async () => {
    const result = await generatedMissions.run(
      mission({
        deliverable: '',
        expected_artifacts: [],
        domain: 'unknown',
        risky_actions: []
      })
    );

    expect(result).toMatchObject({
      status: 'created',
      artifactTitle: 'Review the vendor contract work product'
    });
    expect(workItems.items[0].artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'work-product',
          title: 'Review the vendor contract work product',
          status: 'planned'
        })
      ])
    );
  });

  it('adds local approval risk even when the generated mission omits risky_actions', async () => {
    await generatedMissions.run(
      mission({
        title: 'Client update',
        mode: 'dry-run',
        domain: 'research',
        run_instruction: 'Draft an email reply and send the client update.',
        context: [
          {
            label: 'Topic or question',
            state: 'available',
            provenance: 'generated mission'
          }
        ],
        risky_actions: []
      })
    );

    expect(workItems.items).toHaveLength(1);
    expect(workItems.items[0].domain).toBe('research');
    expect(workItems.items[0].approvalBoundaries).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'send' })])
    );
    expect(workItems.items[0].status).toBe('waiting-approval');
  });

  it('drafts the primary artifact into Work when a gateway client is available', async () => {
    let resolveDraft: (value: string) => void = () => undefined;
    setClient({
      createResponse: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveDraft = resolve;
          })
      )
    });
    generatedMissions.lastContext = [
      {
        kind: 'email',
        label: 'Inbox item',
        body: 'The vendor sent an MSA with an uncapped customer liability clause.'
      }
    ];

    const result = await generatedMissions.run(mission());

    expect(result).toMatchObject({ status: 'created', draftStatus: 'planned' });
    expect(workItems.items[0].artifacts[0]).toMatchObject({
      title: 'Risk memo',
      status: 'planned'
    });
    resolveDraft(
      '# Risk memo\n\n## Summary\nThe customer liability cap needs review before countersignature.'
    );
    await vi.waitFor(() => {
      expect(workItems.items[0].nextAction).toBe('Review draft: Risk memo');
      expect(workItems.items[0].artifacts[0]).toMatchObject({
        title: 'Risk memo',
        status: 'draft',
        content: expect.stringContaining('customer liability cap')
      });
    });
    expect(composerInsert.consume()).toBeNull();
  });
});
