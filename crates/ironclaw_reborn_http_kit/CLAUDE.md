# ironclaw_reborn_http_kit guardrails

- This crate is the product-agnostic serving core for the Reborn WebChat
  v2 listener. It owns the mount vocabulary (`ProtectedRouteMount`,
  `PublicRouteMount`), the descriptor-driven middleware stack (per-route
  body limit, rate limit, WebSocket origin, operator-route
  authorization), the bearer-auth middleware, and
  `compose_webui_v2_app`.
- **No product knowledge.** Product route families (product-auth OAuth,
  Slack host surfaces, OpenAI-compat, SSO login) must reach the composed
  app as mounts supplied on `WebuiServeConfig`. Do not add
  product-specific config fields, imports, or `cfg` branches here — that
  coupling is exactly what the extraction from
  `ironclaw_reborn_composition::webui_serve` removed. The single allowed
  exception is the `openai-compat-beta` feature, which stamps the
  OpenAI-compat authenticated-caller extension from the same verified
  bearer result (route crates must not mint that evidence).
- **No server lifecycle.** Expose `Router`s and
  `IngressRouteDescriptor`s only; never bind listeners or call
  `axum::serve`. Enforced by
  `ironclaw_architecture::reborn_dependency_boundaries::reborn_product_api_crates_do_not_bind_http_ingress`.
- Every mounted route must carry an `IngressRouteDescriptor` folded into
  the shared descriptor list, so the per-route body-limit and rate-limit
  middlewares apply uniformly — no descriptor-less side doors.
- The middleware stack ordering, security invariants, and the `?token=`
  SSE shim contract are documented in
  `crates/ironclaw_reborn_composition/CLAUDE.md` ("WebUI v2 native
  surface"); behavior changes here must keep that document true.
