# Core Flow Specs

Date: 2026-06-13

## First Run And NEAR AI Cloud Sign-In

Promise: connect NEAR AI Cloud once and start using IronClaw without choosing a
third-party model vendor.

States:

- loading: gateway/provider truth is being checked.
- blocked: gateway unavailable or provider snapshot empty; all setup actions are
  disabled with exact blocker copy.
- available: GitHub, Google, NEAR Wallet, and quiet API key fallback are shown.
- connected: NEAR AI Cloud is active and chat can send.

Proof: rendered onboarding plus `/api/webchat/v2/llm/providers`, NEAR login
bridge, and active provider confirmation.

## First Real Ask With Attachment

Promise: a user can attach PDF/DOCX/XLSX/CSV/MD/JSON/HTML inputs and see what
IronClaw can read before sending.

States:

- extracting.
- extracted with character count.
- raw but model-readable.
- metadata-only when binary cannot be embedded.
- rejected/corrupt with actionable copy.

Proof: posted message payload contains filenames, MIME types, extracted text
where available, and no visible transcript base64.

## Connector Setup

Promise: Gmail, Google Calendar, Notion, Slack, and workspace surfaces show
honest readiness and one next action.

States:

- not available: catalog/gateway does not expose installable lifecycle.
- needs setup: credentials, OAuth client, token, or pairing required.
- ready/connectable: backend exposes an action.
- connected: backend proves active/ready plus credential/account evidence.

Proof: UI clicks must use catalog refs only for catalog projection and canonical
bare names for lifecycle requests.

## Approval Gate

Promise: risky actions pause before execution and name what will happen.

Required fields:

- action.
- target/destination.
- what leaves the machine.
- risk.
- approve, deny, always allow where supported.
- "nothing sent yet" state when applicable.

Proof: backend enforcement blocks tool execution until the gate resolves.

## Work-Product Preview And Export

Promise: generated work is usable as a file, not chat sludge.

Formats: DOCX, PDF, HTML, MD, JSON, XLSX/CSV when applicable.

Proof:

- preview renders.
- copy/export/save controls work.
- exported bytes parse.
- reload preserves artifact metadata and output.

## Returning User

Promise: opening IronClaw cold shows recent work and pending decisions before a
blank prompt.

Proof: threads, pending gates, blocked connectors, receipts, and artifacts are
data-backed and reload-safe.

## Failure And Blocked States

Blocked copy must include:

- exact blocker.
- why the action is paused.
- one next action.
- no optimistic "connected", "ready", or "handled" label.
