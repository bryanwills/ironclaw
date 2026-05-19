# Crate Boundary & Ownership Audit — reborn-integration

**Date:** 2026-05-18
**Branch:** `reborn-integration` (~690 commits ahead of `main`)
**Scope:** all 47 workspace crates + the legacy `src/` tree
**Method:** six parallel research passes (loop/orchestration, security/policy, extensions/tools, storage/state, src↔crates legacy, channels/host), one synthesis pass, deduplication into 8 themes
**Purpose:** surface ambiguous ownership so the team can resolve it async and update CLAUDE.md / AGENTS.md files, then send autonomous agents to fix the gaps with clear directions.

This audit is intentionally findings + proposed resolution. Each "Proposed resolution" is a *starting position* for team discussion, not a decided plan.

---

## TL;DR

- The reborn migration is roughly half-done. Many `src/<x>/` modules (`src/agent/`, `src/tools/`, `src/workspace/`, `src/skills/`) coexist with their reborn replacements, with no documented v1/v2 status matrix.
- Several concepts have **3–4 parallel names** across crates with no shared trait: "extension" vs "product_adapter" vs "channel" vs "tool"; "authorization" vs "trust" vs "capabilities" vs "approvals" vs "runtime_policy"; "memory" vs "workspace" vs "resources" vs "run_state".
- `ironclaw_host_api` is depended on by every workspace crate (47/47) and is starting to grow concrete behavior (1,040-line `ingress.rs`, 849-line `runtime_policy.rs`) — risk of god-crate.
- At least one crate is **orphaned with zero callers** (`ironclaw_outbound`) and one directory is on disk but excluded from the workspace (`crates/ironclaw_reborn_telegram_v2_host/`).
- Several crates breach their own declared guardrails (`src/workspace/reborn_identity_context.rs` imports from `ironclaw_memory` despite `ironclaw_memory/CLAUDE.md` forbidding the inverse).

8 themes, 25 individual findings, each with file-level evidence and a proposed resolution below.

---

## Theme A — Engine v1 ↔ v2 migration is mid-flight and undocumented

The most pervasive theme. Reborn is the v2 engine. `src/agent/`, `src/tools/dispatch.rs`, `src/skills/`, `src/bridge/` and several other modules are v1 — but nothing tells a new contributor (or an autonomous agent) which surface to extend.

### A1. Agent loop ownership: `src/agent/` vs `ironclaw_agent_loop` vs `ironclaw_engine` vs `ironclaw_reborn`

**Ambiguity.** Four crates / modules touch "the agent loop":
- `src/agent/` (~31 KB) is the fully implemented v1 agent (dispatcher, scheduler, session management).
- `ironclaw_engine` was the central crate on `main` but now declares only `ironclaw_common` + `ironclaw_skills` as deps — gutted.
- `ironclaw_agent_loop` owns framework state, strategies, planner, executor (~150 KB).
- `ironclaw_reborn::PlannedDriver` is the adapter that wires agent_loop into the runtime.

A contributor adding "fallback when a tool times out" has four plausible homes.

**Evidence.**
- `src/agent/mod.rs:1-16` — v1 "Core agent logic"
- `crates/ironclaw_engine/Cargo.toml:6` — claims "unified thread-capability-CodeAct execution engine" but dep set is empty
- `crates/ironclaw_agent_loop/Cargo.toml:6` — "framework state and strategy contracts"
- `crates/ironclaw_reborn/src/lib.rs:1-35` — assembly of agent_loop + drivers

**Proposed resolution.**
- Add a "v1 vs v2 engine status" section to project-level `CLAUDE.md` (after the Architecture section) declaring `src/agent/` as v1-maintenance-mode and `ironclaw_reborn` + `ironclaw_agent_loop` as v2-canonical.
- In each crate's `CLAUDE.md` state the layer: `ironclaw_engine` = execution mechanics (or delete if fully gutted), `ironclaw_agent_loop` = orchestration strategy, `ironclaw_reborn` = adapter. Engine and agent_loop must not import each other; only `ironclaw_reborn` (or its composition) imports both.
- Suggested owner: agent/loop team.

### A2. Tool dispatcher: `src/tools/dispatch.rs` vs `ironclaw_dispatcher`

**Ambiguity.** Project-level `CLAUDE.md` ("Everything Goes Through Tools", lines 212–230) declares `src/tools/dispatch.rs::ToolDispatcher::dispatch()` as the canonical entry point. A new `ironclaw_dispatcher` crate exists with its own `RuntimeDispatcher` / `CapabilityDispatcher` trait. They are not cross-referenced.

**Evidence.**
- `src/tools/dispatch.rs:1-50`
- `crates/ironclaw_dispatcher/src/lib.rs:1-6` and `crates/ironclaw_dispatcher/CLAUDE.md:1-2` ("Own already-authorized runtime routing only")
- Zero `ironclaw_dispatcher` imports anywhere in `src/`

**Proposed resolution.**
- Declare in `CLAUDE.md`: `src/tools/dispatch.rs` is v1; `ironclaw_dispatcher` (post-authorization) is v2. New code routes via `ironclaw_capabilities::CapabilityHost` → `ironclaw_dispatcher`.
- File a tracking issue to remove `src/tools/dispatch.rs` once v1 is retired.
- Suggested owner: dispatch/capabilities team.

### A3. Tool trait fragmentation — four parallel "Tool" abstractions

**Ambiguity.** No shared trait spans the four runtimes:
- `src/tools::Tool` (legacy, async_trait, `JobContext`)
- `WasmHostTools` in `ironclaw_wasm` (host-import seam only)
- `McpExecutionRequest` in `ironclaw_mcp` (request-shaped, no trait)
- script backend in `ironclaw_scripts` (not exported as a trait)

**Evidence.**
- `src/tools/tool.rs:1-100`
- `crates/ironclaw_wasm/src/host.rs`
- `crates/ironclaw_mcp/src/lib.rs:50-97`
- `crates/ironclaw_scripts/Cargo.toml`

**Proposed resolution.**
- Extract a shared `CapabilityExecutionRequest` in `ironclaw_host_api` (or a new `ironclaw_capability_execution` crate). Have wasm/mcp/scripts implement the same interface.
- Mark `src/tools::Tool` as v1-only.
- Suggested owner: tools/runtime team.

### A4. Skills shim contains v1-only deprecated submodules with no `#[deprecated]`

**Ambiguity.** `src/skills/mod.rs:13-26` documents that `attenuation` and `bundled` are v1-only and "can be deleted" once v1 is gone — but no `#[deprecated]` attribute, and `src/agent/dispatcher.rs` still calls `attenuate_tools()` unconditionally.

**Evidence.** `src/skills/mod.rs:13-26`, `src/agent/dispatcher.rs` (callsite of `attenuate_tools`).

**Proposed resolution.**
- Add module-level `#![deprecated(since = "v1-end-of-life", note = "...")]` and `#[allow(deprecated)]` at the v1 callsites with a link to a v1-sunset tracking issue.
- Suggested owner: skills team.

### A5. `src/bridge/` is invisible in project-level `CLAUDE.md`

**Ambiguity.** `src/bridge/` is the v2 engine→host adapter (auth, effects, LLM, store) with its own `CLAUDE.md`, but the project-level `CLAUDE.md` Project Structure section never mentions it. New contributors will wire engine output directly into handlers instead of through `src/bridge/router.rs`.

**Evidence.**
- `src/bridge/CLAUDE.md` exists (20 lines, declares the adapter contract)
- Top-level `CLAUDE.md:83-217` Project Structure does not list `src/bridge/`

**Proposed resolution.**
- Add a `src/bridge/` row to the Project Structure table in top-level `CLAUDE.md`.
- Add to Module Specs table.
- Suggested owner: whoever owns bridge.

---

## Theme B — Reborn-vs-non-reborn naming is inconsistent

### B1. Two composition crates: `ironclaw_reborn` vs `ironclaw_reborn_composition`

**Ambiguity.** Both crates own reborn assembly:
- `ironclaw_reborn` (`src/lib.rs` ≈ 35 lines, mostly `pub mod`) — low-level drivers and adapters
- `ironclaw_reborn_composition` (`src/lib.rs` ≈ 726 lines, full runtime build) — facade

A caller unsure whether to depend on `reborn` (drivers) or `reborn_composition` (full runtime) will find both plausible.

**Evidence.**
- `crates/ironclaw_reborn/Cargo.toml:6` — "Standalone Reborn composition and adapters"
- `crates/ironclaw_reborn_composition/Cargo.toml:6` — "Facade-shaped production composition root"
- `crates/ironclaw_architecture/tests/reborn_dependency_boundaries.rs` enforces some part of this already

**Proposed resolution.**
- Rename `ironclaw_reborn` → `ironclaw_reborn_internals` OR add a top-of-file note in `ironclaw_reborn/CLAUDE.md`: "Internal. Only `ironclaw_reborn_composition` is a sanctioned public dependency."
- Extend the architecture test to log a clear error for boundary violations.
- Suggested owner: reborn team.

### B2. Three event crates, two without the reborn prefix

**Ambiguity.** `ironclaw_events`, `ironclaw_event_projections`, `ironclaw_reborn_event_store` — the "reborn" prefix appears on only one, but production only wires the reborn store. Either the first two should be renamed or documented as reborn-only.

**Evidence.**
- `crates/ironclaw_events/src/lib.rs:1-8`
- `crates/ironclaw_event_projections/src/lib.rs:1-6` (mentions reborn in docstring; name doesn't)
- `crates/ironclaw_reborn_event_store/src/lib.rs:1-8`

**Proposed resolution.**
- Rename `ironclaw_events` and `ironclaw_event_projections` to `ironclaw_reborn_events*` to match the reborn-only-in-production reality, OR add explicit CLAUDE.md notes forbidding non-reborn dependencies.
- Suggested owner: events team.

### B3. `RebornCompositionProfile` lives in the composition crate, but is a config concern

**Ambiguity.** `RebornCompositionProfile` (Disabled/LocalDev/Production/MigrationDryRun) is defined in `ironclaw_reborn_composition::profile`. Outer harnesses or v1 AppBuilder that want to pick a profile must depend on the composition crate just for an enum.

**Evidence.**
- `crates/ironclaw_reborn_composition/src/profile.rs`
- `crates/ironclaw_reborn_composition/src/factory.rs:60-66`

**Proposed resolution.**
- Move `RebornCompositionProfile` to `ironclaw_reborn_config` (which already owns runtime identity + poll settings). Composition imports it; outer harnesses can depend on config alone.
- Suggested owner: reborn team.

---

## Theme C — Policy / auth concept overload (`safety`/`trust`/`authorization`/`capabilities`/`approvals`/`runtime_policy`)

Six crates carry a piece of "what is this thing allowed to do." No shared trait spans them; new policies risk reinventing the wheel.

### C1. `ironclaw_capabilities` has Cargo dependency on `ironclaw_dispatcher` that its own CLAUDE.md forbids

**Ambiguity.** `crates/ironclaw_capabilities/CLAUDE.md:3-4` says "use the neutral `CapabilityDispatcher` port; do not add a normal dependency on concrete `ironclaw_dispatcher`." But `crates/ironclaw_capabilities/Cargo.toml:8-26` declares `ironclaw_dispatcher` as a *production* dependency. Either the doc is stale or the design is unfinished.

**Evidence.** `crates/ironclaw_capabilities/Cargo.toml:8-26`, `crates/ironclaw_capabilities/CLAUDE.md:3-4`, `crates/ironclaw_capabilities/src/lib.rs:1-30` (no `ironclaw_dispatcher` imports in public API).

**Proposed resolution.**
- Either move `ironclaw_dispatcher` to dev-deps, or update `CLAUDE.md` to document the exception with rationale.
- Suggested owner: capabilities team.

### C2. Three policy concepts with no shared interface — `authorization` vs `trust` vs `runtime_policy`

**Ambiguity.** Each crate has its own policy type (`CapabilityLease`, `EffectiveTrustClass`, `EffectiveRuntimePolicy`). Composition order matters (trust → runtime policy → grant/lease), but is not encoded in a trait. New policy layers can drift.

**Evidence.**
- `crates/ironclaw_trust/src/lib.rs:44-50`
- `crates/ironclaw_authorization/src/lib.rs:37-57`
- `crates/ironclaw_runtime_policy/src/lib.rs:1-47`

**Proposed resolution.**
- Add `crates/ironclaw_authorization/POLICY-COMPOSITION.md` documenting the ordering invariant and providing example flows.
- Consider a marker trait `trait PolicyResult: Send + Sync` as a hint that a new policy is "another in the chain".
- Suggested owner: security/policy team.

### C3. Lease type ownership crosses two crates ambiguously

**Ambiguity.** `CapabilityLease` is defined in `ironclaw_authorization` but issued by `ironclaw_approvals::ApprovalResolver::approve_dispatch()`. If a new approval flavor wants its own lease subtype, it's unclear which crate owns the definition.

**Evidence.**
- `crates/ironclaw_authorization/src/lib.rs:167-192` defines the lease
- `crates/ironclaw_approvals/src/lib.rs:6-7, 45-58` imports the store and calls `leases.issue(...)`

**Proposed resolution.**
- Formalize in `ironclaw_authorization/CLAUDE.md`: all lease types live in authorization; approvals may only extend the *store* trait.
- Suggested owner: authorization team.

### C4. `ironclaw_safety` scope is vague (4 concerns in one crate)

**Ambiguity.** Per `Cargo.toml:6`, `ironclaw_safety` covers prompt injection + input validation + secret-leak detection + safety policy enforcement. "Data exfiltration policy" or similar future features could plausibly belong here or in authorization/trust.

**Evidence.** `crates/ironclaw_safety/Cargo.toml:6`, `crates/ironclaw_safety/src/lib.rs:10-24`.

**Proposed resolution.**
- Document in `ironclaw_safety/CLAUDE.md` that scope is **data-in-motion defense** (inbound payloads, tool outputs); capability/grant/trust policy lives elsewhere.
- Optional: rename to `ironclaw_intake_safety` to signal scope.
- Suggested owner: safety team.

### C5. `ironclaw_runtime_policy` re-exports asymmetrically

**Ambiguity.** The crate re-exports `EffectiveRuntimePolicy` from `ironclaw_host_api` (because it's in the resolver's return type) but tells callers to import other vocab directly from `host_api`. A caller hits `ironclaw_runtime_policy::RuntimePolicy` (doesn't exist) before learning the rule.

**Evidence.** `crates/ironclaw_runtime_policy/src/lib.rs:40-47`.

**Proposed resolution.**
- Either re-export the full `ironclaw_host_api::runtime_policy::*` namespace, or add a `Note:` block at the top of `lib.rs` explaining the asymmetry.
- Suggested owner: runtime_policy team.

---

## Theme D — Storage / state crate overlap

### D1. `src/workspace/` vs `ironclaw_memory` boundary breached by a direct import

**Ambiguity.** `ironclaw_memory/CLAUDE.md` forbids depending on `src/workspace`. Yet `src/workspace/reborn_identity_context.rs` imports from `ironclaw_memory`. No CLAUDE.md says which layer owns `memory_write` routing.

**Evidence.**
- `src/workspace/reborn_identity_context.rs` — `use ironclaw_memory::DEFAULT_PROMPT_PROTECTED_PATHS;`
- `crates/ironclaw_memory/CLAUDE.md:1-5`
- `src/workspace/CLAUDE.md` (no mention of v2 coexistence)

**Proposed resolution.**
- Update `src/workspace/CLAUDE.md`: "v1-only. v2 memory uses `ironclaw_memory`. The `reborn_identity_context.rs` import is a temporary v1→v2 bootstrap; tracked in <issue>."
- File the tracking issue.
- Suggested owner: workspace/memory team.

### D2. `src/db/` + `src/workspace/` still `pub mod` despite "dissolution" commits

**Ambiguity.** Recent commits ("universal FS dispatch", "src/db/ dissolution pass") suggest these are being phased out, but they remain `pub mod` at `src/lib.rs`. Status (active, shimmed, frozen) is undeclared.

**Evidence.**
- `src/lib.rs` still exports `pub mod db` and `pub mod workspace`
- `crates/ironclaw_memory/CLAUDE.md` calls them "reference material only"
- `crates/ironclaw_reborn_event_store/src/lib.rs:18-19` mentions dissolution

**Proposed resolution.**
- Add a "Legacy modules" section to top-level `CLAUDE.md` enumerating modules by status: active / shimmed / frozen.
- Or move to `legacy_compat/` crate with deprecation attributes.
- Suggested owner: storage/state team.

### D3. `src/secrets/` and `crates/ironclaw_secrets/` coexist with no documented relationship

**Ambiguity.** Both have full implementations. Project-level `CLAUDE.md` does not declare which is authoritative.

**Evidence.** `src/lib.rs` (`pub mod secrets`), `crates/ironclaw_secrets/CLAUDE.md:1-5`.

**Proposed resolution.**
- Pick one as authoritative; mark the other as frozen reference (or migrate fully). Document in both CLAUDE.md files.
- Suggested owner: secrets team.

### D4. `ironclaw_processes` vs `ironclaw_run_state` — parallel "currently running" types

**Ambiguity.** `ProcessStatus` (4 states) and `RunStatus` (5 states) overlap semantically but share no type. A new contributor will not know which one to extend with a new state.

**Evidence.**
- `crates/ironclaw_processes/src/types.rs` (`ProcessStatus`)
- `crates/ironclaw_run_state/src/lib.rs:34-40` (`RunStatus`)
- Neither crate depends on the other

**Proposed resolution.**
- Document in both crates' `CLAUDE.md`: `run_state` owns invocation-wide lifecycle (can block); `processes` owns isolated capability process (terminal failures only).
- Composition fuses them via `(invocation_id, process_id)`.
- Suggested owner: runtime team.

### D5. `threads` vs `turns` vs `conversations` — chat-history three-way overlap

**Ambiguity.** `ironclaw_threads` (messages + redaction), `ironclaw_turns` (turn coordination + run state), `ironclaw_conversations` (binding + inbound dispatch). `SessionThreadService` is exported from both `threads` and `conversations`.

**Evidence.**
- `crates/ironclaw_threads/src/lib.rs:22`
- `crates/ironclaw_conversations/src/lib.rs:34`
- All three CLAUDE.md files describe their own scope but no cross-reference

**Proposed resolution.**
- Add a "Three-Layer Transcript Model" section to top-level `CLAUDE.md` or to all three crate CLAUDE.md files:
  - `threads` = message-level CRUD + redaction (no turn knowledge)
  - `turns` = turn state + run coordination (no message shape knowledge)
  - `conversations` = binding + inbound routing (no message internals)
- Remove the `SessionThreadService` re-export from `conversations`.
- Suggested owner: chat-history team.

---

## Theme E — Extension / tool / adapter / channel concept overload

### E1. "Extension" used at three layers with three meanings

**Ambiguity.** The word "extension" means three different things:
1. `ironclaw_extensions::ExtensionRuntime` — manifest-level capability metadata (WASM/Script/MCP/FirstParty/System)
2. `ironclaw_product_adapter_registry::ExtensionInstallationStore` / `ExtensionActivationState` — *ProductAdapter* installations
3. CLAUDE.md "Extension/Auth Invariants" — user-facing identity (`extension_name = telegram | gmail`) routed to setup UI

**Evidence.**
- `crates/ironclaw_extensions/src/lib.rs:78-99`
- `crates/ironclaw_product_adapter_registry/src/lib.rs`
- top-level `CLAUDE.md:35-57`

**Proposed resolution.**
- Rename `product_adapter_registry`'s `Extension*` types to `ProductAdapterInstallation*`.
- Reserve "extension" for the manifest-level capability concept (1).
- Add `ExtensionName` and `CredentialName` newtypes in `ironclaw_common`.
- Suggested owner: extensions/adapters team.

### E2. `ProductAdapter` vs `Channel` — which abstraction owns Telegram?

**Ambiguity.** `ironclaw_product_adapters` defines `ProductAdapter`. `channels-src/telegram/` compiles to a WASM `sandboxed-channel`. `ironclaw_telegram_v2_adapter` is a native Rust ProductAdapter. The WIT `wit/channel.wit` declares a separate `channel-host` interface. Which is authoritative for new integrations?

**Evidence.**
- `crates/ironclaw_telegram_v2_adapter/Cargo.toml:6`
- `channels-src/telegram/Cargo.toml:1-2`
- `wit/channel.wit:1-34`

**Proposed resolution.**
- Formalize `ProductAdapter` (`ironclaw.product_adapter/v1`) as the new contract; document `Channel` (`ironclaw.channel/v1`) as legacy. New integrations use ProductAdapter manifests. Document the migration path for `channels-src/*`.
- Suggested owner: extensions/adapters team.

### E3. Three Telegram implementations on disk

**Ambiguity.**
1. `crates/ironclaw_telegram_v2_adapter/` (WASM, in workspace) — current product adapter
2. `crates/ironclaw_reborn_telegram_v2_host/` (on disk, **excluded from workspace**, contains only a `migrations/` folder)
3. `channels-src/telegram/` (WASM channel, excluded)

Commit `af0ef699e` consolidated the host into the reborn binary but never deleted the directory.

**Evidence.**
- Top-level `Cargo.toml:2-44` workspace `members` + `exclude` lists
- `crates/ironclaw_reborn_telegram_v2_host/` — directory contents
- git log of `af0ef699e`

**Proposed resolution.**
- Delete `crates/ironclaw_reborn_telegram_v2_host/` (orphaned).
- Document in `ironclaw_reborn_composition/CLAUDE.md` which Telegram path is production (adapter vs legacy channel).
- Suggested owner: telegram/channels team.

### E4. Three WASM crates with unclear split rationale

**Ambiguity.** `ironclaw_wasm` (tool runtime), `ironclaw_wasm_sandbox_core` (Wasmtime primitives), `ironclaw_wasm_product_adapters` (adapter host glue). The split is not enforced by tests — a violation would compile.

**Evidence.**
- `crates/ironclaw_wasm/Cargo.toml:7-13`
- `crates/ironclaw_wasm_sandbox_core/Cargo.toml` (no `ironclaw_*` deps — clean core)
- `crates/ironclaw_wasm_product_adapters/Cargo.toml:13-27`

**Proposed resolution.**
- Add `crates/ironclaw_architecture/tests/wasm_crate_boundaries.rs` to assert:
  - `wasm_sandbox_core` has zero IronClaw deps
  - `wasm_product_adapters` does NOT depend on `ironclaw_wasm` directly
- Document each crate's scope in its `CLAUDE.md`.
- Suggested owner: wasm team.

### E5. Channel ownership scattered across four locations

**Ambiguity.** "Channel" lives in:
1. `src/channels/` (Channel trait + TUI/HTTP/REPL/webhook impls)
2. `crates/ironclaw_gateway/` (frontend assets + widgets — *not* transport)
3. `crates/ironclaw_tui/` (Ratatui library — not a Channel impl)
4. `channels-src/` (WASM channels: discord/slack/feishu/wechat/whatsapp, all excluded)

`ironclaw_gateway` lacks a CLAUDE.md. `src/channels/web/CLAUDE.md` claims web ownership.

**Evidence.**
- `src/channels/mod.rs:1-60`
- `crates/ironclaw_gateway/src/lib.rs:1-40`
- `crates/ironclaw_tui/Cargo.toml:1-15`
- top-level `Cargo.toml:3-9` (channels-src excluded)
- `src/channels/web/CLAUDE.md:1-34`

**Proposed resolution.**
- Add `crates/ironclaw_gateway/CLAUDE.md` declaring scope ("Frontend asset bundling + widget catalog; not a Channel impl"). Optionally rename to `ironclaw_frontend`.
- Document in top-level `CLAUDE.md`: `src/channels/` owns the Channel trait + legacy implementations; gateway/tui crates are *adapters* that delegate to runtime/composition; `channels-src/` is out-of-tree.
- Suggested owner: channels team.

---

## Theme F — `ironclaw_host_api` is becoming a god-crate

### F1. `host_api` is depended on by every workspace crate (47/47) and contains 5,245 lines of code

**Ambiguity.** Healthy "shared vocabulary" crates are small (IDs, enums, error types). `ironclaw_host_api/src/lib.rs:14-31` declares 16 public modules; two of them — `ingress.rs` (1,040 LOC, HTTP route validation) and `runtime_policy.rs` (849 LOC, policy enums + resolver hints) — are concrete behavior, not vocabulary. They could grow into HTTP plumbing and policy logic that no other system-service crate owns.

**Evidence.**
- `crates/ironclaw_host_api/src/lib.rs:1-32`
- `crates/ironclaw_host_api/src/ingress.rs:1-80`
- `crates/ironclaw_host_api/src/runtime_policy.rs:1-80`

**Proposed resolution.**
- Extract `ingress` to a new `ironclaw_http_dispatch` crate.
- Confirm `runtime_policy` vocab is consumed by `ironclaw_runtime_policy` only and consider folding it back in there.
- `host_api` should remain IDs, scope, capability, path, audit, decision, action, mount — the language no other crate owns.
- Suggested owner: host-api team.

### F2. `host_api` vs `host_runtime` — layering split is implicit

**Ambiguity.** `host_api` is vocabulary; `host_runtime` is composition (~24 deps). The names don't make the split obvious; "host_api" sounds like an API surface, not a constraint dictionary. A new contributor adding "a host service" will not know which to extend.

**Evidence.**
- `crates/ironclaw_host_api/src/lib.rs:1-32`
- `crates/ironclaw_host_runtime/src/lib.rs:1-50`
- `crates/ironclaw_host_runtime/CLAUDE.md` / `crates/ironclaw_host_api/CLAUDE.md`

**Proposed resolution.**
- Rename `host_api` → `host_contracts`, `host_runtime` → `host_composition`. OR add a "Host Layer" section to top-level `CLAUDE.md` explaining the split with examples.
- Suggested owner: host-api team.

### F3. `ironclaw_event_projections` imports memory-specific types into production code

**Ambiguity.** Event projections should emit generic read-models. `ironclaw_event_projections/Cargo.toml:10-12` declares `ironclaw_memory` as a production dep and `src/lib.rs:24-29` imports `MemorySignificantEventSink`, `PromptWriteSafetyEventSink` directly. This couples a substrate crate to a domain crate.

**Evidence.**
- `crates/ironclaw_event_projections/Cargo.toml:10-12`
- `crates/ironclaw_event_projections/src/lib.rs:24-29`
- `crates/ironclaw_memory/CLAUDE.md` declares its scope

**Proposed resolution.**
- Invert: `ironclaw_memory` registers its sinks with the projection loop via composition; `ironclaw_event_projections` exposes only generic types (`ThreadTimeline`, `RunStatusProjection`, `EventKind`).
- Suggested owner: events team + memory team.

---

## Theme G — Orphans and excluded directories

### G1. `ironclaw_outbound` has zero callers anywhere in the workspace

**Ambiguity.** The crate defines `OutboundPolicyService`, `ReplyTargetBindingValidator`, etc., with a detailed CLAUDE.md, but grep for `ironclaw_outbound` (and for `OutboundPolicyService`) finds zero callsites in `src/` or any composition crate.

**Evidence.**
- `crates/ironclaw_outbound/Cargo.toml:1-12`
- grep `ironclaw_outbound` workspace-wide → only the crate's own `Cargo.toml`
- `crates/ironclaw_outbound/CLAUDE.md` (comprehensive guardrails, but no consumer)

**Proposed resolution.**
- Either integrate `outbound` into reborn composition / turn scheduler, or mark with `#[doc(hidden)]` until then and reference the tracking issue.
- Suggested owner: outbound team.

### G2. `crates/ironclaw_reborn_telegram_v2_host/` is on disk but excluded from workspace

See E3.

### G3. `src/tunnel/` is the only public-internet exposure layer with no crate

**Ambiguity.** Every other major subsystem (channels, gateway, network) has a crate equivalent. `src/tunnel/` (cloudflare, ngrok, tailscale, custom, none) stays in `src/`. Either there's a reason (no contract worth a crate) or it's an oversight.

**Evidence.** Top-level `CLAUDE.md:121-128` (tunnel section), `src/tunnel/`.

**Proposed resolution.**
- Decide: keep in `src/` and add a one-line `src/tunnel/CLAUDE.md` declaring "no crate planned, stable scope", OR extract to `ironclaw_tunnel`.
- Low impact; just don't leave it ambiguous.
- Suggested owner: tunnel team.

---

## Theme H — Misc

### H1. `ironclaw_network` scope is narrow but name is broad

**Ambiguity.** The crate owns HTTP egress + DNS/private-IP policy enforcement. The name suggests "all networking." Only `host_runtime` depends on it.

**Evidence.** `crates/ironclaw_network/Cargo.toml:1-16`, `crates/ironclaw_network/src/lib.rs:1-27`.

**Proposed resolution.**
- Rename to `ironclaw_http_egress_policy` OR document the narrow scope in `CLAUDE.md`.
- Suggested owner: network team.

---

## Cross-cutting recommendations

1. **Status matrix.** Add a single section to top-level `CLAUDE.md` (or a new `docs/CRATES.md`) listing every workspace crate + every `src/<x>/` module with a status: **canonical**, **legacy (v1)**, **shim**, **frozen**, or **orphan**. Auto-generated from `cargo metadata` + a small audit script if possible. This is the single fastest fix for autonomous-agent confusion.

2. **CLAUDE.md per crate.** Of the 47 crates, several have no `CLAUDE.md` (`ironclaw_gateway`, `ironclaw_network`, more). Make CLAUDE.md a required file for every crate in the workspace.

3. **Architecture tests.** `crates/ironclaw_architecture/tests/` already encodes some boundary rules. Extend it to cover the boundaries surfaced in this audit (WASM crate split, capabilities ↛ dispatcher, event projections ↛ memory, etc.).

4. **Concept glossary.** A short top-level glossary (`docs/GLOSSARY.md`) defining "extension", "product adapter", "channel", "tool", "lease", "policy", "capability", "process", "run", "turn", "thread", "conversation" — one paragraph each, with the canonical owning crate named.

---

## How to engage with this audit

- The companion GitHub issue holds one checkbox per finding. Comment on the issue with your team's position; mark resolved findings off as they land.
- This doc lives on the `audit/crate-boundaries` branch. Counter-proposals welcome as PR comments.
- The 8 themes are mostly independent; resolving them can happen in parallel.
- The cross-cutting recommendations (status matrix, glossary, architecture tests) should be tackled first — they make the per-finding fixes mechanical.
