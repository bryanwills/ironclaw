// Render smoke tests for ReplayBar.svelte (R58 — time-travel replay bar).
// Props (threadId / onClose); reads the replay store for events/cursor/
// playing and calls play/pause/scrubTo/setSpeed. We pass threadId explicitly
// and spy the replay singleton's methods (importing a sibling store is fine).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/svelte';
import { tick } from 'svelte';

import ReplayBar from './ReplayBar.svelte';
import { replay } from '$lib/stores/replay.svelte';

function evs(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'content_delta',
    ts: `2026-05-29T10:0${i}:00Z`
  }));
}

beforeEach(() => {
  vi.spyOn(replay, 'events').mockReturnValue([] as never);
  vi.spyOn(replay, 'cursor').mockReturnValue(0);
  vi.spyOn(replay, 'isPlaying').mockReturnValue(false);
  vi.spyOn(replay, 'play').mockImplementation(() => {});
  vi.spyOn(replay, 'pause').mockImplementation(() => {});
  vi.spyOn(replay, 'scrubTo').mockImplementation(() => {});
  vi.spyOn(replay, 'setSpeed').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

function setReplay(events: number, cursor: number, playing = false): void {
  vi.mocked(replay.events).mockReturnValue(evs(events) as never);
  vi.mocked(replay.cursor).mockReturnValue(cursor);
  vi.mocked(replay.isPlaying).mockReturnValue(playing);
}

describe('ReplayBar component', () => {
  it('renders nothing when the thread has no replay events', async () => {
    setReplay(0, 0);
    const { container } = render(ReplayBar, { props: { threadId: 't1' } });
    await tick();
    expect(container.querySelector('[role="region"]')).toBeNull();
  });

  it('renders the controls + position when there are events', async () => {
    setReplay(2, 1);
    const { container } = render(ReplayBar, { props: { threadId: 't1' } });
    await tick();
    expect(container.querySelector('[aria-label="Time-travel replay controls"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Play replay"]')).toBeTruthy();
    expect(container.textContent).toContain('1 / 2');
    const range = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(range.getAttribute('aria-valuenow')).toBe('1');
    expect(range.getAttribute('aria-valuemax')).toBe('2');
  });

  it('toggles play/pause through the store', async () => {
    setReplay(2, 1, false);
    const { container } = render(ReplayBar, { props: { threadId: 't1' } });
    await tick();
    await act(async () => {
      await fireEvent.click(container.querySelector('button[aria-label="Play replay"]')!);
    });
    expect(replay.play).toHaveBeenCalledWith('t1');
  });

  it('shows the pause control while playing', async () => {
    setReplay(2, 1, true);
    const { container } = render(ReplayBar, { props: { threadId: 't1' } });
    await tick();
    const pause = container.querySelector('button[aria-label="Pause replay"]')!;
    expect(pause).toBeTruthy();
    await act(async () => {
      await fireEvent.click(pause);
    });
    expect(replay.pause).toHaveBeenCalledWith('t1');
  });

  it('scrubbing calls scrubTo with the new index', async () => {
    setReplay(3, 2);
    const { container } = render(ReplayBar, { props: { threadId: 't1' } });
    await tick();
    const range = container.querySelector('input[type="range"]') as HTMLInputElement;
    await act(async () => {
      await fireEvent.input(range, { target: { value: '0' } });
    });
    expect(replay.scrubTo).toHaveBeenCalledWith('t1', 0);
  });

  it('a speed button sets the playback speed', async () => {
    setReplay(2, 1);
    const { container } = render(ReplayBar, { props: { threadId: 't1' } });
    await tick();
    await act(async () => {
      await fireEvent.click(
        container.querySelector('button[aria-label="Set playback speed to 2x"]')!
      );
    });
    expect(replay.setSpeed).toHaveBeenCalledWith(2);
  });

  it('shows "Live" only when not at the end, and jumps to live', async () => {
    setReplay(3, 1); // cursor 1 of 3 → not live
    const { container } = render(ReplayBar, { props: { threadId: 't1' } });
    await tick();
    const live = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Live')
    )!;
    expect(live).toBeTruthy();
    await act(async () => {
      await fireEvent.click(live);
    });
    expect(replay.scrubTo).toHaveBeenCalledWith('t1', 3);
  });

  it('hides "Live" when the cursor is at the end', async () => {
    setReplay(3, 3); // cursor === total → live
    const { container } = render(ReplayBar, { props: { threadId: 't1' } });
    await tick();
    const live = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Live')
    );
    expect(live).toBeUndefined();
  });

  it('the close button fires onClose', async () => {
    setReplay(2, 1);
    const onClose = vi.fn();
    const { container } = render(ReplayBar, { props: { threadId: 't1', onClose } });
    await tick();
    await act(async () => {
      await fireEvent.click(container.querySelector('button[aria-label="Close replay"]')!);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
