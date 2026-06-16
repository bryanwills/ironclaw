# Phase Work Product Verification - 2026-06-09

Owner lane: Work Product

## Scope

Strengthened adversarial verification for attachment payload serialization, thread reload persistence, and static export parse/render coverage without changing chat UI/runtime code.

## Dummy Scenarios

- `services-template.pdf`: binary PDF-like contract template.
- `redline-instructions.md`: Markdown redline instructions.
- `invoice-payload.json`: structured JSON invoice payload.
- `scope-summary.html`: HTML source artifact.
- `board-minutes.docx`: DOCX-like binary package payload.

The live probes use equivalent varied attachment sets and write redacted artifacts with attachment names, MIME types, byte lengths, and payload hashes instead of raw base64.

## Verification

- `node --check scripts/probe-live-reborn-chat-attachments.mjs && node --check scripts/probe-live-reborn-assistant-run.mjs && node --check scripts/smoke-webui-static.mjs`: PASS.
- `node --test crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/useChat-send.test.mjs crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/history-messages.test.mjs crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/work-product-export.test.mjs`: PASS, 14 tests.
- `npm run test -- src/lib/util/work-product-export.test.ts src/lib/util/attachment-risk.test.ts`: PASS, 11 tests.
- `npm run smoke:webui-static`: PASS.

## Evidence

- Static smoke screenshot: `output/playwright/static-work-product-attachment-chat.png`.
- Static smoke screenshot: `output/playwright/static-run-state-failure-visible.png`.
- Live probe prerequisite check: token file present, but `http://127.0.0.1:3000/api/health` returned 404, so live probes were not executed as product proof in this run.

## Notes

The worktree contained unrelated dirty files outside this lane during final inspection; they were left untouched.
