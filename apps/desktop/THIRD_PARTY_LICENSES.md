# Third-Party Licenses

IronClaw Desktop bundles the third-party assets listed below inside the
packaged static WebUI at `crates/ironclaw_webui_v2_static/static`. Each entry
records the asset, the version vendored, its license, the copyright holder, and
the upstream source. License banners that ship inside the minified blobs are
reproduced or pointed to here; where a referenced banner file was not vendored
alongside the blob, a copy of the license text has been added next to the asset
(see `static/fonts/Inter-OFL.txt` and `static/ocr/TESSERACT-LICENSE.txt`).

The IronClaw Desktop application itself is licensed under MIT — see
[`LICENSE`](LICENSE).

---

## JavaScript / WASM libraries

### pdf.js

- **Files:** `crates/ironclaw_webui_v2_static/static/vendor/pdf.min.mjs`, `crates/ironclaw_webui_v2_static/static/vendor/pdf.worker.min.mjs`
- **License:** Apache License, Version 2.0
- **Copyright:** Copyright 2024 Mozilla Foundation
- **Source:** https://github.com/mozilla/pdf.js

  The bundled blobs carry the standard pdf.js `@licstart` / `@licend` Apache-2.0
  notice. Per the Apache-2.0 NOTICE requirement, attribution is preserved here
  and in the inline banner of each file. Full license text:
  https://www.apache.org/licenses/LICENSE-2.0

### tesseract.js

- **Files:** `crates/ironclaw_webui_v2_static/static/ocr/tesseract.esm.min.js`, `crates/ironclaw_webui_v2_static/static/ocr/worker.min.js`
- **License:** Apache License, Version 2.0
- **Copyright:** Copyright Tesseract.js contributors
- **Source:** https://github.com/naptha/tesseract.js

  The bundled blob references `tesseract.min.js.LICENSE.txt`, which was not
  vendored alongside it; an Apache-2.0 notice is provided at
  `static/ocr/TESSERACT-LICENSE.txt`. Full license text:
  https://www.apache.org/licenses/LICENSE-2.0

### tesseract-core (Tesseract OCR engine, WASM build)

- **Files:** `crates/ironclaw_webui_v2_static/static/ocr/tesseract-core-simd-lstm.wasm`, `crates/ironclaw_webui_v2_static/static/ocr/tesseract-core-simd-lstm.wasm.js`
- **License:** Apache License, Version 2.0
- **Copyright:** Copyright Tesseract.js contributors (WASM build of the tesseract-ocr engine)
- **Source:** https://github.com/naptha/tesseract.js-core (engine: https://github.com/tesseract-ocr/tesseract)

  See `static/ocr/TESSERACT-LICENSE.txt`. Full license text:
  https://www.apache.org/licenses/LICENSE-2.0

### tessdata — `eng.traineddata`

- **File:** `crates/ironclaw_webui_v2_static/static/ocr/eng.traineddata`
- **License:** Apache License, Version 2.0
- **Copyright:** Copyright Google Inc. / tesseract-ocr contributors
- **Source:** https://github.com/tesseract-ocr/tessdata (English LSTM model)

  Trained data for the Tesseract OCR engine. Full license text:
  https://www.apache.org/licenses/LICENSE-2.0

### highlight.js

- **File:** `crates/ironclaw_webui_v2_static/static/vendor/highlight.min.js`
- **Version:** 11.11.1
- **License:** BSD-3-Clause
- **Copyright:** Copyright (c) 2006, Ivan Sagalaev and other highlight.js contributors
- **Source:** https://github.com/highlightjs/highlight.js

  License text: https://github.com/highlightjs/highlight.js/blob/main/LICENSE

### marked

- **File:** `crates/ironclaw_webui_v2_static/static/vendor/marked.umd.js`
- **Version:** 17.0.2
- **License:** MIT
- **Copyright:** Copyright (c) 2018-2026, MarkedJS; Copyright (c) 2011-2018, Christopher Jeffrey
- **Source:** https://github.com/markedjs/marked

  The bundled blob carries the full MIT banner. License text:
  https://github.com/markedjs/marked/blob/master/LICENSE.md

### DOMPurify

- **File:** `crates/ironclaw_webui_v2_static/static/vendor/purify.min.js`
- **Version:** 3.4.7
- **License:** Apache License, Version 2.0 OR Mozilla Public License, Version 2.0 (dual-licensed)
- **Copyright:** Copyright (c) Cure53 and other contributors
- **Source:** https://github.com/cure53/DOMPurify

  The bundled blob carries the `@license` banner. Per Apache-2.0, attribution is
  preserved here and in the inline banner. License text:
  https://github.com/cure53/DOMPurify/blob/3.4.7/LICENSE

## Fonts

### Inter (variable)

- **File:** `crates/ironclaw_webui_v2_static/static/fonts/inter-variable.woff2`
- **License:** SIL Open Font License, Version 1.1
- **Copyright:** Copyright (c) The Inter Project Authors (Rasmus Andersson and contributors)
- **Source:** https://github.com/rsms/inter

  **Reserved Font Name:** "Inter". Under OFL-1.1, the font may be bundled and
  redistributed, but must not be sold by itself, and any derivative or modified
  version must not use the reserved name "Inter" without permission. The full
  OFL-1.1 license text — required to accompany the bundled font — is at
  `static/fonts/Inter-OFL.txt`.

---

## Apache-2.0 NOTICE

Several assets above (pdf.js, tesseract.js, tesseract-core, tessdata, and the
Apache half of DOMPurify's dual license) are distributed under the Apache
License, Version 2.0. The full license text is available at
https://www.apache.org/licenses/LICENSE-2.0. Where an upstream `NOTICE` file
exists, its attribution requirements are satisfied by the per-asset copyright
attributions listed above.
