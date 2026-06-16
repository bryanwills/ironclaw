# Current Surface Truth Map

Date: 2026-06-13

This map tracks the shipped static desktop UI at
`crates/ironclaw_webui_v2_static/static`. It is intentionally about user-visible
truth, not component ownership.

| Surface | User promise | Current UI evidence | Backend/data proof required | Status | Highest-value fix |
| --- | --- | --- | --- | --- | --- |
| Onboarding | A new user connects NEAR AI Cloud once and can start working without choosing third-party model providers. | `output/readme-shots/onboarding-welcome.png`; `onboarding-page.js` shows NEAR AI Cloud, GitHub, Google, Wallet, API key fallback. | `/api/webchat/v2/llm/providers`, NEAR browser login, wallet login, gateway token bootstrap. | YELLOW | Keep actions disabled when provider truth is missing; prove live NEAR auth in packaged app. |
| Chat prepared desk | The front door answers what needs the user before asking for a prompt. | `output/readme-shots/chat.png`; `empty-state.js` renders brief rows, readiness, recent threads, suggestions, composer. | Gateway status, provider snapshot, threads list, approval/auth gate state. | YELLOW | Add real Needs You data rows once gateway exposes pending approvals/blocked connectors globally. |
| Composer and model source | The user sees NEAR AI Cloud state and can change the active model only after setup is real. | `chat-input.js` filters visible providers to NEAR AI Cloud and blocks send during setup. | `/api/webchat/v2/llm/providers`, `/llm/list-models`, `/llm/active`. | GREEN for UI truth, YELLOW for live auth. | Keep non-NEAR providers out of normal desktop UI; add rendered regression for model popover blocked state. |
| Attachments | Files attached to chat are visible, previewable, and tell the user what the model can actually read. | Attachment chips, preview modal, PDF/DOCX/XLSX extractors, work-product smoke. | Message payload includes attachment metadata and extracted text; reload preserves manifest without base64. | YELLOW | Continue work-product gauntlet with real model generation quality, not only mocked export mechanics. |
| Generated artifacts | Work product appears as exportable artifacts, not only assistant prose. | Work-product export/save tests and static smoke export menu. | Export bytes parse as DOCX/PDF/HTML/MD/JSON; native save bridge succeeds in packaged app. | YELLOW | Promote artifact chips into a persistent artifact rail/drawer on chat and work dossiers. |
| Approval/auth gates | Risky actions pause inline and name action, target, outbound data, and resolution. | `approval-card.js`, auth gate cards, enforcement tests. | Gate event stream, resolve route, backend enforcement before tool action. | YELLOW | Render a Needs You strip above chat when gates exist off-thread or before messages load. |
| Connections installed | Connected apps are shown only when backend state proves readiness. | `extensions.png`; installed tab renders empty state when no apps connected. | `/api/webchat/v2/extensions`, activation response with readiness/credential proof. | YELLOW | Add live OAuth/read-only connector proof for Gmail, Calendar, Notion, Slack. |
| Connections browse | Core connector cards are visible but cannot fake installability when the catalog is empty. | `extensions-registry.png`; registry tests cover canonical catalog refs and blocked states. | `/api/webchat/v2/extensions/registry`, lifecycle setup/install routes with canonical bare names. | YELLOW | For each card, show exact blocker and only one enabled connect action when backend exposes one. |
| Settings / AI setup | Normal model access is NEAR AI Cloud; advanced provider sprawl is not the front door. | `settings-inference.png`; provider management collapses to active NEAR panel. | Provider snapshot, active model, optional Google Desktop OAuth client id setting. | GREEN for copy/surface; YELLOW for live auth. | Keep API-key fallback quiet and make OAuth blocker copy exact. |
| Sidebar / navigation | Navigation is compact and task-oriented. | Contact sheet; sidebar groups Chat, Connections, Settings, conversations. | Thread list and route availability. | YELLOW | Rename/merge scheduled-work surfaces when Work/Desk IA lands; avoid exposing hidden/redundant routes. |
| Copy and terminology | Copy is calm, exact, and avoids provider-market and gateway jargon. | `en.js`, screenshots, prompt pack. | i18n completeness and screenshots. | YELLOW | Audit non-English inherited strings and legacy Svelte-only text separately. |
| Visual system | The app feels like a serious macOS chief-of-staff instrument. | Dark default, Inter Variable, signal blue, agent gold, low-radius panels. | Static asset bundle, screenshots, no external fonts/CDN. | GREEN for this slice. | Finish replacing compatibility CSS shims with tokenized components. |

## Current RED Items

- Live connector OAuth success is not proven in this pass.
- Real model-quality work-product generation from PDF/DOCX/XLSX inputs remains a live gateway gauntlet, not a screenshot claim.
- Background Needs You aggregation is still a product/data contract, not fully implemented UI state.
