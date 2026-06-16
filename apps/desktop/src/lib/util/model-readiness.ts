export type ModelExecutionReadiness = {
  verified: boolean;
  sendBlocked: boolean;
  tone: 'positive' | 'warning';
  label: string;
  buttonPrefix: string;
  description: string;
  sendBlockReason: string;
};

const UNVERIFIED: ModelExecutionReadiness = {
  verified: false,
  sendBlocked: false,
  tone: 'warning',
  label: 'Execution not verified',
  buttonPrefix: 'Unverified',
  description:
    'This model is configured but not execution-tested yet. The first successful chat run will verify it.',
  sendBlockReason: ''
};

const BLOCKED: ModelExecutionReadiness = {
  verified: false,
  sendBlocked: true,
  tone: 'warning',
  label: 'Model setup required',
  buttonPrefix: 'Setup required',
  description: 'The configured model cannot run until provider setup is fixed.',
  sendBlockReason: 'The configured model cannot run until provider setup is fixed.'
};

const VERIFIED: ModelExecutionReadiness = {
  verified: true,
  sendBlocked: false,
  tone: 'positive',
  label: 'Execution verified',
  buttonPrefix: 'Verified',
  description: 'Gateway reports this model is execution-ready.',
  sendBlockReason: ''
};

export function modelExecutionReadiness(gatewayStatus: unknown): ModelExecutionReadiness {
  if (isModelExecutionVerified(gatewayStatus)) return VERIFIED;
  const reason = modelExecutionBlockReason(gatewayStatus);
  if (!reason) return UNVERIFIED;
  return {
    ...BLOCKED,
    description: reason,
    sendBlockReason: reason
  };
}

export function isModelExecutionVerified(gatewayStatus: unknown): boolean {
  if (!gatewayStatus || typeof gatewayStatus !== 'object') return false;
  const record = gatewayStatus as Record<string, unknown>;
  if (record.model_execution_verified === true) return true;
  if (record.modelExecutionVerified === true) return true;

  return [
    record.model_execution_readiness,
    record.modelExecutionReadiness,
    record.model_readiness,
    record.modelReadiness,
    record.llm_model_readiness,
    record.llmModelReadiness,
    record.llm_readiness,
    record.llmReadiness,
    record.execution_readiness,
    record.executionReadiness,
    record.readiness
  ].some(isGreenReadiness);
}

function isGreenReadiness(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().toLowerCase() === 'green';
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return [
    record.status,
    record.phase,
    record.model_execution,
    record.modelExecution,
    record.model_execution_readiness,
    record.modelExecutionReadiness,
    record.model,
    record.llm_model,
    record.llmModel,
    record.llm,
    record.execution
  ].some(isGreenReadiness);
}

function modelExecutionBlockReason(gatewayStatus: unknown): string {
  if (!gatewayStatus || typeof gatewayStatus !== 'object') return '';
  const record = gatewayStatus as Record<string, unknown>;
  const readinessValues = [
    record.model_execution_readiness,
    record.modelExecutionReadiness,
    record.model_readiness,
    record.modelReadiness,
    record.llm_model_readiness,
    record.llmModelReadiness,
    record.llm_readiness,
    record.llmReadiness,
    record.execution_readiness,
    record.executionReadiness,
    record.readiness
  ];
  const category =
    [
      record.model_execution_failure_category,
      record.modelExecutionFailureCategory,
      ...readinessValues
    ]
      .map(blockingToken)
      .find((value) => value.length > 0) ?? '';
  const reason =
    [
      record.model_readiness_reason,
      record.modelReadinessReason,
      record.model_execution_failure_summary,
      record.modelExecutionFailureSummary
    ]
      .map(stringValue)
      .find((value) => isBlockingText(value) && !isGenericFirstRunVerificationReason(value)) ?? '';

  if (reason) return reason;
  if (category) return category.replaceAll('_', ' ');
  return '';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function blockingToken(value: unknown): string {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return isBlockingText(normalized) ? normalized : '';
  }
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  return (
    [
      record.status,
      record.phase,
      record.category,
      record.reason,
      record.model_execution_failure_category,
      record.modelExecutionFailureCategory,
      record.model_execution_readiness,
      record.modelExecutionReadiness,
      record.model_readiness,
      record.modelReadiness,
      record.execution
    ]
      .map(blockingToken)
      .find((token) => token.length > 0) ?? ''
  );
}

function isBlockingText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'unverified' || normalized === 'configured') return false;
  if (normalized.includes('policy_denied')) return true;
  if (/(credential|token|api[_ -]?key|session[_ -]?token|auth)/.test(normalized)) {
    return /(missing|required|unavailable|not[_ -]?configured|no |sign in|authenticate|vaulted)/.test(
      normalized
    );
  }
  if (/(driver|provider|model).*(unavailable|missing|not[_ -]?available)/.test(normalized)) {
    return true;
  }
  return false;
}

function isGenericFirstRunVerificationReason(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.includes('configured provider/model only') ||
    normalized.includes('execution is verified by a successful webchat run') ||
    normalized.includes('first successful chat run will verify') ||
    normalized.includes('successful chat run will verify')
  );
}
