import { describe, expect, it } from 'vitest';

import { isModelExecutionVerified, modelExecutionReadiness } from './model-readiness';

describe('modelExecutionReadiness', () => {
  it('allows configured models to run the first execution probe', () => {
    const status = {
      llm_backend: 'NEAR.AI',
      llm_model: 'z-ai/glm-4.5',
      model_readiness: 'unverified'
    };

    expect(isModelExecutionVerified(status)).toBe(false);
    expect(modelExecutionReadiness(status)).toEqual(
      expect.objectContaining({
        verified: false,
        sendBlocked: false,
        buttonPrefix: 'Unverified',
        sendBlockReason: ''
      })
    );
  });

  it('accepts explicit execution verification', () => {
    expect(isModelExecutionVerified({ model_execution_verified: true })).toBe(true);
    expect(modelExecutionReadiness({ model_execution_verified: true }).sendBlocked).toBe(false);
  });

  it('accepts nested GREEN readiness fields', () => {
    expect(
      isModelExecutionVerified({
        readiness: { model_execution_readiness: 'GREEN' }
      })
    ).toBe(true);
  });

  it('does not accept configured-only readiness text', () => {
    expect(isModelExecutionVerified({ model_execution_readiness: 'configured' })).toBe(false);
  });

  it('blocks only when the backend reports actionable model setup failures', () => {
    const readiness = modelExecutionReadiness({
      model_execution_verified: false,
      model_readiness: 'unverified',
      model_readiness_reason:
        'NEAR.AI is selected, but no NEARAI_SESSION_TOKEN, NEARAI_API_KEY, or vaulted nearai credential is available.'
    });

    expect(readiness.sendBlocked).toBe(true);
    expect(readiness.description).toContain('NEARAI_SESSION_TOKEN');
    expect(readiness.sendBlockReason).toContain('vaulted nearai credential');
  });

  it('allows the generic first-run verification reason', () => {
    const readiness = modelExecutionReadiness({
      model_execution_verified: false,
      model_readiness: 'unverified',
      model_readiness_reason:
        'Gateway status reports configured provider/model only; execution is verified by a successful WebChat run.'
    });

    expect(readiness.sendBlocked).toBe(false);
    expect(readiness.sendBlockReason).toBe('');
    expect(readiness.description).toContain('first successful chat run');
  });
});
