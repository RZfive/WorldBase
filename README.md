# 🌍 WorldBase

[![Build](https://github.com/RZfive/WorldBase/actions/workflows/build.yml/badge.svg)](https://github.com/RZfive/WorldBase/actions/workflows/build.yml)
[![License](https://img.shields.io/github/license/RZfive/WorldBase)](LICENSE)
[![Release](https://img.shields.io/github/v/release/RZfive/WorldBase)](https://github.com/RZfive/WorldBase/releases)
[![Stars](https://img.shields.io/github/stars/RZfive/WorldBase?style=social)](https://github.com/RZfive/WorldBase/stargazers)

![Rust](https://img.shields.io/badge/Rust-1.80+-DEA584?logo=rust&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-桌面端-47848F?logo=electron&logoColor=white)
![Vue](https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white)
![Flutter](https://img.shields.io/badge/Flutter-移动端-02569B?logo=flutter&logoColor=white)

[English](README.en.md) | **简体中文**

AI 驱动的项目生成器与管理平台。用自然语言描述需求，WorldBase 就能生成完整可运行的 Web 应用，并持续管理它：Agent 可以直接读写子项目的代码、调用其 API 验证修改效果、查询其数据库做分析。

## 为什么是 WorldBase

大多数 AI Agent 产品在比拼云端的能力上限。WorldBase 的定位不同：一个**个性化的个人通用 Agent**，不追逐 Codex、WorkBuddy 这类云端产品的路线。

- **通用而不只是编码** — 生成应用、修改代码、调 API 验证、查数据库做分析：Agent 面对的是你的整个项目，写代码只是其中一环
- **数据完全本地** — 会话、记忆、子项目代码与数据库全部存储在本机 SQLite，随时可查看、备份、删除；数据只发往你配置的模型 API，接 OpenAI 兼容的本地端点即可做到完全不出本机
- **个性化长期沉淀** — 记忆与用户模型围绕你持续积累，越用越懂你的项目和习惯
- **可信来自可验证** — 桌面、移动、CLI 全部在本机运行，除模型 API 外不依赖任何云端服务；信任建立在"数据就在你手里"，而不是承诺

## 核心特性

- 🗣️ **对话即开发** — 描述应用，得到完整的前端 / 全栈 Web 项目
- ✏️ **直接修改代码** — Agent 读写子项目任意文件，改完即生效
- 🔌 **API 自动验证** — Agent 调用运行中项目的 API，自动验证自己的修改
- 📊 **数据分析** — 直接查询子项目数据库，做统计与趋势分析
- ⚙️ **进程管理** — 自动管理子项目启停与端口分配
- 🌐 **局域网访问** — 内置 LAN Server，局域网内直接访问所有项目
- 📱 **三端同核** — Electron 桌面端（Windows/macOS/Linux）、Flutter 移动端（Android/iOS/macOS）、Rust CLI，共用同一个 Rust Agent 核心

## 架构

Monorepo，三个独立 workspace，Rust 是可复用的 Agent Loop 核心：

```
apps/electron/    桌面端：Electron + Vue 3，负责 UI 与桌面宿主能力；Rust Harness 为默认后端
harness-rs/       核心：providers、工具编排、会话/记忆、群组协作、MCP、文档解析、
                  定时任务与跨端协议
apps/mobile/      移动端：Flutter，Rust harness 经 FFI 在进程内运行
```

- Rust workspace 负责 Agent 循环：Provider 适配、流式输出、工具调用、权限与 Plan、取消续传、子 Agent 与群组编排、跨端协议
- Electron 负责桌面宿主：窗口、IPC、子项目运行时与 LAN 服务、页面自动化、原生集成
- 移动端无需任何外部服务：harness 经 FFI 进程内启动，UI 通过鉴权 loopback WebSocket 通信

完整细节见 [HARNESS.md](HARNESS.md) 与 [docs/rust-harness-architecture.md](docs/rust-harness-architecture.md)。

## 快速开始

依赖：Node.js + pnpm 10、Rust ≥ 1.80（rustup 安装）；移动端另需 Flutter ≥ 3.41。

### 桌面端

```bash
pnpm --dir apps/electron install
pnpm --dir apps/electron electron:dev
```

主进程使用运行时内置的 `node:sqlite`，无需构建原生模块。开箱自带 mock provider；设置 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 使用真实模型。Windows 下打包子项目触发 symlink 权限错误时，构建阶段会自动请求管理员授权。

### CLI

```bash
cd harness-rs
cargo build --release

export ANTHROPIC_API_KEY=sk-ant-...
cargo run --bin worldbase -- chat "帮我分析项目结构"
```

### 移动端

```bash
pnpm run dev:macos      # macOS
pnpm run dev:android    # Android（自动启动模拟器）
pnpm run dev:ios        # iOS 模拟器
```

脚本会自动完成 Rust 交叉编译 → 部署产物 → 启动设备 → `flutter run`。Android 需要 Android Studio（SDK API 35/36 + 现代 NDK）和 `rustup target add aarch64-linux-android`；iOS 需要 Xcode（含模拟器运行时）和 `rustup target add aarch64-apple-ios-sim`。AVD / SDK / NDK 相关环境变量见 [HARNESS.md](HARNESS.md)。

## 测试

```bash
pnpm run test:rust        # Rust workspace 全量测试
pnpm run harness:check    # 主门禁：Rust fmt/测试 + Electron 类型检查/测试
pnpm run test:flutter     # 移动端宿主 dylib + Flutter 全量测试
pnpm run test:e2e:macos   # macOS GUI 端到端测试
```

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | 模型 API 密钥 | 未设置时使用内置 mock |
| `OPENAI_BASE_URL` | OpenAI 兼容端点 | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | 模型名称 | `gpt-4o` |

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 桌面壳 | Electron（主进程以 V8 字节码打包） |
| 前端 | Vue 3 + Vite |
| Agent 核心 | Rust（tokio / axum / rusqlite） |
| 移动端 | Flutter + dart:ffi |
| 数据库 | SQLite（`node:sqlite` / rusqlite bundled，FTS5） |
| 模型接入 | Anthropic / OpenAI 兼容 API（function calling） |

## 文档

- [用户手册](docs/user-manual.md)
- [Harness 架构](HARNESS.md) · [Rust Harness 架构](docs/rust-harness-architecture.md) · [开发指南](docs/rust-harness-development.md)
- 更多设计文档见 [docs/](docs/)

## 贡献

欢迎 issue 与 PR，见 [CONTRIBUTING.md](CONTRIBUTING.md)（英文版 [CONTRIBUTING.en.md](CONTRIBUTING.en.md)）。

## 社区

本项目认可 [LINUX DO](https://linux.do) 社区。

## 安全

请通过私密渠道报告漏洞，见 [SECURITY.md](SECURITY.md)。

## 许可证

[Apache-2.0](LICENSE)。第三方许可证声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
