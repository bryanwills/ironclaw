// Guard for the Python "Run" execution gate (Codex audit P0). Assistant-authored
// Python runs on the user's machine, so the first click must only ARM a
// confirmation — execution requires a deliberate "Run anyway". inTauri() is
// mocked true so the runner path is reachable; the Tauri `invoke` is mocked and
// asserted on.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';

vi.mock('$lib/utils/runtime', () => ({ inTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => ({ stdout: 'ok', stderr: '', exit_code: 0, truncated: false }))
}));

import PythonBlock from './PythonBlock.svelte';
import { invoke } from '@tauri-apps/api/core';

beforeEach(() => {
  vi.mocked(invoke).mockClear();
});

describe('PythonBlock execution gate', () => {
  it('does not execute on the first Run click — it arms a confirmation', async () => {
    const { getByText, queryByText } = render(PythonBlock, { props: { code: 'print(1)' } });
    await fireEvent.click(getByText('Run'));
    expect(invoke).not.toHaveBeenCalled();
    expect(getByText('Run anyway')).toBeTruthy();
    expect(queryByText(/Runs code on your machine/)).toBeTruthy();
  });

  it('executes the snippet only after an explicit "Run anyway"', async () => {
    const { getByText } = render(PythonBlock, { props: { code: 'print(2)' } });
    await fireEvent.click(getByText('Run'));
    await fireEvent.click(getByText('Run anyway'));
    expect(invoke).toHaveBeenCalledWith('run_python_snippet', { code: 'print(2)' });
  });

  it('Cancel dismisses the confirmation without executing', async () => {
    const { getByText, queryByText } = render(PythonBlock, { props: { code: 'print(3)' } });
    await fireEvent.click(getByText('Run'));
    await fireEvent.click(getByText('Cancel'));
    expect(invoke).not.toHaveBeenCalled();
    expect(queryByText('Run anyway')).toBeNull();
    expect(getByText('Run')).toBeTruthy();
  });
});
