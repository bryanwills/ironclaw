// v2 gate normalization. Source shapes come from
// `WebChatV2Event::Gate { prompt: GatePromptView }` and
// `WebChatV2Event::AuthRequired { prompt: AuthPromptView }`. The
// browser must hold `run_id` + `gate_ref` so a follow-up
// `resolve_gate` call can fill them into the v2 path params.
export function gateFromEvent(eventType, prompt) {
  if (!prompt) return null;

  if (eventType === 'gate') {
    const context = approvalContext(prompt);
    const contextParameters = approvalContextParameters(context);
    const promptParameters =
      prompt.parameters === undefined || prompt.parameters === null || prompt.parameters === ''
        ? contextParameters
        : prompt.parameters;
    return {
      kind: 'gate',
      requestId: prompt.request_id || prompt.gate_ref || null,
      runId: prompt.turn_run_id,
      gateRef: prompt.gate_ref,
      headline: prompt.headline,
      body: prompt.body,
      toolName:
        prompt.tool_name || prompt.toolName || context?.tool_name || context?.toolName || '',
      description: prompt.description || context?.reason || prompt.body || '',
      parameters: formatGateParameters(promptParameters),
      allowAlways: Boolean(prompt.allow_always ?? prompt.allowAlways)
    };
  }

  if (eventType === 'auth_required') {
    return {
      kind: 'auth_required',
      // Legacy auth_required prompts predate challenge_kind and are manual
      // token prompts. Explicit unknown/other challenge kinds still route to
      // the neutral auth card in chat.js.
      challengeKind: prompt.challenge_kind || 'manual_token',
      runId: prompt.turn_run_id,
      // AuthPromptView carries `auth_request_ref`, but v2's resolve
      // path is `/runs/{run_id}/gates/{gate_ref}/resolve` — auth
      // prompts therefore round-trip through the same gate_ref slot.
      gateRef: prompt.auth_request_ref,
      // Falls back to null when unpopulated; components render a generic
      // label rather than a misleading provider name.
      provider: prompt.provider || null,
      // Falls back to empty string so auth-token-card subtitle is hidden
      // when not set; card falls back to provider label if non-null.
      accountLabel: prompt.account_label || '',
      // Only present for oauth_url challenges:
      authorizationUrl: prompt.authorization_url || null,
      expiresAt: prompt.expires_at || null,
      headline: prompt.headline,
      body: prompt.body
    };
  }

  return null;
}

export function gateFromProjection(activeRunId, gate) {
  if (!activeRunId || !gate) return null;
  return {
    kind: 'gate',
    requestId: gate.request_id || gate.gate_ref || null,
    runId: activeRunId,
    gateRef: gate.gate_ref,
    headline: gate.headline || '',
    body: gate.body || '',
    toolName: gate.tool_name || gate.toolName || '',
    description: gate.description || gate.body || '',
    parameters: formatGateParameters(gate.parameters),
    allowAlways: Boolean(gate.allow_always ?? gate.allowAlways)
  };
}

export function formatGateParameters(parameters) {
  if (parameters === undefined || parameters === null || parameters === '') return '';
  if (typeof parameters === 'string') return parameters;
  try {
    return JSON.stringify(parameters, null, 2);
  } catch {
    return String(parameters);
  }
}

function approvalContext(prompt) {
  const context = prompt?.approval_context || prompt?.approvalContext;
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  return context;
}

function approvalContextParameters(context) {
  if (!context) return null;
  const parameters = {};
  const action = objectValue(context.action);
  const scope = objectValue(context.scope);
  const destination = objectValue(context.destination);

  if (action?.label) parameters.action = action.label;
  if (action?.method) parameters.method = action.method;
  if (scope?.label) parameters.scope = scope.label;
  if (typeof scope?.reusable === 'boolean') parameters.reusable_scope = scope.reusable;
  if (context.reason) parameters.reason = context.reason;
  if (destination) {
    parameters.destination = destination.label || destination.domain || destination.url || '';
    if (destination.domain) parameters.destination_domain = destination.domain;
    if (destination.url) parameters.destination_url = destination.url;
  }

  const details = detailsObject(context.details);
  if (Object.keys(details).length > 0) parameters.details = details;

  return Object.keys(parameters).length > 0 ? parameters : null;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function detailsObject(details) {
  const entries = {};
  for (const detail of Array.isArray(details) ? details : []) {
    const label = String(detail?.label || '').trim();
    if (!label) continue;
    entries[label] = detail?.value == null ? '' : String(detail.value);
  }
  return entries;
}
