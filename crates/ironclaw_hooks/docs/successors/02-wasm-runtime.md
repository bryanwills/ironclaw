# Successor PR: WASM hook execution path

> Successor work from PR #3573. The manifest schema already accepts
> `HookManifestBody::Wasm`; the registrar rejects it with
> `RegistryConstruction` for now. This PR makes WASM hook bodies
> executable inside a `wasmtime` sandbox.

## Scope

Add a programmatic-hook execution path for Installed-tier hooks. The
WASM module exports a function (`evaluate` for capability/prompt
points, observer-specific for after-* points) and the dispatcher
invokes it inside a sandbox with the hook context as input and a typed
sink as host imports.

## What lands in this PR

1. **`crates/ironclaw_hooks/src/wasm/` module** with:
   - `WasmHookRuntime`: wasmtime store + instance per hook invocation.
   - Host imports: typed shims for `RestrictedGateSink` / `RestrictedMutatorSink`
     / observer sink.
   - Budget enforcement via `wasmtime` fuel + memory + wall-clock timeout
     (manifest's `WasmBudget` already declares all three).
2. **`HookManifestBody::Wasm`** routes through the new runtime. The
   registrar's current "WASM not implemented" rejection is removed.
3. **`HookId::for_wasm`** identity derivation pinning the module bytes
   (so a swapped module produces a different `HookId` and breaks
   checkpoint replay safely).
4. **New threat model**: `crates/ironclaw_hooks/docs/threat-model-wasm.md`
   covering the wasmtime boundary, host-import surface, time/memory
   exhaustion, side-channels.

## What this PR does NOT do

- Module signing / supply-chain checks. Those belong in the extension
  installer (separate slice).
- Caching compiled modules across hosts (perf optimization, follow-up).
- Self-authored WASM hooks (governance separate, tracked at #3567).

## Threat-model deltas

The current `threat-model.md` says WASM execution is out of scope. This
PR brings it in scope; the new threat-model-wasm.md must cover:

- **Host-import surface**: each exported host fn is an attack channel.
  Enumerate. Restrict to typed sinks — no ambient access to
  filesystem, network, system time, RNG.
- **Fuel exhaustion**: trap → FailIsolated for observers, FailClosed
  for gates (existing failure_policy matrix already covers this).
- **Memory exhaustion**: `memory_mb` cap enforced via wasmtime's
  `StoreLimits`.
- **Wall-clock exhaustion**: `wall_ms` cap enforced via `tokio::time::timeout`
  on the host side + epoch-interrupt on the wasmtime side.
- **Module substitution**: `HookId` content-addressing must include the
  module bytes (or a digest of them).
- **Side channels**: WASM doesn't get access to ambient time, RNG, or
  syscalls — but constant-time predicates still leak via execution
  time. Acknowledge residual.

## Required tests

1. **Happy path**: Installed-tier WASM hook denies → outcome is
   `Denied` with the predicate's reason.
2. **Fuel exhaustion**: WASM loops forever → trap → FailClosed for gate
   point (Denied), FailIsolated for observer point (no outer impact).
3. **Module substitution**: same `HookLocalId`, different module bytes
   → different `HookId` → registry rejects on `HookId` collision check.
4. **Host-import surface negative**: WASM tries to call an undeclared
   import → link error at instantiation → fail closed.
5. **Memory cap**: WASM tries to grow past `memory_mb` → trap → fail
   closed.

## Required design discussion before implementation

- **Module loading**: where does the WASM blob live? Extension registry
  has bytes; hook framework needs a `WasmModuleRef` resolver. Likely
  reuses the existing tool-WASM loader path.
- **Wit-bindgen vs hand-rolled ABI**: pick one. Tool subsystem already
  uses one; lean toward that for consistency.
- **Per-build vs per-invocation runtime**: per-build (one `Store` per
  hook lifetime, recycled across invocations) is cheaper; per-invocation
  is safer (no state leakage). Bias toward per-invocation for v1 with
  a fast-path optimization later.

## Risk

- Large. Wasmtime integration touches the existing tool-WASM stack;
  any shared host-import infrastructure has to be hardened.
- Requires a separate threat-model artifact (drafted in this PR).
- May surface design questions about which existing primitives can be
  reused vs duplicated.

## Effort

Large. Plan for at least one design-review iteration before
implementation lands.
