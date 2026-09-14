# 🌍 WorldBase

AI 驱动的项目生成器与管理平台。通过自然语言对话创建完整的 Web 应用，并持续管理、修改和分析项目数据。

## 🚀 当前状态

- **Electron App**: Electron/Vue 产品壳与桌面宿主 — `apps/electron/` 独立 workspace
- **Rust Agent Loop**: 默认且唯一持续开发的 Harness，已接入 Electron/Flutter — `harness-rs/` 唯一 Cargo workspace
- **Rust 文档能力**: 文档解析与基础编辑已迁移到 `docs` crate，支持跨端复用；Electron 的窗口、展示、宿主服务和桌面业务工具不要求迁移到 Rust
- **Flutter 移动端**: 已接入 Rust Agent Loop ✅ — `apps/mobile/`（iOS 风格四 Tab，FFI 进程内连接）；文档 artifact 对外路径已脱敏，Android/iOS 真机打包与生命周期验证待完成

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

## Rust / Electron 边界

当前目标不是把 Electron 的展示层和所有宿主服务重写成 Rust，而是让 Rust 成为可复用的 Agent Loop 核心：

- Rust 必须稳定负责：Provider 适配、消息/会话上下文、流式事件、tool-call 循环、权限与 Plan、取消与断点续传、子 Agent/群组编排，以及跨端协议。
- Rust 优先负责：跨平台文档解析和基础文档编辑；这部分能力可以被 CLI、Electron 和 Flutter 复用。
- Electron 可以继续负责：窗口和 renderer 展示、IPC/preload、项目运行时与 LAN、页面自动化、原生对话框/通知、图片队列/UI 存储、IM webhook 入口，以及需要 Electron 数据和生命周期语义的宿主工具。
- Electron 中的 Rust 模式因此是“Rust Agent Loop + Electron host tools”，68 个公开工具的契约对齐不代表 68 个 handler 都必须迁移成 Rust。
- Rust 是新安装默认后端；Node/TS Agent Loop 只保留显式旧配置兼容，不接收新 provider、编排或通用工具功能。Rust 启动失败会明确报错，不会静默回退 TS。

这条边界把 Agent 核心迁移和 Electron 产品层迁移解耦，Rust 的完成标准是 Agent Loop 和跨端能力可靠，而不是删除全部 TypeScript。

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

Electron 主进程使用运行时内置的 `node:sqlite`，不需要额外安装或重建 SQLite 原生 npm 模块。

详细架构见 [docs/rust-harness-architecture.md](docs/rust-harness-architecture.md) 和 [HARNESS.md](HARNESS.md)；新增功能流程见 [docs/rust-harness-development.md](docs/rust-harness-development.md)。

---

## 📱 移动端（Flutter + Rust FFI）

移动端是完整的 Flutter 应用，Rust harness 通过 **FFI 进程内**运行（`dart:ffi` 加载
`libworldbase_mobile_ffi`，`worldbase_start` 在应用进程内启动完整 harness，
`worldbase_get_auth_token` 读取本次启动的随机 token，UI 经鉴权 loopback WS 同协议通信）——
无需任何外部服务，界面上也没有连接配置。

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
| NDK | Android SDK 下已安装的现代 NDK，提供 Rust 交叉编译 linker 与 C 工具链 |
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
| `ANDROID_SDK_ROOT` / `ANDROID_HOME` / `ANDROID_SDK` | Android SDK 路径（按此顺序解析） | macOS `~/Library/Android/sdk`；Linux `~/Android/Sdk` |
| `ANDROID_NDK_HOME` / `ANDROID_NDK_ROOT` | 固定 Android NDK 路径；CI 推荐显式设置 | 缺省从 SDK 的 `ndk/` 自动选择 |
| `ANDROID_NDK_VERSION` | 从 SDK 的 `ndk/` 选择指定版本 | 缺省选择已安装的最新版本 |
| `ANDROID_ABI` | Android 构建架构 | `arm64-v8a` |
| `ANDROID_TARGET` / `ANDROID_API` | Rust Android target 与最小 API（独立构建脚本） | `aarch64-linux-android` / `21` |
| `RUSTUP_TOOLCHAIN` | 覆盖 rustup 当前工具链，适合 CI 固定 Rust 版本 | rustup 当前/目录覆盖工具链 |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | 真实模型（可选） | 缺省用内置 mock（支持对话里"做一个「XX」应用"生成轻应用） |

### 移动端测试

```bash
pnpm run test:rust      # Rust workspace 全量测试
pnpm run harness:check  # Rust + Electron Harness 主门禁
pnpm run test:flutter   # 重建无桌面 feature 的宿主 dylib，再跑 Flutter 全量测试
pnpm run harness:test:android-build # 探测 SDK/NDK 后交叉编译 Android arm64 release
pnpm run test:e2e:macos # GUI 集成测试（真实窗口驱动全流程）
```

Android 和 iOS 的 Rust 构建入口分别为 `scripts/build_rust_android.sh` 与
`scripts/build_rust_ios.sh`，两者都会使用当前 rustup 工具链并为移动产物传入
`--no-default-features`。iOS 脚本通常由 CocoaPods 构建阶段调用；手动构建前需先用
`rustup target add aarch64-apple-ios aarch64-apple-ios-sim` 安装对应 target。

> 移动端细节（架构、能力协商、轻应用、已知遗留）见 [HARNESS.md](HARNESS.md)。

截至 **2026-09-08**，Rust workspace、Electron 回归和 Flutter 全量 88 项测试通过；macOS FFI 启动→握手→对话→持久化→停止主路径通过，Android/iOS arm64 release 交叉编译通过。文档 artifact 内部路径与公开 DTO 已拆分；公开 RPC 返回 workspace 相对路径或外部文件 basename。

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
| 数据库 | SQLite（Electron `node:sqlite` / Rust bundled `rusqlite`） |
| AI | OpenAI-compatible API (function calling) |

## 项目结构

```
the-world/
├── apps/electron/             # Electron workspace（展示层/宿主能力；Rust Harness 默认）
├── harness-rs/                # Rust Agent Loop / 公共能力 workspace
├── apps/mobile/               # Flutter workspace（已接入 Rust Agent Loop）
├── docs/                      # 跨 workspace 架构文档
├── scripts/                   # 跨 workspace 编排脚本
└── package.json               # 根编排入口（迁移后不持有 Electron 依赖）
```

详细架构文档请查看 [`docs/`](./docs/) 目录。

重点方案文档：

- [`docs/custom-agent-memory-im-architecture.md`](./docs/custom-agent-memory-im-architecture.md) — 自定义 Agent、长期记忆、群协作与未来 IM 接入的整体升级方案

## macOS 安装说明

如果 macOS 提示“无法打开 WorldBase”或应用来自身份不明的开发者，可以先将应用拖入“应用程序”文件夹，然后在终端执行以下命令移除下载隔离标记：

```bash
xattr -dr com.apple.quarantine "/Applications/WorldBase.app"
```

如果应用不在默认位置，请将命令中的 `/Applications/WorldBase.app` 替换为实际的 `.app` 路径。也可以先在终端输入 `xattr -dr com.apple.quarantine `（末尾保留空格），再把应用从 Finder 拖入终端，按回车执行。

执行完成后重新打开应用。如果仍然无法启动，请在 Finder 中右键点击应用，选择“打开”，并在系统设置的“隐私与安全性”中允许打开该应用。

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
