# 贡献指南

[English](CONTRIBUTING.en.md) | **简体中文**

欢迎为 WorldBase 贡献代码、文档与问题反馈。动手前建议先读 [README](README.md) 与 [HARNESS.md](HARNESS.md)，了解项目定位与架构。

## 环境准备

- **Node.js + pnpm 10** — 版本已在仓库 `packageManager` 字段固定，`corepack enable` 后直接使用；CI 使用 Node 22
- **Rust ≥ 1.80** — 推荐 [rustup](https://rustup.rs/) 安装
- **仅移动端改动需要**：Flutter ≥ 3.41、Android Studio（SDK API 35/36 + 现代 NDK）或 Xcode，详见 [README · 移动端](README.md#快速开始)

## 代码结构

Monorepo 包含三个独立 workspace：

- `apps/electron/` — Electron + Vue 3 桌面端
- `harness-rs/` — Rust Agent Loop 核心（providers、工具编排、会话/记忆、跨端协议）
- `apps/mobile/` — Flutter 移动端，经 FFI 进程内运行 harness

目录边界与各目录职责见 [docs/project-structure.md](docs/project-structure.md)，核心架构见 [docs/rust-harness-architecture.md](docs/rust-harness-architecture.md)。

## 开发与调试

```bash
# 桌面端
pnpm --dir apps/electron install
pnpm --dir apps/electron electron:dev

# CLI
cd harness-rs
cargo run --bin worldbase -- chat "帮我分析项目结构"
```

未配置 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 时自动使用内置 mock provider，无密钥也能完整跑通开发循环。

## 测试

**提 PR 前请在本地通过主门禁：**

```bash
pnpm run harness:check    # Rust fmt + Rust 全量测试 + Electron 类型检查 + Electron 测试
```

按改动范围补充：

```bash
pnpm run test:rust        # Rust workspace 全量测试
pnpm run test:flutter     # 移动端宿主 dylib + Flutter 测试
pnpm run test:e2e:macos   # macOS GUI 端到端测试
```

## 提交与 PR 约定

- **提交信息**使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)（`feat:` / `fix:` / `docs:` / `chore:` / `ci:` …），描述用中文或英文均可
- **PR 保持聚焦**：一个 PR 解决一件事，方便审查与回滚
- **大改动先讨论**：涉及架构或外部行为的变更，先开 issue 对齐方案；设计文档放 `docs/`，可参考现有 PRD 与设计文档的写法
- 合并到 main 后 CI 会自动构建四端产物；正式发布由维护者推送 `vX.Y.Z` tag 触发 Draft Release，贡献者无需关心发版

## 安全

**请勿通过公开 issue 或 PR 报告安全漏洞**，走私密渠道报告，见 [SECURITY.md](SECURITY.md)。

## 许可

提交 PR 即表示你同意贡献以 [Apache-2.0](LICENSE) 授权。
