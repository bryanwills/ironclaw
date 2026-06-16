import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchSkills,
  installSkill as installSkillRequest,
  removeSkill as removeSkillRequest
} from '../lib/settings-api.js';

export function useSkills() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['skills'],
    queryFn: fetchSkills
  });

  const installMutation = useMutation({
    mutationFn: installSkillRequest,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skills'] });
    }
  });

  const removeMutation = useMutation({
    mutationFn: removeSkillRequest,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skills'] });
    }
  });

  const skills = query.data?.skills || [];
  // No v2 skills endpoint exists yet: `fetchSkills` returns `{ todo: true }` and
  // `installSkill`/`removeSkill` are `{ success: false }` stubs. `status:'todo'`
  // lets the tab gate the import form behind a real backend so users never
  // submit an install that silently no-ops ("No fake readiness").
  const status = query.data?.todo ? 'todo' : 'ready';

  return {
    skills,
    query,
    status,
    installSkill: installMutation.mutateAsync,
    removeSkill: removeMutation.mutateAsync,
    isInstalling: installMutation.isPending,
    isRemoving: removeMutation.isPending
  };
}
