# Contributing

**English** | [简体中文](CONTRIBUTING.md)

Thanks for contributing to WorldBase — code, docs, and issue reports are all welcome. Before diving in, please read the [README](README.en.md) and [HARNESS.md](HARNESS.md) to get familiar with the project's positioning and architecture.

## Setup

- **Node.js + pnpm 10** — the version is pinned in the repo's `packageManager` field; `corepack enable` and you're set. CI runs Node 22
- **Rust ≥ 1.80** — installed via [rustup](https://rustup.rs/)
- **Mobile changes only**: Flutter ≥ 3.41, plus Android Studio (SDK API 35/36 + a modern NDK) or Xcode — see the [README mobile section](README.en.md#getting-started)

## Code Layout

The monorepo has three independent workspaces:

- `apps/electron/` — Electron + Vue 3 desktop app
- `harness-rs/` — the Rust agent-loop core (providers, tool orchestration, sessions/memory, cross-client protocol)
- `apps/mobile/` — Flutter app running the harness in-process via FFI

Directory boundaries and responsibilities are documented in [docs/project-structure.md](docs/project-structure.md); the core architecture in [docs/rust-harness-architecture.md](docs/rust-harness-architecture.md).

## Development

```bash
# Desktop
pnpm --dir apps/electron install
pnpm --dir apps/electron electron:dev

# CLI
cd harness-rs
cargo run --bin worldbase -- chat "analyze this project's structure"
```

Without `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` set, the built-in mock provider kicks in — the full dev loop works without any API key.

## Testing

**Please pass the main gate locally before opening a PR:**

```bash
pnpm run harness:check    # Rust fmt + full Rust tests + Electron typecheck + Electron tests
```

Add what's relevant to your change:

```bash
pnpm run test:rust        # full Rust workspace tests
pnpm run test:flutter     # mobile host dylib + Flutter test suite
pnpm run test:e2e:macos   # end-to-end GUI test on macOS
```

## Commits and Pull Requests

- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:` / `fix:` / `docs:` / `chore:` / `ci:` …); descriptions in Chinese or English are both fine
- **Keep PRs focused** — one PR addresses one thing, which makes review and revert easier
- **Discuss big changes first** — for anything touching architecture or external behavior, open an issue to align before implementing; put design docs under `docs/`, following the existing PRDs and design documents
- Merging to main triggers CI builds for all four platforms; releases are cut by maintainers pushing a `vX.Y.Z` tag to create a Draft Release — contributors don't need to worry about shipping

## Security

**Please do not report security vulnerabilities through public issues or pull requests** — use the private channel described in [SECURITY.md](SECURITY.md).

## License

By submitting a PR, you agree your contribution is licensed under [Apache-2.0](LICENSE).
