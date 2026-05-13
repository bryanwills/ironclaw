# ironclaw_outbound guardrails

- Own outbound egress policy, delivery-status metadata, and projection subscription cursor checkpoints only.
- Do not send transport messages, validate concrete Slack/Telegram/Web payloads, or mutate canonical transcript/projection state.
- Persist metadata/refs/cursors only: no raw prompts, message bodies, tool inputs/outputs, secrets, host paths, or backend error details.
- External push targets are candidates only; the outbound policy service must call the reply-target validator before every delivery attempt.
- Authorization-revoked delivery attempts record sanitized failure status and must not return a sendable target.
- Delivery failure records are separate from canonical transcript/projection state and must not mark turns/runs failed.
- Trust-bearing types (`ThreadProjectionAccessGrant`, `ValidatedReplyTargetBinding`) are sealed: only `OutboundPolicyService` mints them via `pub(crate)` constructors. Policy and validator implementors return the corresponding untrusted `Claim` types (`ThreadProjectionAccessClaim`, `ReplyTargetBindingClaim`) and never construct a grant/binding directly. New trust-bearing types added to this crate follow the same claim/seal split.
- Validator errors are classified at the service boundary: `AccessDenied` records `DeliveryFailureKind::AuthorizationRevoked` (permanent); `Backend`/`Serialization` record `DeliveryFailureKind::TransientValidatorError` (retryable); caller-bug errors (`InvalidRequest`, `SubscriptionScopeMismatch`, `DeliveryNotFound`) propagate to the caller and must not produce a phantom attempt row.
