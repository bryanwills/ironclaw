# IronClaw Hostile Design Review

Run the prompt in `docs/prompts/ironclaw-hostile-design-review.md`.

Before answering:

1. Read `CLAUDE.md`.
2. Refresh screenshots if needed:

```sh
npm run prepare:webui-static
CAPTURE_MODE=chat CAPTURE_READY=1 node scripts/capture-readme-shots.mjs
```

3. Review `output/readme-shots/contact-sheet.png`.

Return the RED/YELLOW/GREEN table requested by the prompt. Be harsh and
evidence-bound.
