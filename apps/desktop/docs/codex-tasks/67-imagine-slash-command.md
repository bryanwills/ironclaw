# R67 — /imagine slash command (lane A11)

**Branch**: `codex/r67-imagine-slash`
**Depends on**: nothing (but PROBE the gateway first)

## Context

`/imagine <prompt>` in the chat composer should send the prompt to a
gateway image-generation endpoint, then attach the returned image to
the user's message. Distinct from regular text messages.

This task ships the WIRE only — the slash-command hookup in the
composer is a follow-up lane.

## Owned files (exclusive write)

- `src/lib/api/ironclaw.ts` — APPEND `generateImage(prompt, options?)`
  method to `IronClawClient`.
- `src/lib/api/types.ts` — APPEND `ImageGenerationResult` interface.
- `src/lib/stores/slash-commands.svelte.ts` — APPEND `/imagine` entry
  to the registered slash commands. The handler stays a no-op for now
  — the composer hook lands in a follow-up lane.

## Forbidden

- Any route or component.
- Anything in `src-tauri/`.

## Probe

```bash
TOKEN="62c807bdfa3d40fa7b3b0d141c38e5a6edc0d8839669678c293c9497e821bc3f"
URL="http://127.0.0.1:18789"

# 1. Does /api/llm/image exist?
curl -sS -w "\n%{http_code}\n" -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"a red apple","size":"512x512"}' \
  "$URL/api/llm/image"

# 2. Alternative paths to try:
curl -sS -w "\n%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  "$URL/api/llm/generate-image"
```

If neither responds with a 2xx + image URL or base64 payload, the
endpoint isn't wired upstream. In that case **STOP** and ship a
stub method that throws `Error('Image generation not implemented on
this gateway version')` so the slash command shows a clear error
when the lane consumer (R67-followup) wires the composer.

## Expected wire contract (subject to probe)

```
POST /api/llm/image
  body: { prompt: string, size?: "256x256" | "512x512" | "1024x1024",
          n?: number, model?: string }
  resp: 200 {
    images: [{ url?: string, base64?: string, mime: string }],
    model_used: string,
    cost_tokens?: number
  }
```

## Type additions

```ts
export interface ImageGenerationResult {
  images: Array<{
    url?: string;
    base64?: string;
    mime: string;
  }>;
  model_used: string;
  cost_tokens?: number;
}

export interface ImageGenerationOptions {
  size?: '256x256' | '512x512' | '1024x1024';
  n?: number;
  model?: string;
}
```

## Client addition

```ts
async generateImage(
  prompt: string,
  options: ImageGenerationOptions = {}
): Promise<ImageGenerationResult> {
  const url = `${this.baseUrl}/api/llm/image`;
  const maybeTauri = await loadTauriFetch();
  const fetchImpl = maybeTauri ?? fetch;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
    },
    body: JSON.stringify({
      prompt,
      size: options.size ?? '512x512',
      n: options.n ?? 1,
      ...(options.model ? { model: options.model } : {})
    })
  });
  if (res.status === 404) {
    throw new Error('Image generation not implemented on this gateway');
  }
  if (!res.ok) throw new Error(`generateImage ${res.status}`);
  return await res.json();
}
```

## Slash command registration

Add to `slash-commands.svelte.ts` (read it first):
```ts
{
  name: 'imagine',
  description: 'Generate an image from a text prompt',
  example: '/imagine a sunset over mountains',
  // The composer hook is a follow-up lane — stub for now.
  handler: undefined
}
```

## Tests

Add a unit test for `generateImage` in `src/lib/api/ironclaw.test.ts`
(or a new sibling): mock fetch, assert URL + body + headers.

## Gates

```bash
npm run check
npm run test
```

## Ship

Standard codex commit pattern; push branch.
