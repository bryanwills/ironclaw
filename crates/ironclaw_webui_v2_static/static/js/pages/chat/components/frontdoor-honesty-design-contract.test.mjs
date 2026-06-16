import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const emptyState = read("./empty-state.js");
const suggestionChips = read("./suggestion-chips.js");
const approvalCard = read("./approval-card.js");

// Adversarial-review findings #1/#3/#8: when NEAR AI Cloud is not connected the
// cold front door must lead with setup as the single primary action, must NOT
// render a dead/disabled suggestion grid, and must not promise a capability the
// data layer cannot back.
test("blocked front door hides suggestions instead of rendering them disabled", () => {
  // Suggestions render only when not blocked.
  assert.match(
    emptyState,
    /\$\{!suggestionsBlocked &&/,
    "suggestion grid must be gated on !suggestionsBlocked",
  );
  // The old fake-readiness pattern (disabled-but-visible suggestions) is gone.
  assert.doesNotMatch(
    emptyState,
    /cursor-not-allowed opacity-60/,
    "disabled-but-visible suggestion styling must not return",
  );
  assert.doesNotMatch(
    emptyState,
    /"Setup first"/,
    'the "Setup first" disabled-suggestion label must not return',
  );
});

test("the checking state also gates suggestions (no live-looking grid mid-check)", () => {
  assert.match(
    emptyState,
    /suggestionsBlocked\s*=\s*Boolean\(\s*setupBlocked \|\| providerSetupChecking \|\| disabled\s*\)/,
    "suggestionsBlocked must include providerSetupChecking",
  );
});

test("setup callout is the primary action and renders before the composer when blocked", () => {
  const calloutIdx = emptyState.indexOf('data-testid="frontdoor-setup-callout"');
  assert.ok(calloutIdx > -1, "setup callout must carry a stable testid");
  // The desktop front door renders more than one composer across variants;
  // assert the callout precedes the composer that follows it in this section.
  const composerAfterCallout = emptyState.indexOf("<${ChatInput}", calloutIdx);
  assert.ok(
    composerAfterCallout > calloutIdx,
    "the composer must render after the setup callout in the blocked front door",
  );
  // The dominant action stays flat token blue.
  assert.match(emptyState, /bg-\[var\(--v2-accent-btn\)\][^]*?Open setup/);
});

test("the Handled front-door section renders only when it has evidence", () => {
  assert.match(
    emptyState,
    /\$\{handled\.length > 0 &&\s*html`<\$\{FrontDoorSection}\s*title="Handled"/,
    "Handled section must be conditional on handled.length > 0",
  );
});

test("Needs-you empty copy is accurate to thread-scoped data (no over-promise)", () => {
  assert.match(emptyState, /Threads waiting on your approval or recovery appear here\./);
  assert.doesNotMatch(
    emptyState,
    /Approvals and auth gates appear here when they are backed by a thread\./,
    "the over-promising gate-visibility copy must be gone",
  );
});

// Finding #9: suggestion chips are a user action — blue, on semantic tokens, no
// legacy iron/signal/white classes.
test("suggestion chips use semantic tokens and a blue user-action hover", () => {
  assert.doesNotMatch(suggestionChips, /border-white|text-iron-|text-signal|bg-white/);
  assert.match(suggestionChips, /hover:border-\[var\(--v2-accent\)\]/);
  assert.match(suggestionChips, /hover:text-\[var\(--v2-accent-text\)\]/);
});

// Finding #4: high-risk gates must emphasize destination / outbound-data rows in
// danger tone, not the decorative gold used for benign structured fields.
test("approval card escalates egress rows to danger tone for high-risk gates", () => {
  assert.match(
    approvalCard,
    /risk\.tone === "danger"/,
    "approval card must branch row emphasis on risk.tone",
  );
  assert.match(
    approvalCard,
    /bg-\[var\(--v2-danger-soft\)\]/,
    "danger-tone egress rows must use the danger soft background",
  );
  assert.match(
    approvalCard,
    /text-\[var\(--v2-danger-text\)\]/,
    "danger-tone egress values must use danger text",
  );
});
