export interface ModelPrice {
  /** USD per 1,000,000 prompt (input) tokens. */
  promptPerM: number;
  /** USD per 1,000,000 completion (output) tokens. */
  completionPerM: number;
}

/** Built-in approximate USD prices per 1,000,000 tokens. */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'deepseek-chat': { promptPerM: 0.27, completionPerM: 1.1 },
  'deepseek-v3': { promptPerM: 0.27, completionPerM: 1.1 },
  'deepseek-v4-pro': { promptPerM: 1.0, completionPerM: 3.0 },
  'kimi-k2': { promptPerM: 0.6, completionPerM: 2.5 },
  'gpt-4o': { promptPerM: 2.5, completionPerM: 10.0 },
  'gpt-4o-mini': { promptPerM: 0.15, completionPerM: 0.6 },
  'claude-3.5-sonnet': { promptPerM: 3.0, completionPerM: 15.0 },
  'claude-3-5-sonnet': { promptPerM: 3.0, completionPerM: 15.0 },
  'claude-3.7': { promptPerM: 3.0, completionPerM: 15.0 },
  'claude-3-7': { promptPerM: 3.0, completionPerM: 15.0 },
  'claude-3-opus': { promptPerM: 15.0, completionPerM: 75.0 },
  'claude-opus': { promptPerM: 15.0, completionPerM: 75.0 },
  opus: { promptPerM: 15.0, completionPerM: 75.0 },
  default: { promptPerM: 5.0, completionPerM: 15.0 }
};

function normalizeModelId(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  const slashIndex = normalized.indexOf('/');

  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function billableTokens(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens < 0) {
    return 0;
  }

  return tokens;
}

/** Look up a price by raw model id. Never throws. */
export function priceForModel(modelId: string): ModelPrice {
  const normalized = normalizeModelId(modelId);
  const [match] = Object.keys(MODEL_PRICES)
    .filter((key) => key !== 'default' && normalized.startsWith(key))
    .sort((left, right) => right.length - left.length);

  return match === undefined ? MODEL_PRICES.default : MODEL_PRICES[match];
}

/** USD cost for a single call. Negative/NaN token counts are treated as 0. */
export function estimateCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number
): number {
  const price = priceForModel(modelId);

  return (
    (billableTokens(promptTokens) * price.promptPerM +
      billableTokens(completionTokens) * price.completionPerM) /
    1_000_000
  );
}

/** Format a USD amount with small values kept visible. */
export function formatUsd(amount: number): string {
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  const fractionDigits = Math.abs(safeAmount) < 0.01 ? 4 : 2;

  return `$${safeAmount.toFixed(fractionDigits)}`;
}
