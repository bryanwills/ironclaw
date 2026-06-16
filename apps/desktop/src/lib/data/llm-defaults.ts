export const DEFAULT_NEARAI_MODEL = 'auto';

export function fallbackModelForProvider(providerId: string): string {
  if (providerId === 'nearai') return DEFAULT_NEARAI_MODEL;
  if (providerId === 'openrouter') return 'z-ai/glm-4.5';
  if (providerId === 'openai') return 'gpt-4o-mini';
  if (providerId === 'anthropic') return 'claude-3-5-sonnet-latest';
  return '';
}

export function effectiveDefaultModelForProvider(
  providerId: string,
  advertisedDefault?: string | null
): string {
  const clean = advertisedDefault?.trim();
  if (providerId === 'nearai' && (!clean || clean === 'auto')) return DEFAULT_NEARAI_MODEL;
  return clean || fallbackModelForProvider(providerId);
}
