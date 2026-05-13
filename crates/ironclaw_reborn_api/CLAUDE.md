# ironclaw_reborn_api

Shared HTTP API infrastructure for IronClaw Reborn product surfaces.

## Purpose

Provides reusable building blocks (auth contract, error mapping, idempotency
middleware, projection-stream-to-SSE/WS adapters, OpenAPI primitives) for
product-specific HTTP surfaces. Concrete `/api/chat/v2/*` (WebChat v2 per
#3282) and `/v1/chat/completions` / `/v1/responses` (OpenAI-compatible per
#3283) routes live in consumer crates, not here.

## Key modules

| Module | Role |
|--------|------|
| `error` | `ApiError` + `IntoResponse` impl; mapper from `ProductAdapterError` |
| `auth` | `CallerAuthenticator` trait + `AuthenticatedCaller` extractor |
| `idempotency` | Middleware for both `Idempotency-Key` header and `client_action_id` body field |
| `projection::sse` | `ProjectionStreamItem` → SSE adapter (30s heartbeat) |
| `projection::websocket` | `ProjectionStreamItem` → WebSocket adapter |
| `envelope` | Shared `ApiErrorEnvelope` (OpenAI-compatible shape), `PaginatedListEnvelope` |
| `state` | `ApiServices` bundle + `ApiState` trait for consumer state injection |
| `openapi` | `utoipa` shared schema fragments |

## Boundary rules

This crate may depend on:
- `ironclaw_product_adapters` — DTO contract types exposed over HTTP
- `ironclaw_product_workflow` — `ProductWorkflow`, `IdempotencyLedger`
- `ironclaw_event_projections` — `ProjectionCursor`, `ProjectionScope`
- `ironclaw_turns` — `TurnActor`, `TurnScope`
- `ironclaw_host_api` — canonical identifiers

This crate must NOT depend on: `ironclaw_dispatcher`, `ironclaw_capabilities`,
`ironclaw_host_runtime`, `ironclaw_authorization`, `ironclaw_approvals`,
`ironclaw_network`, `ironclaw_secrets`, `ironclaw_filesystem`,
`ironclaw_wasm`, `ironclaw_processes`, `ironclaw_extensions`,
`ironclaw_skills`, `ironclaw_mcp`, `ironclaw_scripts`, `ironclaw_engine`,
`ironclaw_gateway`, `ironclaw_tui`, `ironclaw_reborn`. Enforced by
`crates/ironclaw_architecture/tests/reborn_dependency_boundaries.rs`.

## Cursor authority

Projection subscription resume always uses
`ironclaw_event_projections::ProjectionCursor`. Transport-local `id` fields
(SSE `id:`, WebSocket `seq`) are NEVER accepted as Reborn cursor authority.
See #3266 for the full cursor-only invariant.

## What ships here, what doesn't

Ships in this crate:
- All wire-stable shared types (`ApiError*`, `ProjectionStreamItem*`,
  `IdempotencyKey`, `AuthenticatedCaller`)
- `axum`-compatible middleware/extractors/IntoResponse impls
- OpenAPI shared schema components

Does **not** ship here (consumer-surface PRs):
- Concrete route declarations (`Router::new().route("/api/chat/v2/messages", …)`)
- Concrete `CallerAuthenticator` implementations (production wiring extends
  this with a wrapper around v1's bearer/OIDC stack)
- Server binary or `serve` subcommand on `ironclaw-reborn`
- AppBuilder integration (consumer surfaces mount themselves)

## Status

Shape B of step 3 of the Reborn rollout: shared infrastructure crate without
concrete routes. The first slice scaffolds the module structure; full
implementations of each module land in follow-up commits per the
crate's `services.rs`-style port pattern established by `ironclaw_product_workflow`.
