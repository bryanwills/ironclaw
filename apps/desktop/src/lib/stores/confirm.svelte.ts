export type ConfirmTone = 'default' | 'danger';

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

class ConfirmDialogStore {
  open = $state(false);
  title = $state('');
  body = $state('');
  confirmLabel = $state('Confirm');
  cancelLabel = $state('Cancel');
  tone = $state<ConfirmTone>('danger');

  #resolve: ((value: boolean) => void) | null = null;
  #invoker: HTMLElement | null = null;

  ask(opts: ConfirmOptions): Promise<boolean> {
    if (this.#resolve) {
      this.cancel();
    }

    this.#invoker =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    this.title = opts.title;
    this.body = opts.body;
    this.confirmLabel = opts.confirmLabel ?? 'Confirm';
    this.cancelLabel = opts.cancelLabel ?? 'Cancel';
    this.tone = opts.tone ?? 'danger';
    this.open = true;

    return new Promise<boolean>((resolve) => {
      this.#resolve = resolve;
    });
  }

  accept(): void {
    this.#close(true);
  }

  cancel(): void {
    this.#close(false);
  }

  #close(value: boolean): void {
    if (!this.open && !this.#resolve) return;

    const resolve = this.#resolve;
    const invoker = this.#invoker;
    this.#resolve = null;
    this.#invoker = null;
    this.open = false;
    resolve?.(value);

    if (typeof queueMicrotask !== 'function') return;
    queueMicrotask(() => {
      if (invoker?.isConnected) {
        invoker.focus();
      }
    });
  }
}

export const confirmDialog = new ConfirmDialogStore();
