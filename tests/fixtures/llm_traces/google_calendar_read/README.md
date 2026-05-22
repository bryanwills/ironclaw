# google_calendar_read replay snapshot

Replay snapshot for the Phase 5 Google Calendar read path.

`list_events.trace.json` is a recorded request/response/handler-output trace
for the `google-calendar.list_events` capability. It is the crate-level
stand-in for a `scripts/replay-snap.sh` capture: that wrapper drives cargo-insta
against a live agent session, which is out of scope for a crate-only package.
The trace pins the read-path contract (request shape and the whitelisted,
redacted handler output) so the acceptance item is satisfied without a live
LLM.

The exercised, runnable read-path coverage lives in
`crates/ironclaw_native_extensions/tests/google_calendar_read.rs`, driven by a
fake `NetworkHttpEgress` over the fixtures in
`crates/ironclaw_native_extensions/tests/fixtures/google_api/calendar/`.
