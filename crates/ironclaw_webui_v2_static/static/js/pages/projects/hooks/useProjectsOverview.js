import { useQuery, useQueryClient } from '@tanstack/react-query';
import { React } from '../../../lib/html.js';
import { fetchProjectsOverview } from '../lib/projects-api.js';

export function useProjectsOverview() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['projects-overview'],
    queryFn: fetchProjectsOverview,
    refetchInterval: 5000
  });

  const invalidate = React.useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['projects-overview'] });
  }, [queryClient]);

  return {
    overview: query.data || { attention: [], projects: [] },
    // No v2 projects endpoint exists yet: `fetchProjectsOverview` is a stub
    // (`{ projects: [], todo: true }`). `status:'todo'` lets the page suppress
    // the live-looking metrics summary strip instead of presenting hardcoded
    // zeros as a real, polling dashboard ("No fake readiness").
    status: query.data?.todo ? 'todo' : 'ready',
    isLoading: query.isLoading,
    isRefreshing: query.isFetching,
    error: query.error || null,
    invalidate
  };
}
