# ironclaw_reborn_openai_compat_storage

Durable storage adapters for the Reborn OpenAI-compatible ref/idempotency
contract from `ironclaw_reborn_openai_compat`.

## Boundary

This crate is storage-only:

- It implements `OpenAiCompatRefStore` over `ironclaw_filesystem::RootFilesystem`.
- It persists opaque public refs, actor scope, route surface, request
  fingerprint, optional client idempotency key, and opaque internal refs.
- It does not submit turns, inspect ProductWorkflow internals, bind listeners,
  call v1 gateway code, proxy LLM requests, or reach into Reborn composition.

## Storage Shape

The initial durable adapter stores one CAS-protected JSON envelope under:

```text
/engine/openai_compat/refs/state.json
```

This keeps reservation, idempotency replay/conflict, and later binding updates
atomic through a single filesystem record. The record stores metadata and
opaque refs only; it must never contain raw prompts, response payloads, event
cursors, host paths, backend error details, secrets, or concrete thread/run
objects.

If this grows hot enough to need row-level indexing, preserve the same
`OpenAiCompatRefStore` behavior first and move the indexing behind this crate
rather than changing the contract crate.

## Validation

Run targeted checks from the workspace root:

```bash
cargo test -p ironclaw_reborn_openai_compat_storage
cargo clippy -p ironclaw_reborn_openai_compat_storage --all-targets --all-features -- -D warnings
cargo test -p ironclaw_architecture reborn_crate_dependency_boundaries_hold
```
