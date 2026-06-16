import { React } from '../../../lib/html.js';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchSettingsExport,
  importSettings as importSettingsPayload,
  updateSetting
} from '../lib/settings-api.js';
import { RESTART_REQUIRED_KEYS } from '../lib/settings-schema.js';

export function useSettings() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['settings-export'],
    queryFn: fetchSettingsExport,
    staleTime: 30_000
  });

  const settings = query.data?.settings || {};
  // No v2 settings-write endpoint exists yet: `fetchSettingsExport`/`updateSetting`
  // are stubs (`{ todo: true }` / `{ success: false }`). `status:'todo'` lets the
  // consuming tabs gate their write controls behind a real backend instead of
  // implying a capability the gateway cannot prove ("No fake readiness").
  const status = query.data?.todo ? 'todo' : 'ready';

  const [savedKeys, setSavedKeys] = React.useState({});
  const [needsRestart, setNeedsRestart] = React.useState(false);

  const mutation = useMutation({
    mutationFn: ({ key, value }) => updateSetting(key, value),
    onSuccess: (data, { key, value }) => {
      // The stub resolves the promise even though nothing persisted. Only treat a
      // write as saved when the gateway actually confirms it — otherwise the
      // "Saved" indicator and the restart banner would assert a change that never
      // reached the backend.
      if (data?.success === false || data?.todo) {
        return;
      }

      queryClient.setQueryData(['settings-export'], (old) => {
        if (!old) return old;
        const next = { ...old, settings: { ...old.settings } };
        if (value === null || value === undefined) {
          delete next.settings[key];
        } else {
          next.settings[key] = value;
        }
        return next;
      });

      setSavedKeys((prev) => ({ ...prev, [key]: true }));
      setTimeout(() => setSavedKeys((prev) => ({ ...prev, [key]: false })), 2000);

      if (RESTART_REQUIRED_KEYS.has(key)) {
        setNeedsRestart(true);
      }
    }
  });

  const save = React.useCallback((key, value) => mutation.mutate({ key, value }), [mutation]);

  const importMutation = useMutation({
    mutationFn: importSettingsPayload,
    onSuccess: (data, payload) => {
      if (data?.success === false || data?.todo) {
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['settings-export'] });
      const importedKeys = Object.keys(payload?.settings || {});
      if (importedKeys.some((key) => RESTART_REQUIRED_KEYS.has(key))) {
        setNeedsRestart(true);
      }
    }
  });

  const importSettings = React.useCallback(
    (payload) => importMutation.mutateAsync(payload),
    [importMutation]
  );

  return {
    settings,
    query,
    status,
    save,
    savedKeys,
    needsRestart,
    importSettings,
    isImporting: importMutation.isPending,
    saveError: mutation.error || importMutation.error
  };
}
