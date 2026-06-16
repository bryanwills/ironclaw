import { React } from "../../../lib/html.js";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchUsers, createUser, updateUser } from "../lib/settings-api.js";

export function useUsers() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["admin-users"],
    queryFn: fetchUsers,
    retry: false,
  });

  const users = query.data?.users || [];
  // The v2 users endpoint is a stub (`fetchUsers` → { todo: true }, writes →
  // { success: false }). Surface that as a status so the tab shows the honest
  // not-writable state instead of an add-user form that silently no-ops.
  const status = query.data?.todo ? 'todo' : 'ready';
  const isForbidden = query.error?.message?.includes("403") || query.error?.message?.includes("Forbidden");

  const createMutation = useMutation({
    mutationFn: createUser,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }) => updateUser(id, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
  });

  return {
    users,
    query,
    status,
    isForbidden,
    createUser: createMutation.mutate,
    updateUser: (id, payload) => updateMutation.mutate({ id, payload }),
    createError: createMutation.error,
    isCreating: createMutation.isPending,
  };
}
