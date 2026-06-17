import { useNavigate } from "react-router";
import { Button } from "../../../design-system/button.js";
import { Icon } from "../../../design-system/icons.js";
import { Panel } from "../../../design-system/primitives.js";
import { html } from "../../../lib/html.js";
import { useT } from "../../../lib/i18n.js";

// Example prompts shown in the empty state. The text is localized through
// `t`, so this list only holds the i18n keys; non-English packs fall back to
// the en.js copy automatically.
const EXAMPLE_PROMPT_KEYS = [
  "automations.empty.example1",
  "automations.empty.example2",
  "automations.empty.example3",
];

// Onboarding empty state shown when the agent has no scheduled automations at
// all. Automations are created by chatting with the agent (there is no "New
// automation" form), so the empty state must say so and offer a shortcut to
// chat plus a few example prompts to copy.
export function AutomationsEmptyState() {
  const t = useT();
  const navigate = useNavigate();

  return html`
    <${Panel} className="p-6 sm:p-8">
      <div className="max-w-2xl">
        <div className="inline-flex h-11 w-11 items-center justify-center rounded-[14px] border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)]">
          <${Icon} name="calendar" className="h-5 w-5 text-[var(--v2-accent-text)]" />
        </div>
        <h2 className="mt-4 text-2xl font-semibold tracking-tight text-iron-100">
          ${t("automations.empty.onboardingTitle")}
        </h2>
        <p className="mt-3 text-sm leading-6 text-iron-300">
          ${t("automations.empty.onboardingDescription")}
        </p>

        <div className="mt-6">
          <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-iron-400">
            ${t("automations.empty.examplesTitle")}
          </div>
          <ul className="mt-3 space-y-2">
            ${EXAMPLE_PROMPT_KEYS.map(
              (key) => html`
                <li
                  key=${key}
                  className="rounded-xl border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] px-4 py-3 text-sm leading-6 text-iron-200"
                >
                  ${t(key)}
                </li>
              `
            )}
          </ul>
        </div>

        <div className="mt-6">
          <${Button} variant="primary" size="sm" onClick=${() => navigate("/chat")}>
            <${Icon} name="chat" className="mr-1.5 h-4 w-4" />
            ${t("automations.empty.startInChat")}
          <//>
        </div>
      </div>
    <//>
  `;
}
