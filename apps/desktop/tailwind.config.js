/** @type {import('tailwindcss').Config} */
//
// Color tokens are aligned with the IronClaw web UI v2 design system
// (crates/ironclaw_webui_v2_static, reborn-integration branch) so the
// desktop client and the IronClaw browser UI share an accent palette.
//
// Dark-mode-only — light tokens intentionally omitted per project policy.
//
// `accent.cyan` historically pointed at #00d4ff. It now resolves to the
// IronClaw signal blue (#4ca7e6) so every existing reference picks up the
// new accent without a sweep. The new `signal*` aliases are the preferred
// names for new code; semantic tokens (positive/warning-v2/danger) cover
// status states that should NOT be primary-accent blue.
export default {
  content: ['./src/**/*.{html,js,svelte,ts}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          base: '#0a0f1e',
          deep: '#050810',
          surface: '#121826'
        },
        border: {
          subtle: '#1f2937'
        },
        text: {
          primary: '#e5e7eb',
          muted: '#9ca3af'
        },
        accent: {
          // Repointed to NEAR Blue (PMS 2925C) per the NEAR AI Brand
          // Guidelines v01. Every existing `accent-cyan` consumer picks up
          // the brand accent automatically — no sweep needed.
          cyan: '#0091fd',
          gold: '#fbbf24'
        },
        // NEAR Sky (PMS 2905C) — the lighter brand blue, for on-dark accents.
        sky: '#83dcff',
        // ── v2 design-system aliases (preferred for new code) ──────────
        signal: '#0091fd',
        'signal-strong': '#0077e0',
        'signal-soft': 'rgba(0, 145, 253, 0.14)',
        'signal-text': '#83dcff',
        // Semantic status tokens — use these for state, not primary accent.
        positive: '#20d29a',
        'positive-soft': 'rgba(32, 210, 154, 0.13)',
        'warning-v2': '#f5c15b',
        'warning-v2-soft': 'rgba(245, 193, 91, 0.14)',
        danger: '#ff6480',
        'danger-soft': 'rgba(255, 100, 128, 0.13)'
      },
      fontFamily: {
        sans: [
          '"Inter Variable"',
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          '"SF Pro Display"',
          '"Helvetica Neue"',
          'Arial',
          '"Segoe UI"',
          'sans-serif'
        ],
        mono: ['"SF Mono"', 'Menlo', 'monospace']
      },
      keyframes: {
        'v2-breathe': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' }
        }
      }
    }
  },
  plugins: []
};
