import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveProviderSnapshot } from './useLlmProviders.js';

test('deriveProviderSnapshot does not treat gateway diagnostics as active provider state', () => {
  const state = deriveProviderSnapshot({
    providers: [
      {
        id: 'nearai',
        description: 'multi-model access via NEAR account',
        adapter: 'nearai',
        default_model: 'auto',
        builtin: true,
        api_key_required: false,
        accepts_api_key: true,
        api_key_set: false
      }
    ],
    active: null
  });

  assert.equal(state.hasActiveProvider, false);
  assert.equal(state.activeProviderId, '');
  assert.equal(state.selectedModel, '');
  assert.equal(state.allProviders[0].name, 'multi-model access via NEAR account');
});

test('deriveProviderSnapshot hides non-NEAR providers and ignores non-NEAR active snapshots', () => {
  const state = deriveProviderSnapshot({
    providers: [
      {
        id: 'nearai',
        description: 'multi-model access via NEAR account',
        adapter: 'nearai',
        default_model: 'auto',
        builtin: true,
        api_key_set: false
      },
      {
        id: 'openrouter',
        description: 'OpenRouter',
        adapter: 'open_router',
        default_model: 'z-ai/glm-4.5',
        builtin: true,
        api_key_set: true
      }
    ],
    active: {
      provider_id: 'openrouter',
      model: 'z-ai/glm-4.5'
    }
  });

  assert.equal(state.hasActiveProvider, false);
  assert.equal(state.activeProviderId, '');
  assert.equal(state.selectedModel, '');
  assert.deepEqual(
    state.allProviders.map((provider) => provider.id),
    ['nearai']
  );
});

test('deriveProviderSnapshot accepts NEAR AI Cloud as the desktop active provider', () => {
  const state = deriveProviderSnapshot({
    providers: [
      {
        id: 'nearai',
        description: 'multi-model access via NEAR account',
        adapter: 'nearai',
        default_model: 'auto',
        builtin: true,
        api_key_set: true
      }
    ],
    active: {
      provider_id: 'nearai',
      model: 'glm-4.5'
    }
  });

  assert.equal(state.hasActiveProvider, true);
  assert.equal(state.activeProviderId, 'nearai');
  assert.equal(state.selectedModel, 'glm-4.5');
  assert.equal(state.allProviders[0].has_api_key, true);
});
