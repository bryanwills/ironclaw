// Stub for SvelteKit's `$app/navigation` under vitest. The component
// tree doesn't actually navigate during snapshot rendering; every
// caller's `void goto(...)` is a fire-and-forget. We expose no-op
// async functions so the wiring resolves cleanly.

export const goto = async (_url: string | URL, _opts?: Record<string, unknown>): Promise<void> =>
  undefined;

export const invalidate = async (_url?: string | URL): Promise<void> => undefined;
export const invalidateAll = async (): Promise<void> => undefined;
export const preloadData = async (_href: string): Promise<unknown> => null;
export const preloadCode = async (_pathname: string): Promise<void> => undefined;
export const pushState = (_url: string, _state?: unknown): void => undefined;
export const replaceState = (_url: string, _state?: unknown): void => undefined;
export const beforeNavigate = (_fn: () => unknown): void => undefined;
export const afterNavigate = (_fn: () => unknown): void => undefined;
export const onNavigate = (_fn: () => unknown): void => undefined;
export const disableScrollHandling = (): void => undefined;
export const goBack = async (): Promise<void> => undefined;
