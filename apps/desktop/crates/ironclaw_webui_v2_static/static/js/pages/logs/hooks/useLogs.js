import { React } from '../../../lib/html.js';

// TODO: requires v2 log-streaming endpoint. The v2 ingress only
// exposes per-thread event streams; system-wide log tail is not in
// the #3815 contract. Hook returns empty/static so the Logs page
// renders an empty list without hitting any v1 path.
export function useLogs() {
  const [levelFilter, setLevelFilter] = React.useState('all');
  const [targetFilter, setTargetFilter] = React.useState('');
  const [paused, setPaused] = React.useState(false);
  const [autoScroll, setAutoScroll] = React.useState(true);

  const changeServerLevel = React.useCallback(async (_next) => {
    // Local-only until a v2 system log endpoint exists.
  }, []);

  return {
    entries: [],
    totalCount: 0,
    paused,
    togglePause: () => setPaused((value) => !value),
    clearEntries: () => {},
    levelFilter,
    setLevelFilter,
    targetFilter,
    setTargetFilter,
    autoScroll,
    setAutoScroll,
    serverLevel: null,
    changeServerLevel,
    status: 'todo',
    isLoading: false
  };
}
