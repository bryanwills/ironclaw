import { describe, expect, it } from 'vitest';

import { FIRST_RUN_MISSIONS, missionById, recommendMissions, type Mission } from './missions';
import {
  connectorPackById,
  type ConnectorPackId,
  type ConnectorPackStatus
} from './connector-packs';

const WRITE_CAPABLE_MISSION_IDS = new Set([
  'inbox-triage',
  'meeting-prep',
  'follow-up-catcher',
  'draft-replies',
  'update-notion-crm'
]);

const CONNECTED_STATUSES: Record<ConnectorPackId, ConnectorPackStatus> = {
  google: 'connected',
  notion: 'connected',
  slack: 'connected'
};

const DISCONNECTED_STATUSES: Record<ConnectorPackId, ConnectorPackStatus> = {
  google: 'not-installed',
  notion: 'not-installed',
  slack: 'not-installed'
};

describe('first-run missions', () => {
  it('has unique ids', () => {
    const ids = FIRST_RUN_MISSIONS.map((mission) => mission.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('defines each mission with a non-empty title and prompt', () => {
    expect(FIRST_RUN_MISSIONS.length).toBeGreaterThanOrEqual(6);

    for (const mission of FIRST_RUN_MISSIONS) {
      expect(mission.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(mission.title.trim().length).toBeGreaterThan(0);
      expect(mission.prompt.trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps send/write-capable missions in approval mode', () => {
    for (const mission of FIRST_RUN_MISSIONS) {
      expect(mission.mode).toBe('approval');

      if (WRITE_CAPABLE_MISSION_IDS.has(mission.id)) {
        expect(mission.mode).toBe('approval');
        expect(mission.prompt.toLowerCase()).toContain('approval');
      }
    }
  });

  it('references known connector packs when missions require workspace context', () => {
    expect(missionById('morning-brief')?.required_connectors).toEqual(['google']);
    expect(missionById('inbox-triage')?.required_connectors).toEqual(['google']);
    expect(missionById('draft-replies')?.required_connectors).toEqual(['google']);
    expect(missionById('update-notion-crm')?.required_connectors).toEqual(['notion']);
    expect(missionById('slack-catchup')?.required_connectors).toEqual(['slack']);

    for (const mission of FIRST_RUN_MISSIONS) {
      for (const connector of mission.required_connectors ?? []) {
        expect(connectorPackById(connector)).toBeTruthy();
      }
    }
  });

  it('keeps email and Slack triage missions scoped to the connectors they require', () => {
    const inboxTriage = missionById('inbox-triage');
    const slackCatchup = missionById('slack-catchup');

    expect(inboxTriage?.description.toLowerCase()).not.toContain('slack');
    expect(inboxTriage?.prompt.toLowerCase()).not.toContain('slack');
    expect(slackCatchup?.required_connectors).toEqual(['slack']);
  });

  it('looks up missions by id', () => {
    expect(missionById('morning-brief')?.title).toBe('Morning Brief');
    expect(missionById('not-a-mission')).toBeUndefined();
  });

  it('includes connectorless legal utility missions in approval mode', () => {
    for (const id of ['contract-review', 'draft-from-notes']) {
      const mission = missionById(id);
      expect(mission).toBeTruthy();
      expect(mission?.mode).toBe('approval');
      expect(mission?.required_connectors ?? []).toEqual([]);
      // First-pass review/draft to prepare for counsel — never positioned as legal advice.
      expect(mission?.prompt.toLowerCase()).toContain('not legal advice');
    }
  });
});

describe('recommendMissions', () => {
  it('recommends missions when all required connectors are ready', () => {
    const recommended = recommendMissions(FIRST_RUN_MISSIONS, CONNECTED_STATUSES, 8);

    expect(recommended.map((mission) => mission.id)).toContain('morning-brief');
    expect(recommended.map((mission) => mission.id)).toContain('slack-catchup');
    expect(recommended.map((mission) => mission.id)).toContain('update-notion-crm');
  });

  it('does not recommend a mission when a required connector is not ready', () => {
    const recommended = recommendMissions(
      FIRST_RUN_MISSIONS,
      { ...CONNECTED_STATUSES, google: 'needs-auth' },
      8
    );

    expect(recommended.map((mission) => mission.id)).not.toContain('morning-brief');
    expect(recommended.map((mission) => mission.id)).toContain('slack-catchup');
  });

  it('returns only connectorless missions when no connectors are ready', () => {
    const ids = recommendMissions(FIRST_RUN_MISSIONS, DISCONNECTED_STATUSES, 8).map((m) => m.id);
    // Connectorless utility missions stay eligible (they need no workspace);
    // connector-gated missions drop out when their packs are not ready.
    expect(ids).toContain('contract-review');
    expect(ids).toContain('draft-from-notes');
    expect(ids).not.toContain('morning-brief');
    expect(ids).not.toContain('slack-catchup');
  });

  it('keeps connectorless missions eligible', () => {
    const localMission: Mission = {
      id: 'local-mission',
      title: 'Local Mission',
      description: 'Uses only local context.',
      prompt: 'Summarize local context.',
      mode: 'dry-run'
    };

    expect(recommendMissions([localMission], DISCONNECTED_STATUSES, 8)).toEqual([localMission]);
  });

  it('uses deterministic time-of-day scoring before declaration order', () => {
    expect(recommendMissions(FIRST_RUN_MISSIONS, CONNECTED_STATUSES, 8)[0]?.id).toBe(
      'morning-brief'
    );
    expect(recommendMissions(FIRST_RUN_MISSIONS, CONNECTED_STATUSES, 12)[0]?.id).toBe(
      'inbox-triage'
    );
  });
});
