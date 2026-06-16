export const API_KEY_UNCHANGED = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
export const DESKTOP_PRIMARY_LLM_PROVIDER_ID = 'nearai';

export const ADAPTER_OPTIONS = [{ value: 'nearai', label: 'NEAR AI Cloud' }];

export function adapterLabel(adapter) {
  return ADAPTER_OPTIONS.find((item) => item.value === adapter)?.label || adapter;
}

export function parseCustomProviders(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

export function parseBuiltinOverrides(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

export function isDesktopVisibleLlmProvider(providerOrId) {
  const id = typeof providerOrId === 'string' ? providerOrId : providerOrId?.id;
  return String(id || '').toLowerCase() === DESKTOP_PRIMARY_LLM_PROVIDER_ID;
}

export function filterDesktopVisibleLlmProviders(providers) {
  if (!Array.isArray(providers)) return [];
  return providers.filter(isDesktopVisibleLlmProvider);
}

export function providerEffectiveBaseUrl(provider, overrides) {
  const override = provider.builtin ? overrides[provider.id] || {} : {};
  return override.base_url || provider.env_base_url || provider.base_url || '';
}

export function providerDisplayModel(provider, overrides, activeId, selectedModel) {
  const override = provider.builtin ? overrides[provider.id] || {} : {};
  if (provider.id === activeId) {
    return selectedModel || override.model || provider.env_model || provider.default_model || '';
  }
  return override.model || provider.env_model || provider.default_model || '';
}

function modelDisplaySegment(segment) {
  const value = String(segment || '').trim();
  if (!value) return '';
  const lower = value.toLowerCase();
  const acronym = {
    ai: 'AI',
    api: 'API',
    fp8: 'FP8',
    glm: 'GLM',
    gpt: 'GPT',
    llm: 'LLM',
    oss: 'OSS',
    tee: 'TEE',
    vl: 'VL'
  }[lower];
  if (acronym) return acronym;
  if (/^\d+(?:\.\d+)?[a-z]$/i.test(value)) {
    return value.replace(/[a-z]$/i, (match) => match.toUpperCase());
  }
  if (/^\d/.test(value)) return value.toUpperCase();
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function modelDisplayName(model) {
  const raw = String(model || '').trim();
  if (!raw) return '';
  if (raw.toLowerCase() === 'auto') return 'Auto';

  // Derive a readable label from the bare model id the gateway returns: drop
  // the vendor prefix, space the separators, preserve version dots. The
  // catalog carries no display-name field, so format the id rather than
  // collapsing every entry into one generic tier label — the picker has to let
  // the user distinguish the individual models NEAR AI Cloud routes to.
  const token =
    raw
      .split(/[/:]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .at(-1) || raw;
  // A trailing "major-minor" version written with a dash reads better as a
  // dot; only collapse two digits AT THE END so a trailing size/precision tag
  // keeps its structure.
  const normalized = token.replace(/(\d+)-(\d+)$/, '$1.$2');
  return normalized
    .replace(/\.(?=\d)/g, 'DOTMARK')
    .split(/[\s._-]+/)
    .map((part) => modelDisplaySegment(part.replace(/DOTMARK/g, '.')))
    .filter(Boolean)
    .join(' ');
}

export function providerDefaultModel(provider, overrides) {
  const override = provider.builtin ? overrides[provider.id] || {} : {};
  return override.model || provider.env_model || provider.default_model || '';
}

export function providerAcceptsApiKey(provider) {
  if (!provider) return false;
  if (!provider.builtin) return provider.adapter !== 'ollama';
  if (provider.accepts_api_key !== undefined) return provider.accepts_api_key !== false;
  return provider.api_key_required !== false;
}

export function isProviderConfigured(provider, overrides) {
  if (provider?.synthetic_unavailable) return false;
  const override = provider.builtin ? overrides[provider.id] || {} : {};
  const needsKey = provider.builtin
    ? provider.api_key_required !== false
    : provider.adapter !== 'ollama';
  const storedKey = provider.builtin ? override.api_key : provider.api_key;
  const hasDbKey =
    storedKey === API_KEY_UNCHANGED || (typeof storedKey === 'string' && storedKey.length > 0);
  const keyOk = !needsKey || provider.has_api_key === true || hasDbKey;
  if (!keyOk) return false;

  const needsBaseUrl = provider.builtin ? provider.base_url_required === true : true;
  if (!needsBaseUrl) return true;
  return providerEffectiveBaseUrl(provider, overrides).trim().length > 0;
}

export function providerStatus(provider, overrides, activeProviderId) {
  if (provider.id === activeProviderId) return 'active';
  return isProviderConfigured(provider, overrides) ? 'ready' : 'setup';
}

export function groupProvidersByStatus(providers, overrides, activeProviderId) {
  const buckets = { active: [], ready: [], setup: [] };
  if (!Array.isArray(providers)) return buckets;
  for (const provider of providers) {
    const status = providerStatus(provider, overrides, activeProviderId);
    if (buckets[status]) buckets[status].push(provider);
  }
  return buckets;
}

export function providerMissingReason(provider, overrides) {
  if (provider?.synthetic_unavailable) return 'gateway';
  const override = provider.builtin ? overrides[provider.id] || {} : {};
  const needsKey = provider.builtin
    ? provider.api_key_required !== false
    : provider.adapter !== 'ollama';
  const storedKey = provider.builtin ? override.api_key : provider.api_key;
  const hasDbKey =
    storedKey === API_KEY_UNCHANGED || (typeof storedKey === 'string' && storedKey.length > 0);
  if (needsKey && provider.has_api_key !== true && !hasDbKey) return 'api_key';

  const needsBaseUrl = provider.builtin ? provider.base_url_required === true : true;
  if (needsBaseUrl && !providerEffectiveBaseUrl(provider, overrides).trim()) return 'base_url';
  return 'ok';
}

export function providerPayload(provider, form, apiKey, overrides) {
  const baseUrl = form.baseUrl.trim();
  const model = form.model.trim();
  const payload = {
    adapter: provider?.builtin ? provider.adapter : form.adapter,
    base_url: baseUrl || provider?.base_url || '',
    provider_id: provider?.id || form.id.trim(),
    provider_type: provider?.builtin ? 'builtin' : 'custom'
  };
  if (model) payload.model = model;
  if (apiKey.trim()) payload.api_key = apiKey.trim();

  const override = provider?.builtin ? overrides[provider.id] || {} : {};
  if (!payload.api_key && override.api_key === API_KEY_UNCHANGED) {
    payload.api_key = undefined;
  }
  return payload;
}

export function providerIdFromName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function isValidProviderId(id) {
  return /^[a-z0-9_-]+$/.test(id);
}
