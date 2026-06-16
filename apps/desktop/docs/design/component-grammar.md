# Component Grammar

Date: 2026-06-13

## Artifact Chip

- Icon: file type.
- Primary text: filename or generated title.
- Secondary text: source and extraction/generation state.
- Actions: preview, copy, export, save.
- Never hide base64 or raw JSON as the user-facing artifact.

## Approval Gate

- Compact inline card.
- Header names the blocked action.
- Body names target, data movement, and risk.
- Primary action is blue Approve.
- Deny is quiet.
- Gold may mark IronClaw's proposed action/provenance, not generic warning.

## Connector Card

- Logo or functional icon.
- App name and value in one short line.
- Readiness state is backend-backed.
- One next action.
- Exact blocker when unavailable.
- Slash-prefixed registry ids are catalog refs only, never lifecycle names.

## Tool Row

- One line by default.
- Shows verb, target, and result.
- Expand only for parameters/result details.
- Avoid long "thinking" or workflow traces in chat.

## Receipt Card

- Gold attribution when IronClaw handled something.
- Outcome first.
- Source/provenance second.
- Artifact/deep link third.
- Undo/reopen only when real.

## Model Source Chip

- Plain label: NEAR AI Cloud.
- Model id when active.
- Checking/blocked state when provider truth is unavailable.
- Popover shows model list only after active provider proof exists.
- Manage setup link is the primary escape hatch when blocked.

## File Preview Drawer

- Title: file/artifact name.
- Metadata: type, size, source, extraction state.
- Preview: text/pages/sheets where available.
- Actions: copy visible text, export/save artifact.
- Must fit mobile without text overlap.

## Blocked-State Callout

- One blocker.
- One next action.
- No raw gateway jargon.
- No fake progress.
- Warning color only for the blocked state, not decoration.
