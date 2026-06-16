# Contributing

Thanks for digging in. This document covers local setup, the workflow
for shipping a change, the CI gates you'll hit, the conventions the
codebase actually follows (not just aspires to), and the recipes for
the three most common contributions: adding an API client method,
adding a surface, and adding an icon.

For the why-and-how of the architecture, see
[`ARCHITECTURE.md`](ARCHITECTURE.md). Read that first if you don't
already have the lay of the land.

---

## Local dev setup

### Prerequisites

- macOS 12+ (Apple Silicon or Intel)
- Node 22 (matches the version pinned in CI)
- Rust 1.80+ (`rustup default stable`)
- Xcode Command Line Tools: `xcode-select --install`

### Install

```bash
git clone <your-fork-url>
cd ironclaw-desktop
npm install
```

### Run

```bash
npm run tauri dev
```

First compile takes ~3 min (pulls Tauri, plugin-shell, plugin-updater,
plugin-notification, keyring, uuid, tokio). Subsequent runs are cached
— expect 5–10 seconds for a hot rebuild after a Rust file change, and
sub-second for a Svelte file change (HMR).

### Sidecar binaries

The bundled IronClaw binaries are large (~100 MB per arch) and
gitignored. Local dev does not require them — you can develop against
a remote gateway with no sidecar at all. To work on the local-sidecar
code paths:

```bash
bash src-tauri/binaries/download.sh
```

This pulls both `aarch64-apple-darwin` and `x86_64-apple-darwin` from
the official IronClaw release and verifies SHA-256s.

### Useful env vars

```bash
# Tail the sidecar's stdout/stderr in the dev console
RUST_LOG=ironclaw_sidecar=info,ironclaw_tray=info npm run tauri dev

# Bump Rust log noise without re-running tauri build
RUST_LOG=ironclaw_desktop_lib=debug npm run tauri dev
```

### Connecting to a gateway

The first launch drops you in the onboarding wizard. The fast paths:

- **Remote**: enter a base URL and a bearer token. The bearer goes
  straight into the Keychain, never localStorage.
- **Local**: pick a provider (NEAR.AI Cloud is the zero-config
  default — IronClaw handles the OAuth on first connect). For
  OpenRouter/OpenAI/Anthropic, paste the key into the LLM picker
  in Settings before clicking Connect.

### Token storage and the file fallback (v0.2.8+)

Gateway bearer tokens primarily live in the macOS Keychain (service
`com.openclaw.ironclaw-desktop`, account `gateway-token:<profile-id>`).
The Rust side also writes a redundant **file fallback** at:

```
~/Library/Application Support/com.openclaw.ironclaw-desktop/tokens/
  gateway-token_<profile-id>.token   (mode 0600)
```

Why both? Every `cargo build --release` produces a binary with a fresh
ad-hoc code signature. macOS Keychain ACL grants are signature-bound,
so the new binary triggers a fresh `Always Allow` prompt on first
read. That prompt may surface behind the app window or never appear in
a headless dev loop, and the synchronous `keyring::Entry::get_password()`
call hangs indefinitely waiting for the user response — wedging the
entire Tauri IPC dispatcher (no fetches, no UI updates, just a
spinning "Disconnected" status).

`src-tauri/src/keychain.rs:get_secret` runs the keychain read on a
worker thread with a **2-second timeout**. On timeout it falls through
to the file fallback. Writes mirror to both stores so a future build
can read from either.

This fallback is **load-bearing for dev workflows** and not removable
without re-introducing the wedge. A real Developer ID signed build
gets a stable signature, so the ACL grant survives rebuilds and the
fallback becomes a no-op — but we still keep the timeout because the
hang failure mode also surfaces in CI sandboxes and headless tests.

If you ever see "Disconnected" forever on a fresh build:
1. `RUST_LOG=info` the binary directly and look for
   `READ TIMEOUT [gateway-token:default]`.
2. Stage your token with `bash scripts/stage-token.sh default <token>`.
3. Relaunch; status flips to green within 2s.

---

## Workflow

### Making a feature change

The repository is a thin native shell over the IronClaw gateway. Most
feature work falls into one of four buckets:

| Bucket                                                | Where the code goes                                |
| ----------------------------------------------------- | -------------------------------------------------- |
| New gateway endpoint to surface                       | `src/lib/api/ironclaw.ts` + tests + types update   |
| New UI surface (top-level route)                      | `src/routes/<surface>/+page.svelte` + sidebar wire |
| New chord / global modal                              | new store in `src/lib/stores/` + layout mount      |
| New privileged operation (FS / shell / OS)            | new `#[tauri::command]` in `src-tauri/src/`        |

Whichever bucket you're in, the sequence is the same:

1. Make the smallest change that's testable.
2. Write the test first if the change is in `ironclaw.ts`, a store,
   or a pure utility. Component tests are useful for visible state
   (toast renders, masked value masks); they are NOT useful for
   testing Tauri IPC plumbing (mock it and you've tested your
   mock).
3. Run `npm run check` and `npm run test` locally until they pass.
4. If you touched Rust, run `cargo check --manifest-path
   src-tauri/Cargo.toml` and `cargo clippy --manifest-path
   src-tauri/Cargo.toml -- -D warnings`.
5. Push and open a PR.

---

## CI gates

| Workflow         | Trigger                | Hard-fails on                                         |
| ---------------- | ---------------------- | ----------------------------------------------------- |
| `check.yml`      | PR + push to main      | `npm run check`, `npm run verify:static-frontend`, `npm run smoke:webui-static`, `npm run test`, `npm run build`, `cargo check` |
| `check.yml`      | PR + push to main      | `cargo clippy` (currently `continue-on-error: true`; warn-don't-block) |
| `style-guard.yml`| PR                     | Hardcoded `#00d4ff` / `#4ca7e6` / `#2882c8` / `#00bcd4` outside the allowlist |
| `release.yml`    | tag `v*`               | Full `tauri build` for both arches; signs updater artifacts if secrets present |

The clippy step is currently `continue-on-error`. Don't make it
worse — every PR that adds new clippy findings is one step further
from flipping it back to a hard fail.

The style-guard's allowlist covers: `tailwind.config.js`, `src/app.css`,
`src-tauri/icons/`, `build_icons.py`. Anywhere else, use the
`accent-cyan` / `accent-signal` Tailwind classes or the `--v2-accent`
CSS variable. The per-profile tint override relies on this — a
hardcoded hex silently breaks tinting for that surface.

---

## Conventions

### Naming

- **Stores** live in `src/lib/stores/` and end in `.svelte.ts`. The
  suffix is required for the Svelte compiler to enable runes
  (`$state`, `$derived`, `$effect`) in a `.ts` file. Test files
  next to them as `<name>.test.ts`.
- **Components** live in `src/lib/components/` and use PascalCase
  (`CommandPalette.svelte`, `MarkdownView.svelte`). Tests next to
  them as `<Name>.test.ts`.
- **Routes** live in `src/routes/<surface>/+page.svelte`. Surface
  folder name is lowercase singular when it's an object
  (`/settings`, `/admin`) or lowercase plural when it's a list
  (`/skills`, `/routines`, `/jobs`).
- **API client methods** are camelCase (`getProfile`,
  `streamEvents`, `createRoutine`). Methods that return unredacted
  secrets MUST be suffixed `Raw` (`getSettingsRaw`,
  `getSystemPromptRaw`) — see [Extending the API client](#extending-the-api-client).

### TypeScript

- `strict: true` (see `tsconfig.json`).
- No `any`. If you must, leave a comment explaining the boundary.
- Prefer `unknown` + a narrow at the boundary over `any` everywhere.
- Defensive parsing in `ironclaw.ts`: every field from the wire is
  `as unknown` then pulled with `??` fallback.

### Rust

- `unwrap()` and `expect()` are fine in tests, never in production
  paths. Tauri commands return `Result<T, String>` — stringify the
  error with `.map_err(|e| format!("..."))`.
- New modules go in `src-tauri/src/<name>.rs` and get a `mod <name>;`
  declaration in `lib.rs`.
- Run `cargo clippy` before opening a PR. Don't add new findings
  even though the gate is currently soft.

### Comments

The codebase leans heavily on top-of-file module doc comments
explaining *why* the module exists and what its responsibilities
are. Match that style — a new file should open with a comment that
tells a future contributor (or your future self) what they're
looking at without scrolling.

---

## Testing

Stack: **vitest + jsdom + @testing-library/svelte**. Setup file at
`vitest.setup.ts` mocks the Tauri IPC surface (`invoke`,
`plugin-shell`, `plugin-notification`, `plugin-updater`) to no-op by
default. Individual tests override per-test via
`vi.mocked(invoke).mockResolvedValueOnce(...)`.

### What's worth testing

- **Pure functions.** `src/lib/utils/redact.ts` is the model — the
  test file exercises every pattern, the `containsSecret` probe,
  and the recursive redactor on a synthetic shape.
- **API client wire-shape mappings.** Every defensive parse in
  `ironclaw.ts` that fixed a real bug should have a regression
  test in `ironclaw.test.ts`. Today: `getHistory` turns-vs-messages,
  `gatewayStatus` `uptime_secs`/`uptime_seconds` aliasing, settings
  array → map fold. Add new ones when you add new defensive
  parses.
- **Store mutations.** `notifications.test.ts`, `pins.test.ts`, and
  `settings.test.ts` are the templates. Mock IPC, drive the store's
  public methods, assert on the rune state. The store is a class —
  instantiate a fresh one per test for isolation.
- **Component visible state.** `Icon.test.ts`, `MaskedValue.test.ts`,
  `MarkdownView.test.ts`, `Sparkline.test.ts`, `Toasts.test.ts` —
  render with @testing-library/svelte, assert on the DOM. Cover
  the visible branches and the edge cases (unknown icon name,
  empty markdown, etc.).

### What's NOT worth testing

- **Tauri IPC roundtrips.** If your test mocks `invoke` and then
  asserts the call shape, you've tested your mock, not the system.
  Skip it. Real IPC verification belongs in manual smoke testing.
- **Layout chrome.** The root layout's `onMount` boot sequence is
  side-effect-heavy and tied to real Tauri APIs. Don't try to
  unit-test it. Watch behavior in `npm run tauri dev`.
- **Network code paths that exercise SSE timing.** The SSE parser
  has a unit test for `findFrameEnd` and `parseSseFrame` (deterministic);
  the stream lifecycle does not (timing-sensitive, brittle).

### Running tests

```bash
npm run test                 # one-shot
npm run test:watch           # watch mode
npm run test:coverage        # one-shot with coverage report
```

---

## Adding a new API client method

The pattern, end to end:

1. **Add the type** to `src/lib/api/types.ts`. Define what the
   *consumer* sees — never the raw wire shape if it differs.

   ```ts
   export interface MyThing {
     id: string;
     label: string;
     created_at?: string;
   }
   ```

2. **Add the method** to `IronClawClient` in
   `src/lib/api/ironclaw.ts`. Place it near related methods (e.g.
   a new `/api/routines/...` method goes near `listRoutines`).
   Pattern:

   ```ts
   /**
    * Fetch the thing at `/api/things/{id}`.
    *
    * Wire (verified <date> against IronClaw <version>):
    *   `{thing: {id, name, ts}}`  (note `name` not `label`,
    *                              `ts` not `created_at`)
    *
    * Returns null on 404 — "no such thing" is a normal app state.
    */
   async getThing(id: string): Promise<MyThing | null> {
     try {
       const raw = await this.request<{
         thing?: { id?: string; name?: string; ts?: string };
       }>('GET', `/api/things/${encodeURIComponent(id)}`);
       const t = raw?.thing;
       if (!t?.id) return null;
       return {
         id: t.id,
         label: t.name ?? '(untitled)',
         created_at: t.ts
       };
     } catch (e) {
       if (e instanceof HttpError && e.status === 404) return null;
       throw e;
     }
   }
   ```

   Three load-bearing details:
   - The wire field names go in the inline type literal, not in
     the consumer-facing `MyThing`. The consumer-facing type is
     stable across gateway renames.
   - 404 returns `null`, not throw. "Not found" is a normal app
     state, not an error worth toasting. Network/5xx still throws.
   - `encodeURIComponent` the path segments. We've shipped one bug
     here already.

3. **If the response contains secrets**, expose two methods:

   ```ts
   async getThing(id: string): Promise<MyThing | null> {
     // returns the redacted variant — safe to render
   }

   async getThingRaw(id: string): Promise<MyThing | null> {
     // returns the unredacted variant — only call from edit sites,
     // and render every primitive through <MaskedValue />
   }
   ```

   Run the redactor via `redactJsonObject(raw)` inside `getThing`.
   The edit surface MUST call `getThingRaw` and persist the raw
   value back; if the editor reads the redacted variant and saves
   it, the masked dots replace the real secret on the server.

4. **If the method is a stream**, follow the
   `streamEvents` / `streamResponse` pattern. Push parsed events
   into a queue, expose an `AsyncIterable<ChatEvent>`. Add a
   normalizer (`normalizeEvent` / `mapResponsesEvent` are the
   templates) that returns `null` for events that should be
   dropped, and a tagged-union `ChatEvent` variant for events
   the UI cares about. Drops on the floor: progress chatter
   (`thinking`, `status`), control events without UI state.

5. **Write the test** in `src/lib/api/ironclaw.test.ts`. Mock
   `global.fetch` to return your wire-shape stub, assert the
   client returns the consumer-facing shape. Cover at least one
   "happy path" and one "wire shape evolved" case (e.g.
   `t.ts` is missing → `created_at` undefined).

   ```ts
   describe('IronClawClient.getThing', () => {
     it('maps the wire shape to MyThing', async () => {
       vi.spyOn(globalThis, 'fetch').mockResolvedValue(
         fetchOk({ thing: { id: 'x', name: 'hi', ts: 'now' } })
       );
       const c = makeClient();
       expect(await c.getThing('x')).toEqual({
         id: 'x', label: 'hi', created_at: 'now'
       });
     });

     it('returns null on 404', async () => { ... });
     it('falls back to "(untitled)" when name is missing', async () => { ... });
   });
   ```

---

## Adding a new surface

A "surface" is a top-level route under `src/routes/`. The scaffolding
list, in order:

1. **Create the route folder + page** at
   `src/routes/<name>/+page.svelte`. Sub-components go in the same
   folder (`src/routes/<name>/MyPanel.svelte`). Boilerplate:

   ```svelte
   <script lang="ts">
     import { onMount } from 'svelte';
     import { connection } from '$lib/stores/connection.svelte';
     import { toasts } from '$lib/stores/toasts.svelte';

     let loading = $state(false);
     let items = $state<MyThing[]>([]);
     let error = $state<string | null>(null);

     async function load() {
       const client = connection.client;
       if (!client) return;
       loading = true;
       error = null;
       try {
         items = await client.listThings();
       } catch (e) {
         error = (e as Error).message;
         toasts.show('Failed to load things', 'error');
       } finally {
         loading = false;
       }
     }

     onMount(load);
   </script>

   <div class="...">
     <!-- your UI -->
   </div>
   ```

2. **Add the sidebar nav row** in `src/lib/components/Sidebar.svelte`'s
   `items` array:

   ```ts
   {
     href: '/things',
     label: 'Things',
     icon: 'thing',           // see "Adding a new icon" below
     shortcut: '⌘N',
     badgeKey: 'things',      // optional — drives the per-row badge
     // optional gate:
     // showWhen: () => connection.settings.thingsEnabled === true
   },
   ```

   Pick a unique digit for the shortcut. Today 1–9 are taken; if you
   add a 10th surface, that's a sidebar redesign decision — talk
   about it in the PR.

3. **Wire the Cmd+N chord** in `src/routes/+layout.svelte`'s
   `ROUTES_BY_DIGIT` map:

   ```ts
   const ROUTES_BY_DIGIT: Record<string, string> = {
     // ...
     '0': '/things'   // or whatever digit you picked
   };
   ```

   If the surface is gated on a settings flag, add the gate at the
   point where `target` is dispatched (same pattern as `/admin` and
   `/missions`).

4. **Wire the CommandPalette entry**. The palette's nav section is
   driven by the same `items` array as the sidebar (the palette
   imports it from `Sidebar.svelte`), so adding the sidebar entry
   in step 2 gives you palette discovery for free.

5. **If the surface has searchable data**, register it with
   `GlobalSearch.svelte`. The component owns a list of "surfaces to
   search" — add a fetcher that returns `{ id, title, snippet,
   route }` items for your data.

6. **If the surface should redirect away when its gating flag
   flips off** (matching the `/admin` and `/missions` behavior),
   add a `$effect` in `+layout.svelte`:

   ```ts
   $effect(() => {
     if (
       connection.settings.thingsEnabled !== true &&
       page.url.pathname.startsWith('/things')
     ) {
       void goto('/settings');
     }
   });
   ```

7. **Update the CHANGELOG** under the next-release section.

---

## Adding a new icon

`src/lib/components/Icon.svelte` is a single inline-SVG component
with a string-union `IconName` type. To add one:

1. Open `Icon.svelte`. Two scripts:

   ```svelte
   <script lang="ts" context="module">
     export type IconName = 'attach' | 'bolt' | ... | 'thing';
                                                    // add yours
   </script>
   ```

2. Add the SVG path in the body's `{#if}` chain (kept alphabetical
   for sanity):

   ```svelte
   {:else if name === 'thing'}
     <path d="M3 12h18M12 3v18" />
   ```

   24x24 viewBox, `currentColor` stroke, `strokeWidth` configurable
   via the prop. Match the existing visual weight — the design
   harvest comments at the top of the file have the design-system
   reference if you need a hand.

3. Add a test case in `Icon.test.ts` if the glyph is non-trivial
   (multi-path, conditional rendering, etc.). For a single-path
   glyph, the existing fallback test already covers your case.

4. Use it: `<Icon name="thing" class="w-4 h-4 text-signal" />`.

---

## Extending the API client

See [Adding a new API client method](#adding-a-new-api-client-method).
The short form:

- Add the consumer-facing type in `types.ts`.
- Add the method on `IronClawClient`, with inline wire-shape type
  literals and defensive `??` fallbacks.
- If the response contains secrets, expose `*Raw` + redacted
  variants. Default to redacted; consumers that need raw must opt
  in by name.
- If the method streams, follow the `ChatEvent` normalizer pattern.
- Test in `ironclaw.test.ts` — at least happy path + one missing-
  field case.

---

## Forking the repo

1. Fork on GitHub.
2. Clone your fork.
3. Add the upstream:

   ```bash
   git remote add upstream <upstream-url>
   ```

4. Sync regularly:

   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

### Branch naming

`<type>/<short-description>`, where `<type>` is one of:

- `feat` — new feature or surface
- `fix` — bug fix
- `refactor` — code restructure with no behavior change
- `chore` — tooling / CI / dependency bumps
- `docs` — documentation only

Examples: `feat/things-surface`, `fix/sidecar-port-collision`,
`refactor/messages-store-types`, `chore/bump-svelte`.

### Commit messages

Short imperative subject line, blank, optional body. Group related
changes into one commit; don't split a single logical change across
multiple commits.

```
Add Things surface

Surfaces the /api/things endpoint with list/detail panes, wired into
the sidebar at Cmd+0 and gated on settings.thingsEnabled. Includes
ironclaw.ts client methods, types, tests, and a CommandPalette entry
via the shared Sidebar items array.
```

### PR checklist

- [ ] `npm run check` passes (0 errors, 0 warnings)
- [ ] `npm run verify:static-frontend` passes
- [ ] `npm run smoke:webui-static` passes
- [ ] `npm run test` passes
- [ ] `npm run build` passes
- [ ] If Rust changed: `cargo check` + `cargo clippy` pass
- [ ] Style-guard passes (no hardcoded accent hex)
- [ ] Tests added for new behavior
- [ ] CHANGELOG updated under the next-release section
- [ ] Surface change tested in `npm run tauri dev` (not just `npm run dev`)

---

## Release flow

End-to-end, when you're ready to ship a new version:

1. **Bump the version** across the three places that must agree:

   ```bash
   bash scripts/bump-version.sh 0.1.8
   ```

   This updates `package.json`, `src-tauri/tauri.conf.json`, and
   `src-tauri/Cargo.toml`. Semver-validated.

2. **Update `CHANGELOG.md`** under a new top-level header. Move the
   "unreleased" entries into the new version's header.

3. **Commit + tag**:

   ```bash
   git commit -am "v0.1.8"
   git tag v0.1.8
   git push && git push --tags
   ```

4. The `release.yml` workflow runs:
   - Installs both target triples
   - Downloads sidecar binaries
   - Builds `tauri bundle` for `aarch64-apple-darwin` and
     `x86_64-apple-darwin`
   - Signs updater artifacts if `TAURI_SIGNING_PRIVATE_KEY` +
     `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets are configured
   - Creates a GitHub release with `.dmg`, `.app.tar.gz`,
     `.app.tar.gz.sig` attached and auto-generated notes

5. **Verify** in the GitHub release UI that both DMGs are attached
   and `latest.json` (Tauri auto-generates this) is present. The
   updater endpoint in `tauri.conf.json` points at
   `https://github.com/nearai/ironclaw-desktop-app/releases/latest/download/latest.json`.

### First-time release setup (signing keypair)

Once per repository:

1. Generate the keypair:

   ```bash
   bash scripts/generate-updater-key.sh
   ```

   Writes to `~/.tauri/ironclaw-updater.key{,.pub}` and refuses to
   overwrite. Empty password by default.

2. Paste the printed public key into `src-tauri/tauri.conf.json`
   under `plugins.updater.pubkey`. Commit.

3. In the GitHub repo settings → Actions → Secrets, add:
   - `TAURI_SIGNING_PRIVATE_KEY` — `cat ~/.tauri/ironclaw-updater.key | pbcopy`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — empty (or whatever you set)

Until both secrets are present and the pubkey is committed, builds
succeed but produce unsigned artifacts; auto-update verification
will fail until signing is wired.

### Probing for newly-landed gateway endpoints

We stub methods on `IronClawClient` for endpoints the gateway
doesn't yet expose (thread delete, routine create, memory delete,
etc.). To find ones that have shipped upstream:

```bash
bash scripts/probe-blocked-endpoints.sh
```

Reads your configured SSH alias (`IRONCLAW_SSH_ALIAS`) to discover the
live gateway token. Yellow `WARN` lines mean an endpoint started
responding — time to wire UI for it. Always exits 0 (discovery tool,
not a CI gate).

---

## Questions / discussion

Open an issue or a draft PR with the question in the body — even a
half-formed direction is easier to react to than a question in the
abstract.
