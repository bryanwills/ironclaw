# Reborn Learning System — "Learn From Mistakes, Never Repeat" (Hermes-parity)

**Status:** approved for implementation (single PR, multi-agent parallel via Codex gpt-5.5 xhigh)
**Date:** 2026-06-14
**Branch:** `claude/reborn-learning-system` (off `origin/main`)
**Owner:** firat

## 1. Goal

Bring **Hermes Agent's** "it never makes the same mistake twice" capability to the IronClaw **reborn** stack. The agent must:

1. **Learn in-turn** — capture durable learnings (facts, corrections, preferences, dismissed false-positives) as it works, with confidence and recency, so future turns recall them.
2. **Reflect automatically after a turn** — a background pass reviews what just happened and writes/patches memory or skills so the *next* session starts already knowing — without the user re-steering.
3. **Never poison itself** — never persist environment-dependent failures, transient errors, or negative capability claims; capture the *fix*, not the failure.
4. **Curate over time** — decay stale confidence, consolidate duplicates, archive (never delete).

This is the competitor-parity goal vs Hermes (NousResearch/hermes-agent). The `nearai/benchmarks` suite `datasets/ironclaw/v1/09-learning-system` (60 trajectory scenarios across confidence-scoring, confidence-decay, dedup-correction, fp-learning-loop, cross-project, learn-management) is the **behavioral reference** for the in-turn half — we fold its behaviors in, but we implement them in **reborn** (the benchmark currently targets the v1 library; matching the benchmark harness is out of scope for this PR).

## 2. What already exists in reborn (build on it — do not rebuild)

Recon (file:line) — these are on `main`:

| Capability | Where |
|---|---|
| Memory persistence (multi-tenant, scoped) | `crates/ironclaw_memory/` — `MemoryDocumentRepository`, filesystem + in-memory backends; `crates/ironclaw_memory/CLAUDE.md` |
| Memory tools | `crates/ironclaw_host_runtime/src/first_party_tools/memory.rs` — `builtin.memory_search/read/write/tree`; registered in `first_party_tools/mod.rs` `builtin_first_party_base_registry()` |
| Memory→prompt injection | `crates/ironclaw_host_runtime/src/memory_context.rs` — `ProductionMemoryPromptContextService::load_memory_snippets()`; scope from `memory_context.rs:115` |
| Identity files in system prompt | `src/workspace/reborn_identity_context.rs` — `STABLE_IDENTITY_PATHS` (SOUL/AGENTS/IDENTITY/TOOLS/BOOTSTRAP), `PERSONAL_IDENTITY_PATHS` (USER/ASSISTANT_DIRECTIVES); `HostIdentityContextSource::load_identity_candidates()` |
| Prompt assembly port | `crates/ironclaw_agent_loop/src/executor/prompt.rs:101` `build_prompt_bundle_for_surface` → `ctx.host.build_prompt_bundle(...)`; `LoopPromptBundleRequest` (`crates/ironclaw_turns/src/run_profile`) |
| Skills (selection + tools) | `crates/ironclaw_turns/src/run_profile/skill_context.rs`; `crates/ironclaw_host_runtime/src/first_party_tools/skill_management.rs` (`builtin.skill_list/install/remove`) |
| Capability surface narrowing | `crates/ironclaw_host_runtime/src/surface.rs` `CapabilitySurfacePolicy` (allowed_runtimes/effects, max_capabilities); strategy `crates/ironclaw_agent_loop/src/strategies/capability.rs` |
| Run profiles | `crates/ironclaw_turns/src/run_profile/snapshot.rs` `ResolvedRunProfile` (`capability_surface_profile_id`, `resource_budget_policy`, `personal_context_policy`, `steering_policy`); resolver `run_profile/resolver.rs` |
| Turn-completed lifecycle hook | `crates/ironclaw_turns/src/lifecycle.rs` `complete_run()` → `publish_state`; `TurnCommittedEventObserver`/`TurnEventSink` (`crates/ironclaw_turns/src/events.rs`); subscribe in `crates/ironclaw_reborn_composition` runtime composition |
| System-initiated non-user-facing run precedent | `crates/ironclaw_reborn_composition/src/trigger_poller_trusted_submit.rs` + trigger poller spawn; `TurnCoordinator::submit_turn` |
| Durable event log (read-back) | `crates/ironclaw_reborn_event_store/` `DurableEventLog::read_after_cursor`; transcript finalize `LoopTranscriptPort::finalize_assistant_message` (`crates/ironclaw_turns/src/run_profile/host.rs`) |
| v1 reference (port ideas, not code) | `docs/internal/self-improvement.md`; `crates/ironclaw_engine/src/executor/trace.rs`; `crates/ironclaw_engine/prompts/mission_*.md` (lesson-extraction, skill-repair, conversation-insights) |

**Net:** the memory + skills + prompt substrate exists. This PR adds (A) **learning semantics + persona** on top of it, and (B) the **reflection loop + curator** that make learning automatic.

## 3. Gaps this PR closes

1. No **learning persona** in the reborn system prompt → baseline agent doesn't assign confidence, supersede on correction, surface staleness, scope per project, or track FPs.
2. `memory_write` has no **supersede/correction** semantics that guarantee the old value disappears from search ("no-ghost"); search isn't **confidence/recency-aware** (decay); export doesn't **redact secrets**.
3. No **post-turn reflection** — nothing reviews a completed turn to write/patch memory or skills automatically.
4. No **reflection run profile** that constrains a background run to memory/skill tools, caps iterations, and suppresses user delivery.
5. No **curator** to decay confidence over time and consolidate/archive.
6. No way for a background run to **read the just-completed transcript** (recon flagged the ref→content materialization gap).

## 4. Design

### 4.1 Learning model (the durable unit)

A **learning** is a markdown memory document under a `learnings/` tree (per benchmark convention) with YAML frontmatter:

```markdown
---
confidence: 8            # 1–10, source reliability × specificity
original_confidence: 9   # set when decayed below original
created_at: 2026-06-14
updated_at: 2026-06-14
category: db|ci|preference|fp|...   # for category-scoped dedup
key: ci-timeout           # stable dedup key (supersede target)
source: user|reflection|correction
shared: false             # project-scoped by default; true = shared
superseded_by: <doc-id>   # set on the OLD doc when corrected
---
<the learning, declarative>
```

False-positives are learnings with `category: fp` under `fp-database/`, carrying the dismissed pattern + reason.

Rules (Hermes anti-poisoning, baked into prompt + enforced where mechanical):
- **Declarative facts, not imperatives** ("User prefers X", never "Always do X").
- **Never store**: environment-dependent failures ("command not found"), transient errors that a retry fixed (store the retry pattern instead), negative capability claims ("tool X doesn't work"). Store the **fix**.
- **7-day-staleness intuition** → confidence decay, not deletion.
- **User frustration/corrections are first-class** → supersede the relevant learning/skill.

### 4.2 Two layers

**Layer A — In-turn learning (benchmark behaviors, reborn-native).**
The agent, in normal turns, uses `memory_*` to save/supersede/search/report learnings, driven by:
- **WS-A1 memory semantics**: supersede-on-correction (no-ghost), confidence+recency-weighted search ranking, category-scoped dedup, project-scope enforcement, secret redaction on export.
- **WS-A2 learning persona + `/learn`**: a default learning preamble in the reborn system prompt (so empty-identity behavior is correct) + a `/learn` management behavior (stats/prune/search/export) over the memory tools.

**Layer B — Automatic reflection (the "never repeat" engine).**
- **WS-B1 reflection run profile**: a `ResolvedRunProfile` ("reflection") that narrows the capability surface to `{memory_*, skill_*}`, caps iterations (~16) and model calls, sets `personal_context_policy = Excluded`, `steering_policy.allow_steering = false`, and is marked non-user-facing (no outbound delivery).
- **WS-B2 reflection orchestrator**: a `TurnCommittedEventObserver` (best-effort sink) that, on `Completed`/`Failed` and on a cadence (every N turns, configurable), spawns a reflection run via the trusted-submit precedent with the reflection profile and a reflection prompt; config-flagged (`[reflection] enabled`, cadence). The reflection prompt carries the anti-poisoning rules + patch-skill-first discipline (ported from `mission_*.md` ideas, condensed).
- **WS-B3 reflection input**: a read path so the reflection run sees the just-completed conversation (resolve the turn's message refs → content, or feed it via the spawn prompt materializer). Fail-closed: if transcript can't be read, the reflection run no-ops.
- **WS-B4 curator**: a periodic/idle pass (config-flagged) that decays `confidence` by age, consolidates duplicate-key learnings (keep highest-confidence/newest, archive the rest under `learnings/.archive/`), and prunes/archives — **never deletes** (honors the "LLM data is never deleted" invariant).

### 4.3 Safety / invariants
- Reflection + curator runs are **constrained** (whitelisted capabilities, capped budget, no user delivery, scoped to the same tenant/user/agent/project as the source turn).
- Memory writes go through the existing `PromptWriteSafetyPolicy` (protected identity paths) + a new secret-redaction pass on export.
- Project-scope isolation: search/read never returns another project's private learnings (benchmark `cross-project/*`).
- Reflection is **best-effort**: it must never block, delay, or fail the user-facing turn (mirror Part-1's best-effort explanation discipline).
- No `.unwrap()`/`.expect()` in prod; both memory backends (filesystem + in-memory; libsql/postgres parity where the store has them) stay at parity; new wire enums snake_case + `#[serde(default)]` + legacy round-trip.

## 5. Workstreams (parallelization plan)

Dependency graph: **WS-B1 (profile contract)** and **WS-A1 (memory semantics)** are the roots. Then `{WS-A2, WS-B2, WS-B3}` parallel; **WS-B4** after WS-A1; **WS-C** last. Crate ownership is mostly disjoint.

### WS-A1 — Memory learning semantics (`crates/ironclaw_memory` + memory tool handler in `crates/ironclaw_host_runtime/src/first_party_tools/memory.rs`)
1. Frontmatter model (confidence/original_confidence/created_at/updated_at/category/key/shared/superseded_by) — parse/serialize; tolerate learnings without it.
2. `memory_write` supersede mode: writing a learning with an existing `key` (or explicit supersede target) marks the old doc `superseded_by` and excludes it from default search results (no-ghost) while retaining it on disk.
3. `memory_search` ranking: confidence- and recency-weighted; decayed/superseded entries rank low and are flagged, never dropped from explicit lookups (`decay-preserves-not-deletes`); project-scope filter by default.
4. Export with secret redaction: a read/export path that flags/redacts credentials, passwords, API keys, connection-strings-with-passwords as `[REDACTED - sensitive]`.
5. Category-scoped dedup + project-scope enforcement helpers.
TDD: unit tests in `ironclaw_memory` mirroring `dedup-correction/*` (no-ghost, triple-update-latest-wins, category-scoped), `confidence-decay/*` (decay flags not deletes, fresh>stale), `learn-management/export-sanitizes-secrets`, `cross-project/project-scoped-default`.

### WS-A2 — Learning persona + `/learn` surface (prompt files + `crates/ironclaw_host_runtime` prompt/identity wiring)
1. A default learning-system preamble (prompt file, `include_str!`) injected as a stable identity candidate so baseline behavior (empty per-scenario identity) assigns confidence, surfaces staleness, supersedes on correction, scopes per project, tracks FPs, and supports `/learn`.
2. `/learn` management behavior: stats (count, avg confidence, high/med/low buckets, oldest/newest), prune (stale, protect critical), search (keyword/confidence-range), export. Prefer prompt-driven over the existing `memory_*` tools; add a host helper only if a behavior can't be expressed over the tools.
TDD: reborn-tier behavior tests (drive a run with the persona + seeded `learnings/*.md`, assert tool use + response shape) covering `confidence-scoring/*`, `learn-management/*`, `fp-learning-loop/*`.

### WS-B1 — Reflection run profile + capability whitelist (`crates/ironclaw_turns/src/run_profile` + `crates/ironclaw_host_runtime/src/surface.rs` + capability surface profile registration)
1. Define a `reflection` run-profile (capability_surface_profile_id, resource_budget caps, personal_context Excluded, steering off, non-user-facing marker).
2. A capability surface profile that resolves to only `builtin.memory_*` + `builtin.skill_*` (FirstParty runtime, Read/WriteFilesystem effects), `max_capabilities` bounded.
TDD: surface tests asserting a reflection-profile run sees exactly the whitelisted capabilities and nothing else; budget caps enforced.

### WS-B2 — Reflection orchestrator + trusted submit + prompts (`crates/ironclaw_reborn_composition` + `crates/ironclaw_reborn_config`)
1. `ReflectionOrchestrator`: `TurnCommittedEventObserver` (best-effort) on `Completed`/`Failed`, cadence-gated (per-thread turn counter), spawns a reflection run via a trusted submitter (mirror `trigger_poller_trusted_submit.rs`) with the reflection profile, reserved `source_binding_ref`/`reply_target_binding_ref` (no delivery), idempotency-keyed by `(source_run_id, reflection)`.
2. Reflection prompt files (`prompts/reflection_*.md`): anti-poisoning DO-NOT-CAPTURE list, patch-skill-first preference order, declarative-facts rule, "store the fix not the failure", user-frustration-as-signal.
3. Config section `[reflection]` (enabled default false, cadence N, max concurrent, model slot) in `ironclaw_reborn_config`; wire construction + subscription in runtime composition (`crates/ironclaw_reborn_composition/src/runtime.rs` near trigger-poller spawn).
TDD: orchestrator test (fake coordinator) — on Completed at cadence, exactly one reflection run submitted with the reflection profile + no reply target; disabled by config → none; never blocks the source turn.

### WS-B3 — Reflection transcript read (`crates/ironclaw_turns` host port + `crates/ironclaw_reborn_event_store` / loop_support adapter)
1. A read path to materialize the just-completed turn's conversation for the reflection run (resolve reply/result message refs → content, or assemble from the durable event log). Fail-closed → reflection no-ops if unavailable.
2. Feed the conversation to the reflection run (via the spawn prompt materializer or an injected context candidate).
TDD: read-path test (seed a completed turn's transcript, assert reflection input contains the user+assistant messages); missing-transcript → no-op.

### WS-B4 — Curator (`crates/ironclaw_reborn_composition` + `crates/ironclaw_memory` decay helpers)
1. Periodic/idle curator (config-flagged): decay `confidence` by age (write `original_confidence` once), consolidate duplicate-key learnings (keep best, archive rest under `learnings/.archive/`), prune/archive stale — never delete.
2. Scheduler wiring (reuse the trigger-poller-style background worker + cancellation token).
TDD: curator unit tests (age → decayed confidence with original preserved; duplicate keys → one current + archived; archive recoverable).

### WS-C — Reflection-loop E2E + benchmark-equivalent integration tests (`crates/ironclaw_reborn*/tests`)
1. **Never-repeat E2E**: run a turn where the agent makes a correctable mistake / the user corrects it → reflection writes a learning → a fresh turn recalls it and behaves correctly. This is the headline Hermes-parity test.
2. Port a representative subset of `09-learning-system` scenarios as reborn integration tests (confidence save+report, decay-visible, correction-no-ghost, fp-dismiss-not-reflagged, project-scoped-default, /learn stats).
Quality gate: `cargo fmt`, `cargo clippy --all --tests --all-features` (zero warnings), `cargo test`.

## 6. Acceptance criteria
1. Baseline reborn agent (no per-scenario identity) saves a learning with a confidence score and reports it; recalls it later; surfaces staleness for old learnings; never deletes on decay.
2. Correcting a learning makes the old value unreachable via default search (no-ghost) while retained on disk.
3. A dismissed false-positive is not re-flagged for the same pattern; generalizes only on exact pattern match.
4. Learnings are project-scoped by default; no cross-project secret leakage; `/learn export` redacts secrets.
5. After a turn, a constrained reflection run (memory/skill tools only, no user delivery, capped budget) runs best-effort and can write/patch a learning; disabled by config when off; never blocks the user turn.
6. The never-repeat E2E passes: mistake/correction in turn N → correct behavior in turn N+1 via reflected learning.
7. Curator decays/consolidates/archives without deleting; both memory backends at parity.
8. Zero clippy warnings; all tests green; reflection/curator are feature-flagged off by default.

## 7. Out of scope (this PR)
- Matching the `nearai/benchmarks` harness runner itself (it targets the v1 library); we implement equivalent behavior in reborn and test it with reborn-native tests.
- Vector/embedding episodic search (use existing memory search + event log); FTS over full conversation history is a follow-up.
- DSPy/GEPA offline skill evolution (Hermes' separate repo) — future.
