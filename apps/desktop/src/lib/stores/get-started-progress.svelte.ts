export interface GetStartedProgressSnapshot {
  connectedPackIds: string[];
  launchedMissionIds: string[];
  collapsed: boolean;
}

const DEFAULT_PROGRESS: GetStartedProgressSnapshot = {
  connectedPackIds: [],
  launchedMissionIds: [],
  collapsed: false
};

function storageKey(profileId: string): string {
  return `ironclaw-get-started:${profileId}`;
}

function coerceStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function coerceProgress(value: unknown): GetStartedProgressSnapshot {
  if (!value || typeof value !== 'object') return { ...DEFAULT_PROGRESS };
  const record = value as Record<string, unknown>;
  return {
    connectedPackIds: coerceStringList(record.connectedPackIds),
    launchedMissionIds: coerceStringList(record.launchedMissionIds),
    collapsed: record.collapsed === true
  };
}

class GetStartedProgressStore {
  profileId = $state<string>('default');
  snapshot = $state<GetStartedProgressSnapshot>({ ...DEFAULT_PROGRESS });

  bindProfile(profileId: string | null | undefined): void {
    const nextProfileId = profileId?.trim() || 'default';
    if (this.profileId === nextProfileId) return;
    this.profileId = nextProfileId;
    this.snapshot = this.read(nextProfileId);
  }

  hydrate(profileId: string | null | undefined): void {
    const nextProfileId = profileId?.trim() || 'default';
    this.profileId = nextProfileId;
    this.snapshot = this.read(nextProfileId);
  }

  markPackConnected(packId: string): void {
    if (this.snapshot.connectedPackIds.includes(packId)) return;
    this.set({
      ...this.snapshot,
      connectedPackIds: [...this.snapshot.connectedPackIds, packId]
    });
  }

  markMissionLaunched(missionId: string): void {
    if (this.snapshot.launchedMissionIds.includes(missionId)) return;
    this.set({
      ...this.snapshot,
      launchedMissionIds: [...this.snapshot.launchedMissionIds, missionId]
    });
  }

  setCollapsed(collapsed: boolean): void {
    if (this.snapshot.collapsed === collapsed) return;
    this.set({ ...this.snapshot, collapsed });
  }

  private set(next: GetStartedProgressSnapshot): void {
    this.snapshot = next;
    this.write(this.profileId, next);
  }

  private read(profileId: string): GetStartedProgressSnapshot {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
      return { ...DEFAULT_PROGRESS };
    }
    try {
      const raw = window.localStorage.getItem(storageKey(profileId));
      if (!raw) return { ...DEFAULT_PROGRESS };
      return coerceProgress(JSON.parse(raw) as unknown);
    } catch {
      return { ...DEFAULT_PROGRESS };
    }
  }

  private write(profileId: string, snapshot: GetStartedProgressSnapshot): void {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
    try {
      window.localStorage.setItem(storageKey(profileId), JSON.stringify(snapshot));
    } catch {
      // Progress is a convenience; storage failures should not block setup.
    }
  }
}

export const getStartedProgress = new GetStartedProgressStore();
