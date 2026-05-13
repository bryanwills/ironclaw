<p align="center">
  <img src="ironclaw.png?v=2" alt="IronClaw" width="200"/>
</p>

<h1 align="center">IronClaw</h1>

<p align="center">
  <strong>Your secure personal AI assistant, always on your side</strong>
</p>

<p align="center">
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT%20OR%20Apache%202.0-blue.svg" alt="License: MIT OR Apache-2.0" /></a>
  <a href="https://t.me/ironclawAI"><img src="https://img.shields.io/badge/Telegram-%40ironclawAI-26A5E4?style=flat&logo=telegram&logoColor=white" alt="Telegram: @ironclawAI" /></a>
  <a href="https://www.reddit.com/r/ironclawAI/"><img src="https://img.shields.io/badge/Reddit-r%2FironclawAI-FF4500?style=flat&logo=reddit&logoColor=white" alt="Reddit: r/ironclawAI" /></a>
  <a href="https://gitcgr.com/nearai/ironclaw">
    <img src="https://gitcgr.com/badge/nearai/ironclaw.svg" alt="gitcgr" />
  </a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <a href="#philosophy">Philosophy</a> •
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#security">Security</a> •
  <a href="#architecture">Architecture</a>
</p>

---

## Philosophy

IronClaw is built on a simple principle: **your AI assistant should work for you, not against you**.

In a world where AI systems are increasingly opaque about data handling and aligned with corporate interests, IronClaw takes a different approach:

- **Your data stays yours** - All information is stored locally, encrypted, and never leaves your control
- **Transparency by design** - Open source, auditable, no hidden telemetry or data harvesting
- **Self-expanding capabilities** - Build new tools on the fly without waiting for vendor updates
- **Defense in depth** - Multiple security layers protect against prompt injection and data exfiltration

IronClaw is the AI assistant you can actually trust with your personal and professional life.

## Features

### Security First

- **WASM Sandbox** - Untrusted tools run in isolated WebAssembly containers with capability-based permissions
- **Credential Protection** - Secrets are never exposed to tools; injected at the host boundary with leak detection
- **Prompt Injection Defense** - Pattern detection, content sanitization, and policy enforcement
- **Endpoint Allowlisting** - HTTP requests only to explicitly approved hosts and paths

### Always Available

- **Multi-channel** - REPL, HTTP webhooks, WASM channels (Telegram, Slack), and web gateway
- **Docker Sandbox** - Isolated container execution with per-job tokens and orchestrator/worker pattern
- **Web Gateway** - Browser UI with real-time SSE/WebSocket streaming
- **Routines** - Cron schedules, event triggers, webhook handlers for background automation
- **Heartbeat System** - Proactive background execution for monitoring and maintenance tasks
- **Parallel Jobs** - Handle multiple requests concurrently with isolated contexts
- **Self-repair** - Automatic detection and recovery of stuck operations

### Self-Expanding

- **Dynamic Tool Building** - Describe what you need, and IronClaw builds it as a WASM tool
- **MCP Protocol** - Connect to Model Context Protocol servers for additional capabilities
- **Plugin Architecture** - Drop in new WASM tools and channels without restarting

### Persistent Memory

- **Hybrid Search** - Full-text + vector search using Reciprocal Rank Fusion
- **Workspace Filesystem** - Flexible path-based storage for notes, logs, and context
- **Identity Files** - Maintain consistent personality and preferences across sessions

## Installation

### Prerequisites

- Rust 1.92+
- PostgreSQL 15+ with [pgvector](https://github.com/pgvector/pgvector) extension
- NEAR AI account (authentication handled via setup wizard)
- `libclang` and a working C toolchain if you build the WeChat voice/SILK path from source

## Download or Build

Visit [Releases page](https://github.com/nearai/ironclaw/releases/) to see the latest updates.

<details>
  <summary>Install via Windows Installer (Windows)</summary>

Download the [Windows Installer](https://github.com/nearai/ironclaw/releases/latest/download/ironclaw-x86_64-pc-windows-msvc.msi) and run it.

</details>

<details>
  <summary>Install via powershell script (Windows)</summary>

```sh
irm https://github.com/nearai/ironclaw/releases/latest/download/ironclaw-installer.ps1 | iex
```

</details>

<details>
  <summary>Install via shell script (macOS, Linux, Windows/WSL)</summary>

```sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/nearai/ironclaw/releases/latest/download/ironclaw-installer.sh | sh
```
</details>

<details>
  <summary>Install via Homebrew (macOS/Linux)</summary>

```sh
brew install ironclaw
```

</details>

<details>
  <summary>Compile the source code (Cargo on Windows, Linux, macOS)</summary>

Install it with `cargo`, just make sure you have [Rust](https://rustup.rs) installed on your computer.

```bash
# Clone the repository
git clone https://github.com/nearai/ironclaw.git
cd ironclaw

# Build
cargo build --release

# Run tests
cargo test
```

For **full release** (after modifying channel sources), run `./scripts/build-all.sh` to rebuild channels first.

> **Optional:** WeChat voice notes (`audio/silk`) require the standalone
> `ironclaw-silk-decoder` helper to be transcribable. It's excluded from the
> default workspace build because `silk-codec` pulls in `bindgen`/`libclang`.
> Build it separately with `./crates/ironclaw_silk_decoder/build.sh` (needs
> libclang + a C toolchain) and put the resulting binary on `$PATH`, beside
> the `ironclaw` binary, or pointed at by `IRONCLAW_SILK_DECODER`. Without
> it, voice messages are still delivered — just as raw `audio/silk` blobs.

</details>

### Database Setup

```bash
# Create database
createdb ironclaw

# Enable pgvector
psql ironclaw -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

## Configuration

Run the setup wizard to configure IronClaw:

```bash
ironclaw onboard
```

The wizard handles database connection, NEAR AI authentication (via browser OAuth),
and secrets encryption (using your system keychain). Settings are persisted in the
connected database; bootstrap variables (e.g. `DATABASE_URL`, `LLM_BACKEND`) are
written to `~/.ironclaw/.env` so they are available before the database connects.

### Alternative LLM Providers

IronClaw defaults to NEAR AI but supports many LLM providers out of the box.
Built-in providers include **Anthropic**, **OpenAI**, **GitHub Copilot**, **Google Gemini**, **MiniMax**,
**Mistral**, and **Ollama** (local). OpenAI-compatible services like **OpenRouter**
(300+ models), **Together AI**, **Fireworks AI**, and self-hosted servers (**vLLM**,
**LiteLLM**) are also supported.

Select your provider in the wizard, or set environment variables directly:

```env
# Example: MiniMax (built-in, 204K context)
LLM_BACKEND=minimax
MINIMAX_API_KEY=...

# Example: OpenAI-compatible endpoint
LLM_BACKEND=openai_compatible
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-...
LLM_MODEL=anthropic/claude-sonnet-4
```

See [docs/capabilities/llm-providers.md](docs/capabilities/llm-providers.md) for a full provider guide.

## Security

IronClaw implements defense in depth to protect your data and prevent misuse.

### WASM Sandbox

All untrusted tools run in isolated WebAssembly containers:

- **Capability-based permissions** - Explicit opt-in for HTTP, secrets, tool invocation
- **Endpoint allowlisting** - HTTP requests only to approved hosts/paths
- **Credential injection** - Secrets injected at host boundary, never exposed to WASM code
- **Leak detection** - Scans requests and responses for secret exfiltration attempts
- **Rate limiting** - Per-tool request limits to prevent abuse
- **Resource limits** - Memory, CPU, and execution time constraints

```
WASM ──► Allowlist ──► Leak Scan ──► Credential ──► Execute ──► Leak Scan ──► WASM
         Validator     (request)     Injector       Request     (response)
```

### Prompt Injection Defense

External content passes through multiple security layers:

- Pattern-based detection of injection attempts
- Content sanitization and escaping
- Policy rules with severity levels (Block/Warn/Review/Sanitize)
- Tool output wrapping for safe LLM context injection

### Data Protection

- All data stored locally in your PostgreSQL database
- Secrets encrypted with AES-256-GCM
- No telemetry, analytics, or data sharing
- Full audit log of all tool executions

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                          Channels                              │
│  ┌──────┐  ┌──────┐   ┌─────────────┐  ┌─────────────┐         │
│  │ REPL │  │ HTTP │   │WASM Channels│  │ Web Gateway │         │
│  └──┬───┘  └──┬───┘   └──────┬──────┘  │ (SSE + WS)  │         │
│     │         │              │         └──────┬──────┘         │
│     └─────────┴──────────────┴────────────────┘                │
│                              │                                 │
│                    ┌─────────▼─────────┐                       │
│                    │    Agent Loop     │  Intent routing       │
│                    └────┬──────────┬───┘                       │
│                         │          │                           │
│              ┌──────────▼────┐  ┌──▼───────────────┐           │
│              │  Scheduler    │  │ Routines Engine  │           │
│              │(parallel jobs)│  │(cron, event, wh) │           │
│              └──────┬────────┘  └────────┬─────────┘           │
│                     │                    │                     │
│       ┌─────────────┼────────────────────┘                     │
│       │             │                                          │
│   ┌───▼─────┐  ┌────▼────────────────┐                         │
│   │ Local   │  │    Orchestrator     │                         │
│   │Workers  │  │  ┌───────────────┐  │                         │
│   │(in-proc)│  │  │ Docker Sandbox│  │                         │
│   └───┬─────┘  │  │   Containers  │  │                         │
│       │        │  │ ┌───────────┐ │  │                         │
│       │        │  │ │Worker / CC│ │  │                         │
│       │        │  │ └───────────┘ │  │                         │
│       │        │  └───────────────┘  │                         │
│       │        └─────────┬───────────┘                         │
│       └──────────────────┤                                     │
│                          │                                     │
│              ┌───────────▼──────────┐                          │
│              │    Tool Registry     │                          │
│              │  Built-in, MCP, WASM │                          │
│              └──────────────────────┘                          │
└────────────────────────────────────────────────────────────────┘
```

### Core Components

| Component | Purpose |
|-----------|---------|
| **Agent Loop** | Main message handling and job coordination |
| **Router** | Classifies user intent (command, query, task) |
| **Scheduler** | Manages parallel job execution with priorities |
| **Worker** | Executes jobs with LLM reasoning and tool calls |
| **Orchestrator** | Container lifecycle, LLM proxying, per-job auth |
| **Web Gateway** | Browser UI with chat, memory, jobs, logs, extensions, routines |
| **Routines Engine** | Scheduled (cron) and reactive (event, webhook) background tasks |
| **Workspace** | Persistent memory with hybrid search |
| **Safety Layer** | Prompt injection defense and content sanitization |

### Reborn Crate Map

IronClaw Reborn splits the host into 45 narrow Rust crates under [`crates/`](crates/). Authority, persistence, runtime dispatch, and product surfaces each own their own boundary. See [`crates/README.md`](crates/README.md) for the full map; the groups below summarize where to look.

**Core vocabulary and shared contracts**

| Crate | Role |
| --- | --- |
| [`ironclaw_common`](crates/ironclaw_common) | Shared workspace types and utilities (kept small). |
| [`ironclaw_host_api`](crates/ironclaw_host_api) | Canonical Reborn authority vocabulary: actors, scopes, policies, capability requests, decisions, obligations. |
| [`ironclaw_runtime_policy`](crates/ironclaw_runtime_policy) | Resolves runtime profiles from host configuration and policy inputs. |
| [`ironclaw_architecture`](crates/ironclaw_architecture) | Workspace architecture contract tests; fails builds when crate-dependency boundaries drift. |

**Authority, safety, and policy gates**

| Crate | Role |
| --- | --- |
| [`ironclaw_authorization`](crates/ironclaw_authorization) | Evaluates host-API authority contracts before capability execution. |
| [`ironclaw_approvals`](crates/ironclaw_approvals) | Durable approval requests and scoped authorization leases. |
| [`ironclaw_trust`](crates/ironclaw_trust) | Host-controlled trust-class policy engine. |
| [`ironclaw_resources`](crates/ironclaw_resources) | Resource reservation governor (budgets, reservations). |
| [`ironclaw_safety`](crates/ironclaw_safety) | Prompt-injection defense, input validation, secret-leak detection. |
| [`ironclaw_secrets`](crates/ironclaw_secrets) | Tenant-scoped secret storage and leasing via opaque `SecretHandle`. |
| [`ironclaw_network`](crates/ironclaw_network) | Network policy and HTTP egress boundary (DNS, allowlists, host-mediated outbound). |
| [`ironclaw_filesystem`](crates/ironclaw_filesystem) | Scoped filesystem service for host-controlled path access. |

**Capability execution and runtime lanes**

| Crate | Role |
| --- | --- |
| [`ironclaw_capabilities`](crates/ironclaw_capabilities) | Caller-facing capability invocation host. Coordinates authorization, approvals, run-state, and dispatch. |
| [`ironclaw_dispatcher`](crates/ironclaw_dispatcher) | Composition-only runtime dispatch contracts; wires validated descriptors to runtime lanes. |
| [`ironclaw_processes`](crates/ironclaw_processes) | Host-tracked background process lifecycle. |
| [`ironclaw_scripts`](crates/ironclaw_scripts) | Script/CLI capability runner contracts. |
| [`ironclaw_mcp`](crates/ironclaw_mcp) | Adapts manifest-declared MCP tools into IronClaw capabilities. |
| [`ironclaw_wasm`](crates/ironclaw_wasm) | Reborn WASM component runtime lane (component model / WIT). |
| [`ironclaw_wasm_product_adapters`](crates/ironclaw_wasm_product_adapters) | WASM-side adapters bridging guest components into product-facing shapes. |
| [`ironclaw_extensions`](crates/ironclaw_extensions) | Extension manifest, lifecycle, and registration contracts. |
| [`ironclaw_host_runtime`](crates/ironclaw_host_runtime) | Narrow `HostRuntime` facade and production composition around capability hosting. |

**Durable state, eventing, and read models**

| Crate | Role |
| --- | --- |
| [`ironclaw_events`](crates/ironclaw_events) | Redacted runtime/audit vocabulary plus durable append-log traits. |
| [`ironclaw_reborn_event_store`](crates/ironclaw_reborn_event_store) | Concrete Reborn event/audit store backends and backend-profile validation. |
| [`ironclaw_event_projections`](crates/ironclaw_event_projections) | Product-facing read models over durable runtime and audit logs. |
| [`ironclaw_run_state`](crates/ironclaw_run_state) | Current lifecycle state for host-managed invocations. |
| [`ironclaw_threads`](crates/ironclaw_threads) | Canonical session-thread and transcript service contracts. |
| [`ironclaw_conversations`](crates/ironclaw_conversations) | Conversation binding tying product conversations to Reborn threads. |
| [`ironclaw_memory`](crates/ironclaw_memory) | Memory document service adapters (workspace/memory semantics). |
| [`ironclaw_outbound`](crates/ironclaw_outbound) | Metadata-only outbound state: notification policy, subscription cursors, delivery status. |
| [`ironclaw_storage`](crates/ironclaw_storage) | Shared storage primitives used by event/state backends. |

**Reborn composition, agent loop, and product surfaces**

| Crate | Role |
| --- | --- |
| [`ironclaw_reborn`](crates/ironclaw_reborn) | Standalone Reborn composition and adapters (package: `llm_gateway`). |
| [`ironclaw_reborn_composition`](crates/ironclaw_reborn_composition) | Wiring layer that assembles Reborn services for the host runtime. |
| [`ironclaw_reborn_config`](crates/ironclaw_reborn_config) | Reborn boot-config boundary: typed config, profiles, and validation. |
| [`ironclaw_reborn_cli`](crates/ironclaw_reborn_cli) | Reborn-first CLI surface (command modules, completion, shell). |
| [`ironclaw_loop_support`](crates/ironclaw_loop_support) | Adapts durable Reborn boundaries into the narrow agent-loop host port. |
| [`ironclaw_turns`](crates/ironclaw_turns) | Host-layer turn coordination contracts. |
| [`ironclaw_product_adapters`](crates/ironclaw_product_adapters) | Product-adapter contracts mapping Reborn state/events into product shapes. |
| [`ironclaw_product_workflow`](crates/ironclaw_product_workflow) | Product workflow facade: inbound turn service, idempotency ledger, binding resolution. |
| [`ironclaw_engine`](crates/ironclaw_engine) | Unified thread / capability / CodeAct execution engine. |
| [`ironclaw_llm`](crates/ironclaw_llm) | LLM provider routing and abstraction. |
| [`ironclaw_skills`](crates/ironclaw_skills) | Skill selection, scoring, and management. |
| [`ironclaw_gateway`](crates/ironclaw_gateway) | Browser gateway frontend assets, layout, and widget extension system. |
| [`ironclaw_tui`](crates/ironclaw_tui) | Modular Ratatui-based terminal UI. |
| [`ironclaw_telegram_v2_adapter`](crates/ironclaw_telegram_v2_adapter) | Telegram v2 channel adapter for the Reborn product surface. |
| [`ironclaw_silk_decoder`](crates/ironclaw_silk_decoder) | Standalone WeChat `audio/silk` decoder helper (built separately; needs `libclang`). |

Rule of thumb: if a change adds new authority or persistence, put it in the crate that owns that boundary instead of threading it through a UI or runtime crate.

## Usage

Engine v2 is opt-in right now. If you want to run the new engine instead of the legacy agent loop, start IronClaw with `ENGINE_V2=true`. See [Engine v2 architecture](docs/internal/engine-v2-architecture.md#enabling-engine-v2) for more details.

```bash
# First-time setup (configures database, auth, etc.)
ironclaw onboard

# Start interactive REPL
cargo run

# Start interactive REPL with engine v2
ENGINE_V2=true cargo run

# Engine v2 with debug logging
ENGINE_V2=true RUST_LOG=ironclaw=debug cargo run
```

## Development

```bash
# Format code
cargo fmt

# Lint
cargo clippy --all --benches --tests --examples --all-features

# Run tests
createdb ironclaw_test
cargo test

# Run specific test
cargo test test_name
```

- **Channels**: See [docs/channels/overview.mdx](docs/channels/overview.mdx) for setup of Telegram, Discord, and other channels.
- **Changing channel sources**: Run `./channels-src/telegram/build.sh` before `cargo build` so the updated WASM is bundled.

## OpenClaw Heritage

IronClaw is a Rust reimplementation inspired by [OpenClaw](https://github.com/openclaw/openclaw). See [FEATURE_PARITY.md](FEATURE_PARITY.md) for the complete tracking matrix.

Key differences:

- **Rust vs TypeScript** - Native performance, memory safety, single binary
- **WASM sandbox vs Docker** - Lightweight, capability-based security
- **PostgreSQL vs SQLite** - Production-ready persistence
- **Security-first design** - Multiple defense layers, credential protection

## License

Licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT License ([LICENSE-MIT](LICENSE-MIT))

at your option.
