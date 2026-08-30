# 🌍 WorldBase

AI 驱动的项目生成器与管理平台。通过自然语言对话创建完整的 Web 应用，并持续管理、修改和分析项目数据。

## 🚀 当前状态

- **Electron App**: 生产版本 (TypeScript) — `apps/electron/` 独立 workspace
- **Rust Harness**: P0–P1 完成并三端跑通 ✅ — `harness-rs/` 唯一 Cargo workspace（17 个 crate，50 个测试）
- **Flutter 移动端**: 已建成并接入 harness ✅ — `apps/mobile/`（iOS 风格四 Tab，FFI 进程内连接）

## 项目结构

```
apps/electron/         # Workspace 1: 已迁移的原始 Electron/Vue 桌面端
├── electron/
├── src/
├── public/
└── package.json

harness-rs/            # Workspace 2: 唯一 Rust Cargo workspace
└── crates/{protocol,providers,tools,core,cli,...}

apps/mobile/           # Workspace 3: Flutter 移动端（已接入 Rust Harness）
└── lib/{app,core,features}/
```

## 快速开始

### Rust Harness CLI

```bash
cd harness-rs

# 构建
cargo build --release

# 运行
export ANTHROPIC_API_KEY=sk-ant-...
cargo run --bin worldbase -- chat "帮我分析项目结构"
```

### Electron App

```bash
pnpm --dir apps/electron install
pnpm --dir apps/electron electron:dev
```

安装依赖时会自动将 `better-sqlite3` 等原生模块重建为当前 Electron 版本；如果安装时使用了 `--ignore-scripts` 或替换了 `node_modules`，请先运行 `pnpm --dir apps/electron rebuild:native`。

详细架构见 [docs/rust-harness-architecture.md](docs/rust-harness-architecture.md) 和 [HARNESS.md](HARNESS.md)

---

## 📱 移动端（Flutter + Rust FFI）

移动端是完整的 Flutter 应用，Rust harness 通过 **FFI 进程内**运行（`dart:ffi` 加载
`libworldbase_mobile_ffi`，`worldbase_start` 在应用进程内启动完整 harness，UI 经
loopback WS 同协议通信）——无需任何外部服务，界面上也没有连接配置。

### 一键启动（根目录）

```bash
pnpm run dev:macos      # macOS 端
pnpm run dev:android    # Android 端（自动启动模拟器）
pnpm run dev:ios        # iOS 模拟器端
```

脚本会自动完成：Rust 交叉编译 → 产物放入对应平台目录 → 启动设备 → `flutter run`。

### 依赖要求

**通用（三端都需要）**

| 依赖 | 说明 |
|------|------|
| [Flutter SDK](https://docs.flutter.dev/get-started/install) | ≥ 3.41（含 Dart 3.11） |
| Rust（rustup 方式安装） | 工具链 ≥ 1.80；**不要**依赖 Homebrew cargo（缺少跨目标 std） |
| pnpm / Node.js | 根 workspace 编排 |

**macOS 端**（`dev:macos`）

| 依赖 | 说明 |
|------|------|
| Xcode | 用于 Flutter macOS 构建与代码签名 |
| rustup 工具链 | 宿主 target `aarch64-apple-darwin`（默认已装） |

**Android 端**（`dev:android`）

| 依赖 | 说明 |
|------|------|
| Android Studio | 提供 JBR（Java）与 SDK 管理器 |
| Android SDK | API 35/36 + platform-tools + emulator |
| NDK | r27（`~/Library/Android/sdk/ndk/`），Rust 交叉编译链接器与 ring 的 C 工具链 |
| rustup target | `rustup target add aarch64-linux-android` |
| AVD | 任一手机模拟器（默认找 `Medium_Phone_API_36.1`，可用 `ANDROID_AVD` 覆盖） |

**iOS 模拟器端**（`dev:ios`）

| 依赖 | 说明 |
|------|------|
| Xcode + iOS 模拟器运行时 | 无运行时先执行 `xcodebuild -downloadPlatform iOS`（约 8.5GB） |
| rustup target | `rustup target add aarch64-apple-ios-sim` |

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ANDROID_AVD` | Android 启动用的模拟器名称 | `Medium_Phone_API_36.1` |
| `ANDROID_SDK` | Android SDK 路径 | `~/Library/Android/sdk` |
| `ANDROID_ABI` | Android 构建架构 | `arm64-v8a` |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | 真实模型（可选） | 缺省用内置 mock（支持对话里"做一个「XX」应用"生成轻应用） |

### 移动端测试

```bash
pnpm run test:rust      # Rust 全量测试（50 个）
pnpm run test:flutter   # Flutter E2E（全功能面 + FFI 生命周期专项）
pnpm run test:e2e:macos # GUI 集成测试（真实窗口驱动全流程）
```

> 移动端细节（架构、能力协商、轻应用、已知遗留）见 [HARNESS.md](HARNESS.md)。

---

## 核心特性

- **AI 驱动的项目生成** — 通过对话创建完整的前端/全栈 Web 应用
- **代码直接修改** — 主 AI 可以读写子项目的任何文件，直接修改后端代码
- **API 调用与测试** — 主 AI 调用运行中子项目的 API，自动验证修改效果
- **数据分析** — 直接查询子项目数据库，进行统计分析和趋势分析
- **进程管理** — 自动管理子项目的启停和端口分配
- **局域网访问** — 通过 LAN Server 在局域网内访问所有项目

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面壳 | Electron |
| 前端 | Vue 3 + Vite |
| 主进程后端 | Node.js (Electron main process) |
| LAN 服务 | Express.js + http-proxy-middleware |
| 数据库 | better-sqlite3 |
| AI | OpenAI-compatible API (function calling) |

## 项目结构

```
the-world/
├── apps/electron/             # Electron workspace（已完成迁移）
├── harness-rs/                # Rust Harness workspace
├── apps/mobile/               # Flutter workspace（未来）
├── docs/                      # 跨 workspace 架构文档
├── scripts/                   # 跨 workspace 编排脚本
└── package.json               # 根编排入口（迁移后不持有 Electron 依赖）
```

详细架构文档请查看 [`docs/`](./docs/) 目录。

重点方案文档：

- [`docs/custom-agent-memory-im-architecture.md`](./docs/custom-agent-memory-im-architecture.md) — 自定义 Agent、长期记忆、群协作与未来 IM 接入的整体升级方案

## 开发

```bash
# 安装 Electron 依赖
pnpm --dir apps/electron install

# 启动开发服务器 (仅前端)
pnpm --dir apps/electron dev

# 启动 Electron 开发
pnpm --dir apps/electron electron:dev

# 构建应用
pnpm --dir apps/electron electron:build
```

当前打包流程会将 Electron 主进程编译为 V8 字节码 (`.jsc`) 并通过 loader 启动；preload 产物保留为压缩后的普通 JS，以避免安装包中的 `contextBridge`/IPC 桥接在字节码模式下失效。开发态 `pnpm --dir apps/electron electron:dev` 仍使用普通 JS 产物，便于调试。

> Windows 下如果生成/打包 Next.js standalone 应用时触发 symlink 权限错误，WorldBase 会在构建阶段自动拉起管理员授权。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `OPENAI_API_KEY` | OpenAI API 密钥 | - |
| `OPENAI_BASE_URL` | API 基础 URL | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | 模型名称 | `gpt-4o` |

## 许可证

MIT
