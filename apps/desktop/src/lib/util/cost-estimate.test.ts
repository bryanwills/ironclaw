import { describe, expect, it } from 'vitest';

import { estimateCost, formatUsd, MODEL_PRICES, priceForModel } from './cost-estimate';

describe('cost-estimate util', () => {
  it('matches a vendor-stripped deepseek model by longest known prefix', () => {
    expect(priceForModel('deepseek/deepseek-chat-v3-0324')).toBe(MODEL_PRICES['deepseek-chat']);
    expect(priceForModel('deepseek/deepseek-chat-v3-0324')).not.toBe(MODEL_PRICES.default);
  });

  it('returns the default price for unknown models', () => {
    expect(priceForModel('totally-unknown')).toBe(MODEL_PRICES.default);
  });

  it('prefers the longest matching prefix', () => {
    expect(priceForModel('openai/gpt-4o-mini-2024-07-18')).toBe(MODEL_PRICES['gpt-4o-mini']);
  });

  it('estimates cost linearly from prompt and completion tokens', () => {
    const single = estimateCost('gpt-4o', 1_000, 2_000);
    const doubled = estimateCost('gpt-4o', 2_000, 4_000);

    expect(doubled).toBeCloseTo(single * 2);
  });

  it('treats negative and NaN token counts as zero', () => {
    expect(estimateCost('gpt-4o', -1_000, Number.NaN)).toBe(0);
    expect(estimateCost('gpt-4o', -1_000, 1_000)).toBeCloseTo(
      MODEL_PRICES['gpt-4o'].completionPerM / 1_000
    );
  });

  it('formats small USD amounts with four decimals', () => {
    expect(formatUsd(0.0003)).toBe('$0.0003');
  });

  it('formats regular USD amounts with two decimals', () => {
    expect(formatUsd(1.5)).toBe('$1.50');
  });
});
