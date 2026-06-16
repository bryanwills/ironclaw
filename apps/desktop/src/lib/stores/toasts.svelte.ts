// Lightweight rune-based toast singleton, shared across surfaces.
//
// Mounted once via `$lib/components/Toasts.svelte` in the root layout
// (`src/routes/+layout.svelte`). Call `toasts.show(message, kind)` from
// any route to surface a transient notification. Auto-dismiss after
// AUTO_DISMISS_MS unless dismissed manually.

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

const AUTO_DISMISS_MS = 3500;

class ToastStore {
  toasts = $state<Toast[]>([]);
  private nextId = 1;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  show(message: string, kind: ToastKind = 'info'): number {
    const id = this.nextId++;
    this.toasts = [...this.toasts, { id, message, kind }];
    const timer = setTimeout(() => this.dismiss(id), AUTO_DISMISS_MS);
    this.timers.set(id, timer);
    return id;
  }

  dismiss(id: number) {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  /** Clear all queued toasts; useful for component teardown. */
  clear() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.toasts = [];
  }
}

export const toasts = new ToastStore();
