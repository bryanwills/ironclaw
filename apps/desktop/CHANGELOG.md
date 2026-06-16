# Changelog

All notable changes to IronClaw Desktop are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.158] — First public release

First public release of the IronClaw Desktop macOS client — a native
[Tauri v2](https://tauri.app) shell around the IronClaw / Reborn WebChat
experience, with a bundled local sidecar so chat, tools, and connectors run on
the user's machine.

### Added

- **Native macOS app** (Tauri v2 + React 19/htm + Tailwind) with a bundled
  `ironclaw-reborn` sidecar that serves the chat UI on loopback.
- **Chat** against NEAR AI (default), OpenAI, Anthropic, or any
  OpenAI-compatible / Ollama endpoint, configured per profile in Settings.
- **Document attachments** — client-side text extraction for PDF (with
  offline OCR fallback via tesseract.js for scanned pages) and OOXML
  (`.docx` / `.xlsx` / `.pptx`), with the extracted text inlined into the
  message so the model can read it.
- **Connectors** — one-click connect for Notion (zero-config Dynamic Client
  Registration), Google (Gmail/Calendar/Drive/Docs/Sheets/Slides via a
  configurable OAuth client), web search (Exa), GitHub, and NEAR AI, surfaced
  through the Extensions registry.
- **Work-product export** — copy or save assistant responses and whole threads
  as Markdown, HTML, JSON, byte-accurate PDF, and `.docx`, via a native save
  dialog.
- **Authentication via the macOS Keychain**; OAuth flows open in the system
  browser rather than an embedded webview.
- **Offline-first** — PDF text extraction, OCR, and Office parsing run entirely
  on-device.

### Security

- Strict Content-Security-Policy pinned by a regression test; the native HTTP
  proxy command is allowlisted to the loopback sidecar and the active profile's
  configured gateway origin; OOXML extraction caps inflated entry size to
  prevent zip-bomb memory exhaustion.

[0.1.0]: https://github.com/nearai/ironclaw-desktop-app/releases/tag/v0.1.0
