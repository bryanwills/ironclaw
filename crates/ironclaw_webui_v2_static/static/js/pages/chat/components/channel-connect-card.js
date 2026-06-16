import { SlackPairingSection } from '../../../components/slack-pairing-section.js';
import { Icon } from '../../../design-system/icons.js';
import { html } from '../../../lib/html.js';

// The Slack personal-pairing renderer is the only renderer that drives an
// inbound proof-code handshake, and only for the Slack channel. Pinned as a
// named predicate so the gate that mounts SlackPairingSection can't drift to a
// different channel/strategy combination without the contract test catching it.
export function isSlackStrategy(connectAction, strategy) {
  return (
    connectAction?.channel === 'slack' &&
    strategy === 'inbound_proof_code' &&
    connectAction?.strategy === strategy
  );
}

export function ChannelConnectCard({ connectAction, onDismiss }) {
  if (!connectAction) return null;
  const channel = connectAction.channel;

  return html`
    <div className="rounded-[16px] border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-signal">
            Connect ${connectAction.display_name || channel}
          </div>
        </div>
        ${onDismiss &&
        html`
          <button
            type="button"
            aria-label="Dismiss connect action"
            onClick=${onDismiss}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-iron-400 hover:bg-white/[0.04] hover:text-iron-100"
          >
            <${Icon} name="close" className="h-4 w-4" />
          </button>
        `}
      </div>

      ${isSlackStrategy(connectAction, connectAction.strategy)
        ? html`<${SlackPairingSection} action=${connectAction.action} />`
        : connectAction.strategy === 'extension_setup_link'
          ? html`
              <div
                className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-xs leading-5 text-iron-300"
                data-testid="connector-recovery-card"
              >
                <p>${connectAction.action?.instructions || 'Open Connections to finish setup.'}</p>
                <a
                  href=${connectAction.action?.href || '/extensions/registry'}
                  className="v2-button mt-3 inline-flex items-center gap-1.5 rounded-[8px] border border-signal/30 bg-signal/10 px-3 py-2 text-xs font-medium text-signal hover:bg-signal/15"
                >
                  ${connectAction.action?.label || 'Open setup'}
                  <${Icon} name="chevron" className="h-3 w-3 -rotate-90" />
                </a>
              </div>
            `
          : html`
              <div
                className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-xs leading-5 text-iron-300"
              >
                ${connectAction.action?.instructions ||
                'This channel exposes a connect action, but the WebUI has no renderer for its strategy yet.'}
              </div>
            `}
    </div>
  `;
}
