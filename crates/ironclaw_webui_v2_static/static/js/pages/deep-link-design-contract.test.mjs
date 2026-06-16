import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pagesRoot = testDir;
const staticJsRoot = path.resolve(pagesRoot, "..");

// Routed pages outside chat/settings/logs that are already on v2 semantic
// tokens. Each new page landing here must be token-clean before it enters
// this list.
const routedStatusFiles = [
  path.join(pagesRoot, "admin", "admin-page.js"),
  path.join(pagesRoot, "admin", "components", "admin-tabs.js"),
  path.join(pagesRoot, "admin", "components", "dashboard-tab.js"),
  path.join(pagesRoot, "admin", "components", "usage-tab.js"),
  path.join(pagesRoot, "admin", "components", "users-tab.js"),
  path.join(pagesRoot, "admin", "components", "user-detail.js"),
  path.join(pagesRoot, "login", "login-page.js"),
  path.join(pagesRoot, "work", "work-page.js"),
];

const rawStatusColorPattern =
  /\b(?:text|bg|border|hover:text|hover:bg|hover:border)-(?:red|yellow|amber|orange|emerald|green|lime)-\d/g;

test("admin, login, and work pages use semantic tokens (no raw status colors)", async () => {
  const violations = [];

  for (const file of routedStatusFiles) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(rawStatusColorPattern)) {
      violations.push(`${path.relative(staticJsRoot, file)}: ${match[0]}`);
    }
  }

  assert.deepEqual(violations, []);
});

// The admin gate — admin tabs use the mono eyebrow typography consistent with
// the rest of the app's header hierarchy. The lowercase + tracking pattern
// applied since the 2026-06-12 review must not regress.
test("admin page does not render marketing gradients or decorative shadows", async () => {
  const adminPage = await readFile(
    path.join(pagesRoot, "admin", "admin-page.js"),
    "utf8",
  );

  assert.doesNotMatch(adminPage, /bg-gradient/, "admin page must not use gradient backgrounds");
  assert.doesNotMatch(adminPage, /linear-gradient/, "admin page must not use linear-gradient");
});

// Work page uses gold for agent attribution (not blue or raw green).
test("work page uses gold agent attribution (not accent blue or raw green)", async () => {
  const workPage = await readFile(
    path.join(pagesRoot, "work", "work-page.js"),
    "utf8",
  );

  // Gold must be present for file artifact attribution.
  assert.match(
    workPage,
    /v2-gold/,
    "work page file artifact glyph must use v2-gold attribution",
  );

  // Raw green must not appear as a status color.
  assert.doesNotMatch(
    workPage,
    /text-emerald|text-green-[0-9]/,
    "work page must use semantic tokens for positive states, not raw emerald/green",
  );
});

// Login page must not imply a provider marketplace or third-party API keys.
test("login page does not render a provider marketplace or third-party API key prompts", async () => {
  const loginPage = await readFile(
    path.join(pagesRoot, "login", "login-page.js"),
    "utf8",
  );

  assert.doesNotMatch(
    loginPage,
    /api[_-]?key/i,
    "login page must not surface API key fields — that belongs in Settings",
  );
  assert.doesNotMatch(
    loginPage,
    /provider marketplace/i,
    "login page must not frame onboarding as a provider marketplace",
  );
});
