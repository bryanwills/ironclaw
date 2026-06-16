import { html } from '../../lib/html.js';

// Desktop first-run model access is NEAR AI Cloud only. Keeping other provider
// marks out of this module prevents the onboarding surface from drifting back
// into a generic provider picker.
const NEAR =
  'M21.443 0c-.89 0-1.714.46-2.18 1.218l-5.017 7.448a.533.533 0 0 0 .792.7l4.938-4.282a.2.2 0 0 1 .334.151v13.41a.2.2 0 0 1-.354.128L5.03.905A2.555 2.555 0 0 0 3.078 0h-.521A2.557 2.557 0 0 0 0 2.557v18.886a2.557 2.557 0 0 0 4.736 1.338l5.017-7.448a.533.533 0 0 0-.792-.7l-4.938 4.283a.2.2 0 0 1-.333-.152V5.352a.2.2 0 0 1 .354-.128l14.924 17.87c.486.574 1.2.905 1.952.906h.521A2.558 2.558 0 0 0 24 21.445V2.557A2.558 2.558 0 0 0 21.443 0Z';

const MARKS = {
  nearai: { color: '#00ec97', path: NEAR }
};

export function ProviderLogo({ id, name }) {
  const mark = MARKS[id];
  const tileClass = 'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl';

  if (!mark) {
    const letter = (name || id || '?').trim().charAt(0).toUpperCase();
    return html`
      <span
        className=${`${tileClass} bg-[var(--v2-surface-muted)] text-sm font-semibold text-[var(--v2-text-strong)]`}
      >
        ${letter}
      </span>
    `;
  }

  return html`
    <span
      className=${tileClass}
      style=${{
        background: `color-mix(in srgb, ${mark.color} 16%, transparent)`,
        color: mark.color
      }}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
        <path d=${mark.path} />
      </svg>
    </span>
  `;
}
