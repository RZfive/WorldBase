# 🌍 WorldBase

<div align="center">

[![Build](https://github.com/RZfive/WorldBase/actions/workflows/build.yml/badge.svg)](https://github.com/RZfive/WorldBase/actions/workflows/build.yml) [![License](https://img.shields.io/github/license/RZfive/WorldBase)](LICENSE) [![Release](https://img.shields.io/github/v/release/RZfive/WorldBase)](https://github.com/RZfive/WorldBase/releases) [![Stars](https://img.shields.io/github/stars/RZfive/WorldBase?style=social)](https://github.com/RZfive/WorldBase/stargazers) [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/RZfive/WorldBase)

![Rust](https://img.shields.io/badge/Rust-1.80%2B-DEA584?logo=rust&logoColor=white) ![Electron](https://img.shields.io/badge/Electron-Desktop-47848F?logo=electron&logoColor=white) ![Vue](https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white) ![Flutter](https://img.shields.io/badge/Flutter-Mobile-02569B?logo=flutter&logoColor=white)

</div>

**English** | [简体中文](README.md)

AI-powered project generator and manager. Describe what you want in natural language and WorldBase builds a complete, runnable web app — then keeps managing it: the agent can read and write your project's code directly, call its APIs to verify changes, and query its database for analysis.

## Why WorldBase

Most agent products compete on cloud-side capability ceilings. WorldBase takes a different position: a **personalized, personal, general-purpose agent** — deliberately not chasing the route of cloud products like Codex or WorkBuddy.

- **General-purpose, not just coding** — generate apps, edit code, verify changes via APIs, query databases for analysis: the agent works with your whole project, and writing code is only one part of the job
- **Fully local data** — sessions, memory, child-project code, and databases all live in local SQLite you can inspect, back up, or delete at any time; your data only goes to the model API you configure — point it at a local OpenAI-compatible endpoint and nothing ever leaves your machine
- **Personalization that compounds** — memory and the user model accumulate around you, so the agent knows your projects and habits better the longer you use it
- **Trust through verifiability** — desktop, mobile, and CLI all run on your machine with no cloud service required beyond the model API; trust comes from holding your own data, not from promises

## Highlights

- 🗣️ **Chat-driven development** — describe the app, get a full front-end / full-stack web project
- ✏️ **Direct code editing** — the agent reads and writes any file in child projects; changes take effect immediately
- 🔌 **API self-verification** — the agent calls the running project's APIs to verify its own changes
- 📊 **Data analysis** — query child-project databases directly for stats and trends
- ⚙️ **Process management** — automatic start/stop and port allocation for child projects
- 🌐 **LAN access** — built-in LAN server exposes every project on your local network
- 📱 **Three clients, one core** — Electron desktop (Windows/macOS/Linux), Flutter mobile (Android/iOS/macOS), and a Rust CLI, all driven by the same Rust agent harness

## Architecture

A monorepo of three independent workspaces. Rust is the reusable agent-loop core:

```
apps/electron/    Desktop: Electron + Vue 3 UI and host services; Rust harness as the default backend
harness-rs/       Core: providers, tool orchestration, sessions/memory, group collaboration, MCP,
                  document parsing, scheduler, and the cross-client protocol crate
apps/mobile/      Mobile: Flutter app running the Rust harness in-process via FFI
```

- The Rust workspace owns the agent loop: provider adapters, streaming, tool-call cycle, permissions and plans, cancellation/resume, sub-agents and group orchestration, and the cross-client protocol.
- Electron owns the desktop host: windows, IPC, child-project runtime and LAN serving, page automation, native integrations.
- Mobile needs no external services: the harness starts in-process via FFI and the UI talks to it over an authenticated loopback WebSocket.

Full details in [HARNESS.md](HARNESS.md) and [docs/rust-harness-architecture.md](docs/rust-harness-architecture.md).

## Getting Started

Requirements: Node.js + pnpm 10, Rust ≥ 1.80 (via rustup), and Flutter ≥ 3.41 for the mobile app.

### Desktop

```bash
pnpm --dir apps/electron install
pnpm --dir apps/electron electron:dev
```

The main process uses the runtime-builtin `node:sqlite` — no native module build required. A mock provider works out of the box; set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` for real models. On Windows, if packaging a child project triggers a symlink permission error, the build automatically requests elevation.

### CLI

```bash
cd harness-rs
cargo build --release

export ANTHROPIC_API_KEY=sk-ant-...
cargo run --bin worldbase -- chat "analyze this project's structure"
```

### Mobile

```bash
pnpm run dev:macos      # macOS
pnpm run dev:android    # Android (starts an emulator automatically)
pnpm run dev:ios        # iOS simulator
```

Each script cross-compiles the Rust harness, deploys the artifacts, boots the device, and runs `flutter run`. Android needs Android Studio (SDK API 35/36 + a modern NDK) plus `rustup target add aarch64-linux-android`; iOS needs Xcode with a simulator runtime plus `rustup target add aarch64-apple-ios-sim`. Environment variables for AVD/SDK/NDK selection are documented in [HARNESS.md](HARNESS.md).

## Testing

```bash
pnpm run test:rust        # full Rust workspace tests
pnpm run harness:check    # main gate: Rust fmt/tests + Electron typecheck/tests
pnpm run test:flutter     # mobile host dylib + full Flutter test suite
pnpm run test:e2e:macos   # end-to-end GUI test on macOS
```

## Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Model API keys | built-in mock when unset |
| `OPENAI_BASE_URL` | OpenAI-compatible endpoint | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | Model name | `gpt-4o` |

## Tech Stack

| Layer | Technology |
| --- | --- |
| Desktop shell | Electron (main process shipped as V8 bytecode) |
| UI | Vue 3 + Vite |
| Agent core | Rust (tokio / axum / rusqlite) |
| Mobile | Flutter + dart:ffi |
| Database | SQLite (`node:sqlite` / bundled rusqlite, FTS5) |
| Models | Anthropic / OpenAI-compatible APIs (function calling) |

## Documentation

- [User manual](docs/user-manual.md)
- [Harness architecture](HARNESS.md) · [Rust harness architecture](docs/rust-harness-architecture.md) · [Development guide](docs/rust-harness-development.md)
- More design docs in [docs/](docs/)

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.en.md](CONTRIBUTING.en.md) (中文版 [CONTRIBUTING.md](CONTRIBUTING.md)).

## Community

This project endorses the [LINUX DO](https://linux.do) community.

## Contributors

<a href="https://github.com/RZfive/WorldBase/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=RZfive/WorldBase" alt="WorldBase contributors" />
</a>

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). Third-party license notices: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Star History

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=RZfive/WorldBase&type=Date&theme=dark" />
  <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=RZfive/WorldBase&type=Date" />
  <a href="https://star-history.com/#RZfive/WorldBase&Date">
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=RZfive/WorldBase&type=Date" />
  </a>
</picture>
