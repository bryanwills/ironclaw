# Prepared Desk IA

Date: 2026-06-13

## Purpose

The chat route is the current front door. It must behave like a prepared desk:
what needs the user, what IronClaw handled, what is blocked, and what can be
started next are visible before the user types.

## Home / Chat IA

1. Readiness strip: NEAR AI Cloud, gateway, and send readiness.
2. Needs You: approvals, auth gates, blocked connectors, failed runs.
3. Handled receipts: completed agent actions and generated artifacts.
4. Composer: direct ask, attachments, model source, send/cancel.
5. Suggestions: at most three practical starts; suggestions prefill rather than
   fire blind work.
6. Recent threads: only when real thread history exists.

## Needs You Strip

Needs You should be compact, above the composer or first message, and should not
look like a marketing card. Rows need:

- type: approval, auth, blocked connector, failed run, missing context.
- title: exact next decision.
- target: app/file/thread/tool involved.
- risk or blocker.
- one primary action when real.

## Handled Receipts

Receipts use gold only when they represent agent agency. A receipt row should
include:

- outcome: what changed or was drafted.
- source/provenance.
- linked artifact or thread.
- undo/reopen only when backed by an actual action.

## Artifact Rail

Artifacts should not be buried in prose. The durable shape is:

- file type icon.
- filename or generated title.
- source file/thread.
- preview/copy/export/save actions.
- extraction or generation status.

The current implementation proves attachment chips and export mechanics; the
next design slice should promote generated artifacts into a persistent rail or
drawer.

## Composer Hierarchy

- The text input is important but not the whole app.
- The model chip says NEAR AI Cloud in plain language.
- Attachment state says whether the model can read the file.
- Send is blocked until provider/gateway truth proves execution.

## Returning User State

Returning users should see recent threads and any pending gates before blank
suggestions. Empty history should not fabricate activity.

## Empty State

Empty state is allowed only when it is honest. It should say what is connected,
what is blocked, and what the user can do next. It must not claim readiness from
localStorage, stale fallback settings, or mocked catalog entries.
