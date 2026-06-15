# Slack Personal (User-Token) WASM Tool

A standalone WASM component that lets IronClaw act **as you** in Slack, using a
personal **user token** (`xoxp-`) rather than a bot token. This is what enables
reading your full message history, your DMs, and searching everything you can
see — things a bot token fundamentally cannot do.

This is the user-identity counterpart to the bot-identity `slack` tool. The two
are deliberately separate tools with **separate secrets** (`slack_user_token`
vs `slack_bot_token`) so the personal token never collides with the bot token
used by the Slack channel or the `slack` tool.

## Features

- **search_messages**: Search across all messages you can see (DMs, group DMs,
  and channels you belong to). Supports Slack search operators like
  `from:@me`, `in:#channel`, `after:2024-01-01`.
- **list_conversations**: List channels, private channels, DMs (`im`), and
  group DMs (`mpim`) you belong to — use this to discover DM conversation IDs.
- **get_conversation_history**: Read history of any channel or DM by ID, with
  `latest`/`oldest` pagination cursors.
- **get_user_info**: Look up a user's name, real name, and email.
- **send_message**: Post a message as you (requires `chat:write`).

## Prerequisites

1. **Rust toolchain** with the WASM target:
   ```bash
   rustup target add wasm32-wasip2
   ```

2. **cargo-component** for building WASM components:
   ```bash
   cargo install cargo-component --locked
   ```

3. A **Slack User OAuth Token** (`xoxp-`). Create a private app at
   https://api.slack.com/apps and, under **OAuth & Permissions**, add these
   **User Token Scopes** (not Bot Token Scopes):
   - `search:read` — search your messages
   - `channels:history`, `groups:history`, `im:history`, `mpim:history` — read
     public/private channels, DMs, group DMs
   - `channels:read`, `groups:read`, `im:read`, `mpim:read` — enumerate them
   - `users:read` — resolve user info
   - `chat:write` — post as you (optional)

   Install the app to your workspace and copy the **User OAuth Token**.

## Building

```bash
cd tools-src/slack_user
cargo component build --release --target wasm32-wasip2
```

## Configuring

Store your user token under the `slack_user_token` secret (via the Extensions
UI for "Slack (personal)", which offers a single token-paste field). The token
is injected as a bearer credential at the host boundary; the WASM component
never sees it.

## Security

A user token acts as you and can read your private conversations. Treat it like
a password. IronClaw stores it encrypted in the secrets store and scans all tool
output for credential leakage before returning it.
