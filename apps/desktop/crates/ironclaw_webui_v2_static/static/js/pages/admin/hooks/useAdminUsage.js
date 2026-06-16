import { useQuery } from '@tanstack/react-query';
import { fetchUsageSummary, fetchUsage } from '../lib/admin-api.js';

export function useUsageSummary() {
  const query = useQuery({
    queryKey: ['admin', 'usage-summary'],
    queryFn: fetchUsageSummary,
    refetchInterval: 30_000
  });
  // `fetchUsageSummary` is a permanent stub (`admin-api.js` returns
  // `{ ...all-zero, todo: true }`) until the v2 admin endpoint lands. Surface
  // that as a readiness status so the dashboard can gate its live-looking
  // metrics tiles instead of polling hardcoded zeros ("No fake readiness").
  const todoStatus = query.data?.todo ? 'todo' : 'ready';
  return { ...query, todoStatus };
}

export function useUsage(period = 'day', userId) {
  return useQuery({
    queryKey: ['admin', 'usage', period, userId],
    queryFn: () => fetchUsage(period, userId),
    refetchInterval: 30_000
  });
}
