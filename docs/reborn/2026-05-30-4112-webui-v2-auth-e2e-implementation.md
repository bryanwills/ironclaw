# Reborn WebUI v2: GSuite OAuth + Notion MCP OAuth + GitHub PAT — Implementation Design

**Issue:** [#4112](https://github.com/nearai/ironclaw/issues/4112)
**Base branch:** `codex/issue-4201-product-auth-http` (PR [#4245](https://github.com/nearai/ironclaw/pull/4245))
**Scope:** WebUI v2 surface + browser E2E proof for all three auth flows. Backend HTTP routes already mounted by #4245.
**Status:** Design — not yet implemented. Revised after advisor pass to avoid wire-breaking changes and tighten MVP scope.

---

## 0. Repository state when this doc was written

- Local clone: `/Users/firatsertgoz/Documents/ironclaw`, on branch `codex/issue-4201-product-auth-http` (last commit `3e41002f4`).
- Working tree dirty from a prior unrelated session; stashed via `git stash -u` (msg: "WIP on codex/issue-3537-extension-v2-cutover"). Restore with `git stash pop` if needed.
- No worktree was created. **Recommendation before implementation:** `git worktree add ../ironclaw-4112 codex/issue-4201-product-auth-http` so the main clone is not mutated.

---

## 1. Context recap

### Backend (already done in #4245)

Routes mounted in `crates/ironclaw_reborn_composition/src/product_auth_serve.rs:56-66, 238-252`:

| Route | Purpose | Body fields (verified at `:354-503`) |
|---|---|---|
| `POST /api/reborn/product-auth/oauth/start` | Start OAuth flow | `{provider, authorization_url, opaque_state, pkce_verifier, expires_at, session_id?, thread_id?}` |
| `GET /api/reborn/product-auth/oauth/callback/{flow_id}` | IDP callback | query: `code`, `state` |
| `POST /api/reborn/product-auth/manual-token/submit` | **Single-shot gate-resume** path used by WebUI today | `{provider, account_label, token, run_id, gate_ref, session_id?, thread_id?}` |
| `POST /api/reborn/product-auth/manual-token/setup` | Two-step flow: create pending interaction | `{provider, account_label, run_id?, gate_ref?, scope: {session_id?, thread_id?, invocation_id?}}` |
| `POST /api/reborn/product-auth/manual-token/secret-submit` | Two-step flow: submit secret out-of-band | `{interaction_id, token, scope: ScopeFields}` |
| `POST /api/reborn/product-auth/accounts/list` | List credential accounts | `{provider, requester_extension?, cursor?, limit?, scope}` |
| `POST /api/reborn/product-auth/accounts/select` | Select account for current scope | `{provider, account_id, requester_extension?, scope}` |
| `POST /api/reborn/product-auth/accounts/recovery` | Project recovery options for a stuck account | `{provider, requester_extension?, scope}` |
| `POST /api/reborn/product-auth/accounts/refresh` | Refresh access token / probe health | `{provider, account_id, requester_extension?, scope}` |
| `POST /api/reborn/product-auth/lifecycle/cleanup` | Disconnect / uninstall cleanup | `{extension_id, action, scope}` |

**Important DTO observation (correction from prior draft):** `/manual-token/submit` is the gate-resume path WebUI already uses (`api.js:237-258` — verified). `/manual-token/setup` + `/secret-submit` are an alternate two-step path for callers that need an out-of-band secret ingress (e.g., a popup window or rich modal that does not have the `run_id`/`gate_ref` upfront). **WebUI's chat-flow manual-token path will continue using `/submit`**; the new two-step routes are not on the issue's critical path.

### WebUI v2 today

- **Crate:** `crates/ironclaw_webui_v2_static` (Rust-hosted static SPA, feature `webui-v2-beta`).
- **Stack:** React 19 + HTM + react-router 7 + @tanstack/react-query + react-hook-form via esm.sh importmap; Tailwind v4 browser CDN. **No build step, no `package.json`** under `static/`.
- **SSE consumer:** `static/js/pages/chat/hooks/useSSE.js:12-27` lists the named events, including `gate` and `auth_required`. Handlers in `useChatEvents.js:107-115`.
- **Gate UI:**
  - `components/auth-token-card.js` — manual-token password input. Pure presentational; calls `onSubmit(value)` prop. **HTTP wiring lives in `hooks/useChat.js:239-323 submitAuthToken`**, which posts to `/api/reborn/product-auth/manual-token/submit` via `api.js:237`.
  - `components/approval-card.js` — Approve/Deny/Always modal.
  - `lib/gates.js::gateFromEvent` normalizes `gate`/`auth_required` SSE prompts.
- **Reads server fields it never receives.** `gates.js:9-32` reads `prompt.provider` and `prompt.account_label`, but the server's `AuthPromptView` (defined `crates/ironclaw_product_adapters/src/outbound.rs:539-545`) only carries `{turn_run_id, auth_request_ref, headline, body}`. So `provider` and `accountLabel` are perpetually `undefined`/`"github"` (fallback), and **there is no `auth_url` on the wire at all**.

### Where `AuthChallenge` data actually lives

Verified by direct repo read, not speculation:

1. **Engine pause site** (`crates/ironclaw_engine/src/gate/mod.rs:44-67`): `ResumeKind::Authentication { credential_name, instructions, auth_url: Option<String> }`. So at the engine level, `auth_url` exists alongside the gate but is engine-internal — not surfaced through `TurnLifecycleEvent`.
2. **Reborn flow store**: `crates/ironclaw_reborn_composition/src/auth.rs:806-823` — `start_setup_oauth_flow` persists `AuthChallenge::OAuthUrl` in `flow_manager` keyed by flow id.
3. **Reborn interaction store**: `auth.rs:830-857` — `request_secret_input` returns the `ManualTokenRequired` challenge from `interaction_service`.
4. **Projection layer** (`crates/ironclaw_reborn_composition/src/projection/turn_events.rs:140-185`): `blocked_prompt_payload` only inspects `TurnRunState.gate_ref` — never reaches into flow/interaction stores.
5. **Event schema** (`crates/ironclaw_turns/src/events.rs:62-81`): `TurnLifecycleEvent` carries `blocked_gate: Option<TurnBlockedGateMetadata { gate_ref, gate_kind }>` — kind discriminator but no challenge body.

### Gaps that 4112 must close

1. **`AuthPromptView` carries no provider/auth_url** — WebUI cannot distinguish OAuth vs ManualToken, cannot render an OAuth URL button. **Primary gap.**
2. **No OAuth-URL UI component** — `auth-oauth-card.js` does not exist.
3. **No browser E2E for product-auth flows** — `pytest-playwright` is wired (`tests/e2e/conftest.py:1163-1232`) but no scenario uses it for product-auth.
4. **No mock OAuth IDP fixture** — only inline aiohttp Bearer-mock in `tests/e2e/scenarios/test_skill_oauth_flow.py:38-104`.

---

## 2. Design (revised)

### 2.1 Wire-shape changes (Rust) — **additive, non-breaking**

#### Extend `AuthPromptView` with optional fields

The struct derives `Deserialize`, so it must stay backward-compatible for any consumer that may persist or replay the event. **All new fields are `Option<…>` with `serde(default, skip_serializing_if = "Option::is_none")`** so existing serialized rows and v1 channels continue to round-trip.

```rust
// crates/ironclaw_product_adapters/src/outbound.rs:539
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthPromptView {
    pub turn_run_id: TurnRunId,
    pub auth_request_ref: String,
    pub headline: String,
    pub body: String,

    // --- v2 additions, all optional & backwards-compatible ---
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub challenge_kind: Option<AuthPromptChallengeKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    /// Opaque IDP authorization URL — already user-visible on v1 wire as
    /// `AppEvent::OnboardingState.auth_url`. Present only for `OAuthUrl`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<Timestamp>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthPromptChallengeKind {
    OAuthUrl,
    ManualToken,
    /// Catch-all for the remaining `AuthChallenge` variants we don't yet
    /// surface in WebUI v2 chat flow. Renders as a fall-through manual-token
    /// or a "see settings" hint.
    Other,
}
```

**Why optional, not `serde(flatten)` enum:** flattening a tagged enum into a struct that already has 4 mandatory fields and derives `Deserialize` is wire-breaking — any persisted event row without the tag field would fail to deserialize. Optional siblings are forward+backward compatible.

**Redaction invariant:** only opaque IDP URLs ever flow through `authorization_url`. No PKCE verifier, no client secret, no auth code, no access/refresh token, no `interaction_id`.

#### Source the challenge in `blocked_prompt_payload` — lookup-at-projection (Option B)

`TurnLifecycleEvent` is a serialized event row; extending it for one consumer is high-blast-radius. Instead, add a single read-only lookup on the auth-side service that the projection layer already has DI access to:

```rust
// crates/ironclaw_reborn_composition/src/auth.rs (impl RebornProductAuthServices)
pub async fn lookup_pending_challenge_for_gate(
    &self,
    scope: &AuthProductScope,
    gate_ref: &GateRef,
) -> Result<Option<AuthChallengeProjection>, AuthProductError> {
    // Try flow_manager first (OAuth), then interaction_service (ManualToken).
    // Return a *projected* (redacted) view, never the raw AuthChallenge enum.
    ...
}

/// Projection-safe view. No raw secrets, no PKCE verifier, no opaque_state.
pub struct AuthChallengeProjection {
    pub kind: AuthPromptChallengeKind,
    pub provider: String,
    pub account_label: Option<String>,
    pub authorization_url: Option<String>,
    pub expires_at: Option<Timestamp>,
}
```

Then `blocked_prompt_payload` (`projection/turn_events.rs:170-180`) optionally enriches `AuthPromptView` from the lookup. If the lookup returns `None` (e.g., the flow was already consumed), the prompt falls back to the original 4-field view — UI shows a generic auth card with the existing copy.

**Trade-off accepted:** one extra read per BlockedAuth projection. Cost is negligible (in-memory store; ~1 µs).

#### Contract doc

Append a new section to `docs/reborn/contracts/auth-product.md`:
- the 5 added optional fields, redaction invariant, and worked JSON examples for `OAuthUrl` and `ManualToken`;
- explicit "v1 consumers may ignore all v2 fields" backward-compat statement.

### 2.2 WebUI v2 changes (JS, no build) — **MVP only**

#### Scope decision (MVP)

Per issue 4112 acceptance, MVP renders **two** challenge variants in the chat flow:
- **`oauth_url`** → new `auth-oauth-card.js` (GSuite + Notion).
- **`manual_token`** → existing `auth-token-card.js`, unchanged HTTP wiring (`/manual-token/submit`). Only header copy is provider-aware once `provider`/`account_label` actually arrive on the wire.

**Deferred to follow-up tickets** (out of scope for 4112):
- `AccountSelectionRequired` UI card and `/accounts/select` wiring.
- `ReauthorizeRequired` UI card and `/accounts/recovery` wiring.
- `SetupRequired` UI card.
- Account-management settings page (list/refresh/disconnect) for `/accounts/*` + `/lifecycle/cleanup`.
- Two-step `/manual-token/setup` + `/secret-submit` (alternate ingress, not the chat-flow path).

#### File map (MVP)
```
crates/ironclaw_webui_v2_static/static/js/
├── lib/
│   └── api.js                                  # +0 new helpers (existing submitManualToken stays)
└── pages/chat/
    ├── lib/
    │   └── gates.js                            # read challenge_kind + authorization_url
    ├── components/
    │   ├── auth-token-card.js                  # tweak header to surface provider/account_label
    │   └── auth-oauth-card.js                  # NEW — OAuthUrl UI
    ├── hooks/
    │   ├── useSSE.js                           # +"auth_completed" event name
    │   ├── useChat.js                          # handle auth_completed → clear gate
    │   └── useChatEvents.js                    # route auth_completed → clear pendingGate
    └── chat.js                                 # dispatch by challengeKind
```

#### `gates.js` (small additive change)

```js
if (eventType === "auth_required") {
  return {
    kind: "auth_required",
    challengeKind: prompt.challenge_kind || "manual_token", // fallback preserves today's UI
    runId: prompt.turn_run_id,
    gateRef: prompt.auth_request_ref,
    provider: prompt.provider || "github",
    accountLabel: prompt.account_label || "Manual token",
    authorizationUrl: prompt.authorization_url, // undefined for manual_token
    expiresAt: prompt.expires_at,
    headline: prompt.headline,
    body: prompt.body,
  };
}
```

#### `chat.js` dispatch (~5-line change at L116-126)

```js
${pendingGate?.kind === "auth_required"
  ? (pendingGate.challengeKind === "oauth_url"
      ? html`<${AuthOauthCard} gate=${pendingGate} onCancel=${onAuthCancel} />`
      : html`<${AuthTokenCard} gate=${pendingGate} onSubmit=${submitAuthToken} onCancel=${onAuthCancel} />`)
  : pendingGate?.kind === "gate"
    ? html`<${ApprovalCard} gate=${pendingGate} ... />`
    : null}
```

#### `auth-oauth-card.js` (new, ~80 LoC)

```js
import { html } from "htm/react";
import React from "react";
import { useTranslation } from "react-i18next";

export function AuthOauthCard({ gate, onCancel }) {
  const { t } = useTranslation();
  const [opened, setOpened] = React.useState(false);

  const openAuth = React.useCallback(() => {
    // window.open is a user-gesture-allowed popup; OAuth callback is handled
    // server-side by /api/reborn/product-auth/oauth/callback/{flow_id} which
    // resumes the paused run. WebUI observes the resume via the next
    // auth_completed (or turn-status) SSE frame and clears pendingGate.
    window.open(gate.authorizationUrl, "_blank", "noopener,noreferrer");
    setOpened(true);
  }, [gate.authorizationUrl]);

  return html`
    <div className="auth-oauth-card">
      <h3>${gate.headline || t("authGate.oauthHeadline", { provider: gate.provider })}</h3>
      <p>${gate.body}</p>
      <p className="muted">${t("authGate.accountLabel")}: ${gate.accountLabel}</p>
      <button onClick=${openAuth} className="btn-primary">
        ${opened ? t("authGate.reopenAuthorization") : t("authGate.openAuthorization")}
      </button>
      <button onClick=${onCancel} className="btn-secondary">${t("authGate.cancel")}</button>
      ${gate.expiresAt && html`<p className="muted">${t("authGate.expiresAt")}: ${new Date(gate.expiresAt).toLocaleString()}</p>`}
    </div>
  `;
}
```

No fetch, no secret handling, no popup-tracking complexity. The OAuth callback completes server-side; WebUI just waits.

#### Closing the OAuth card

Two options, picked by evidence rather than speculation:

- **Option α (preferred if available):** existing SSE projection already emits `projection_update` with run status flipping `BlockedAuth → Running` when the callback resumes. If `useChatEvents.js` already clears `pendingGate` on that transition, **no new event needed**. Spike before P1 locks in: run `test_skill_oauth_flow.py` against the v2 wire to confirm.
- **Option β (fallback):** add `ProductOutboundPayload::AuthCompleted { turn_run_id, auth_request_ref }`, emitted from `blocked_prompt_payload` on the status flip, and a matching `auth_completed` SSE event name added to `useSSE.js::V2_EVENT_NAMES`.

**Decision rule:** if option α works, ship α (zero new wire surface). Only add β if the OAuth card otherwise stays mounted after the resume.

### 2.3 Approval gate after auth

Already wired (`approval-card.js`, `engine_v2_gate_integration.rs`). Once auth completes and the tool runs, the engine raises a separate `gate` SSE event for any tool with `requires_approval = true`. **No new code.** E2E test asserts this.

---

## 3. Browser E2E — three scenarios

All under `tests/e2e/scenarios/`, using `pytest-playwright`. Browser fixture already in `conftest.py:1163-1232`.

### 3.1 New shared fixtures (`tests/e2e/fixtures/`)

```python
# mock_oauth_idp.py — aiohttp server with /authorize + /token endpoints.
#   Validates PKCE (S256), opaque state, emits a 302 to the callback URL
#   carrying ?code=&state=. /token issues a fake access_token + refresh_token.
#   Supports a "fail PKCE" mode for negative tests.
@pytest.fixture(scope="module")
async def mock_oauth_idp() -> AsyncIterator[str]: ...

# mock_bearer_api.py — extracted from test_skill_oauth_flow.py::_start_mock_api.
@pytest.fixture(scope="module")
async def mock_bearer_api() -> AsyncIterator[str]: ...

# mock_notion_mcp.py — minimal MCP server (initialize / tools/list / tools/call)
#   that proxies auth_required upstream and requires Bearer on tool calls.
@pytest.fixture(scope="module")
async def mock_notion_mcp() -> AsyncIterator[str]: ...

# ironclaw_v2 binary fixture — spawn with feature webui-v2-beta, env-override
# provider endpoints to the mock IDP/API URLs, wait for WebUI port to bind.
@pytest.fixture
async def ironclaw_v2(tmp_path, mock_llm, mock_oauth_idp, mock_bearer_api) -> AsyncIterator[V2Handle]: ...
```

### 3.2 `test_v2_github_pat_flow.py` (P-first — simplest, no OAuth machinery)

```
1. Open WebUI v2 (page.goto).
2. Send message that triggers GitHub tool ("list issues on owner/repo").
3. Expect AuthTokenCard rendered: provider="github", accountLabel surfaced, password input visible.
4. Type ghp_fake_xyz, submit. Capture POST body via page.on("request"):
   assert URL == "/api/reborn/product-auth/manual-token/submit"
   assert body.token == "ghp_fake_xyz".
5. After submit, capture all SSE frames and DOM snapshots; scan against
   leak_detector::GITHUB_PAT_REGEX (line 1190). Assert zero matches.
6. Mock GitHub API receives "list issues" with Bearer header.
7. Send message triggering a *write* ("create issue"). ApprovalCard renders.
   Click Approve. Mock API receives POST /repos/.../issues.
   Send another, click Deny. Mock API receives nothing.
```

### 3.3 `test_v2_gsuite_oauth_flow.py`

```
1. Open WebUI v2, send Gmail-requiring message.
2. Expect AuthOauthCard rendered: provider="google", authorization_url set.
3. Click "Open authorization page" — capture window.open call via
   context.expect_page() (Playwright multi-page API).
4. In the popup page, follow the IDP authorize → callback redirect.
5. In the original page, assert OAuth card unmounts within timeout
   (poll: pendingGate clears, projection flips to Running).
6. Mock Gmail API receives Bearer.
7. Leak scan: scan SSE frames, DOM, localStorage. Assert no access_token,
   refresh_token, pkce_verifier, raw state.
8. Multi-user isolation: spawn a second incognito context as a different
   user. Send same message. Assert that user gets its own AuthOauthCard
   (independent flow_id, independent challenge).
```

### 3.4 `test_v2_notion_mcp_oauth_flow.py`

Same skeleton as GSuite, with `mock_notion_mcp` as the capability target. The MCP transport injects the Bearer header into `tools/call` after OAuth completes; mock asserts the header arrived. Tool routing reference: `crates/ironclaw_reborn_composition/src/nearai_mcp.rs:100`.

---

## 4. Phased implementation plan

| Phase | LoC est. | Files | Verification |
|---|---|---|---|
| **P0 Spike — OAuth card teardown** | 0 | run existing v2 wire against a mock callback | Decide α vs β for closing the card |
| **P1 Wire** | ~150 Rust | `outbound.rs`, `auth.rs` (`lookup_pending_challenge_for_gate`), `projection/turn_events.rs`, `tests/webui_v2_product_auth_4201.rs`, `docs/.../auth-product.md` | New Rust test: `AuthPromptView` round-trips with and without v2 fields. Integration test: BlockedAuth projection enriches when challenge present. |
| **P2 UI dispatch + OAuth card** | ~150 JS | `gates.js`, `chat.js`, `auth-oauth-card.js`, (optional `useSSE.js`, `useChat.js`, `useChatEvents.js` for β) | Manual smoke against a stub backend; existing manual-token flow still green. |
| **P3 Shared E2E fixtures** | ~400 Python | `tests/e2e/fixtures/mock_oauth_idp.py`, `mock_bearer_api.py`, `mock_notion_mcp.py`, `conftest.py` wiring | Each fixture self-test asserts /authorize + /token shapes. |
| **P4 GitHub PAT E2E** | ~250 Python | `tests/e2e/scenarios/test_v2_github_pat_flow.py` | `pytest tests/e2e/scenarios/test_v2_github_pat_flow.py` green |
| **P5 GSuite OAuth E2E** | ~300 Python | `tests/e2e/scenarios/test_v2_gsuite_oauth_flow.py` | green |
| **P6 Notion MCP OAuth E2E** | ~350 Python | `tests/e2e/scenarios/test_v2_notion_mcp_oauth_flow.py` | green |

**Total MVP:** ~150 Rust + ~150 JS + ~1300 Python ≈ **1600 LoC**.

**PR slicing:**
- **PR A** = P1 (wire). Backward compatible; merges with green CI even before WebUI changes.
- **PR B** = P2 (WebUI). Depends on A.
- **PR C** = P3 + P4 (fixtures + GitHub PAT E2E). First end-to-end proof.
- **PR D** = P5 + P6 (GSuite + Notion E2E).

**Parallelizable:** P3 can start in parallel with P1/P2.

---

## 5. Verification checklist (from issue 4112 acceptance)

- [ ] User can start and complete GSuite OAuth, Notion MCP OAuth, and GitHub PAT auth from WebUI v2 without manual API calls → P2 + P4/P5/P6.
- [ ] All three flows use the Reborn-native product-auth routes from #4031 → asserted in E2E by `page.on("request")` URL captures.
- [ ] Each E2E drives the browser/WebUI path, not only `RebornProductAuthServices` helpers → Playwright-driven by construction.
- [ ] Raw state, PKCE verifier, auth code, provider response bodies, access tokens, refresh tokens, secret handles, and PAT values never rendered in UI/SSE → leak-detector regex scan in each E2E.
- [ ] Write-approval gate fires after auth → asserted in `test_v2_github_pat_flow.py::test_github_write_requires_approval`.
- [ ] Multi-user isolation holds in browser E2E → asserted in `test_v2_gsuite_oauth_flow.py::test_per_user_isolation`.
- [ ] No Notion native SDK integration (MCP only) → enforced by design — Notion E2E talks only to `mock_notion_mcp`.
- [ ] No live Google/Notion/GitHub network calls → enforced by mock fixtures.
- [ ] No second GSuite-specific OAuth route → enforced by P1 (reuse existing `oauth/start`).

---

## 6. Risks

- **R1: P0 spike outcome.** If existing projection does NOT auto-clear the OAuth card on resume, β (new `AuthCompleted` event) is required and P2 grows by ~30 LoC. **Mitigation:** P0 is a 30-minute spike; gate P2 on its result.
- **R2: `lookup_pending_challenge_for_gate` cross-store lookup.** Need to confirm the flow_manager + interaction_service are reachable from the projection's DI graph (`ProductAuthRouteState` carries them but `blocked_prompt_payload` is called from a separate path). **Mitigation:** verify by reading `crates/ironclaw_reborn_composition/src/projection/factory.rs` (or equivalent) during P1 hour-1; if not reachable, add the trait to the projection's existing service handle rather than threading a new dependency.
- **R3: Notion MCP fixture parity.** MCP protocol is larger than HTTP Bearer. **Mitigation:** start with the minimum surface (`initialize`, `tools/list`, `tools/call` + OAuth handshake) needed by the issue; defer richer MCP features.
- **R4: Browser E2E flakiness.** SSE timing + popup-window handoff are flake sources. **Mitigation:** Playwright `expect.poll()` with bounded timeouts; gate fixtures on health checks; mark E2E tests with `pytest.mark.slow` so they don't run on every PR.
- **R5: Body-limit registry drift.** No new routes are added; the existing 16 KiB body limit covers all consumed paths. **No action needed.**

---

## 7. Files added/modified summary (MVP)

**Modified (Rust)**
- `crates/ironclaw_product_adapters/src/outbound.rs` — 5 optional fields on `AuthPromptView`, new `AuthPromptChallengeKind` enum.
- `crates/ironclaw_reborn_composition/src/auth.rs` — `lookup_pending_challenge_for_gate` + `AuthChallengeProjection` redacted view.
- `crates/ironclaw_reborn_composition/src/projection/turn_events.rs` — enrich `AuthPromptView` from lookup; (β) emit `AuthCompleted` on resume.
- `crates/ironclaw_reborn_composition/tests/webui_v2_product_auth_4201.rs` — add wire-shape assertions for the new fields.
- `docs/reborn/contracts/auth-product.md` — new "AuthPromptView v2 enrichment" section.

**Modified (JS)**
- `static/js/pages/chat/lib/gates.js` — read `challenge_kind`, `authorization_url`, `expires_at`.
- `static/js/pages/chat/chat.js` — dispatch by `challengeKind`.
- (β only) `static/js/pages/chat/hooks/useSSE.js`, `useChat.js`, `useChatEvents.js` — handle `auth_completed`.

**Added (JS)**
- `static/js/pages/chat/components/auth-oauth-card.js` — OAuthUrl UI.

**Added (Python E2E)**
- `tests/e2e/fixtures/mock_oauth_idp.py`
- `tests/e2e/fixtures/mock_bearer_api.py`
- `tests/e2e/fixtures/mock_notion_mcp.py`
- `tests/e2e/conftest.py` — register new fixtures + `ironclaw_v2` handle.
- `tests/e2e/scenarios/test_v2_github_pat_flow.py`
- `tests/e2e/scenarios/test_v2_gsuite_oauth_flow.py`
- `tests/e2e/scenarios/test_v2_notion_mcp_oauth_flow.py`

---

## 8. Deferred to follow-up tickets (NOT in 4112)

- Account-selection UI card (`AccountSelectionRequired`) — file ticket `4112b`.
- Reauthorize / setup-required UI cards — `4112b`.
- Settings page for account list/refresh/disconnect — `4112c`.
- Two-step `/manual-token/setup` + `/secret-submit` browser path — `4112d` (only needed if a non-gate-resume manual-token surface is added).
- Google token refresh **implementation** (backend) — separate ticket, out of issue 4112 scope.
- Live network tests with real credentials — out of scope.

---

## 9. Open questions for reviewer

1. **P0 spike outcome** (α vs β) — should we add a dedicated `auth_completed` SSE event, or is the existing projection-update flip enough? **Recommendation:** spike before P1 lands.
2. **`lookup_pending_challenge_for_gate` placement** — on `RebornProductAuthServices` directly, or behind a narrower projection trait? **Recommendation:** narrow trait so projection layer doesn't depend on the full auth service surface.
3. **Provider naming on the wire.** `authorization_url` already carries an `AuthProviderId` internally — should the WebUI key off `provider` (string) or accept a typed discriminator? **Recommendation:** keep `provider: Option<String>` since `AuthProviderId` is a string newtype.
4. **MVP scope confirmation.** This plan defers account-selection / reauth UI. Issue 4112 text does not require them in the chat-flow E2E, but the parent #4201 added the routes for a reason. Confirm they belong in a separate ticket.
