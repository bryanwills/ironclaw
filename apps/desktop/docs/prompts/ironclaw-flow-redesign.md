# Prompt: Flow Redesign

You are redesigning IronClaw Desktop's highest-value user flows. Focus on
end-to-end usability, not isolated screens.

## Load First

- `CLAUDE.md`
- `docs/reviews/design-pass-research-synthesis-2026-06-10.md`
- `docs/reviews/practical-work-scenario-corpus.md`
- `output/readme-shots/contact-sheet.png`

## Flows To Redesign

Cover these flows:

1. First run: user opens desktop and connects NEAR AI Cloud.
2. First real ask: user drags in a file and asks for a useful work product.
3. Connector setup: user connects Notion, Gmail, Google Calendar, or Slack.
4. Approval: IronClaw wants to send, publish, edit, delete, or call a tool.
5. Work product: assistant produces DOCX/PDF/XLSX/MD/JSON and the user exports
   or saves it.
6. Returning user: app opens with previous threads, pending approvals, and
   handled receipts.
7. Failure: gateway/model/connector is not ready and the UI must be honest.

## For Each Flow

Write:

- User intent
- Entry point
- Current likely failure
- Desired steps, numbered
- Screen states
- Primary action per step
- Copy draft
- Data contract
- Blocked/error state
- Metrics of success
- Tests and screenshots

## Output Rules

- Keep flows concrete enough to implement.
- Use exact labels and copy where possible.
- Prefer one action per state.
- If a capability is missing, design the blocked state instead of pretending.
- Tie every design claim to a test or screenshot.

End with a prioritized roadmap:

- Now: 1-2 day fixes
- Next: 1 week feature build
- Later: backend/product contracts
