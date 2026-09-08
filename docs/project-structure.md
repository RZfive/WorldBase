# WorldBase Monorepo 目录规划

本文档是仓库目录和 workspace 边界的单一说明。当前 Electron 代码已位于 `apps/electron/`，默认且唯一持续开发的 Rust Agent Loop 位于 `harness-rs/`，Flutter 移动端位于 `apps/mobile/`。目录规划固定三个 workspace 的边界；Node Agent Loop 仅作为冻结兼容代码保留。

## 1. 目标目录

```text
the-world/
├── apps/
│   ├── electron/                    # Workspace 1: 现有 Electron/Vue 桌面端
│   │   ├── electron/                 # Electron main/preload 与宿主适配
│   │   │   ├── main.ts
│   │   │   ├── preload.ts
│   │   │   └── main-process/
│   │   ├── src/                      # Vue renderer、TS main 业务与共享类型
│   │   │   ├── main/                 # Electron 宿主业务 + 冻结的 TS Harness 兼容实现
│   │   │   ├── renderer/             # Vue 3 UI
│   │   │   ├── shared/               # Electron/renderer 共享类型
│   │   │   └── locales/              # 国际化资源
│   │   ├── public/                   # 应用静态资源
│   │   ├── scripts/                  # Electron 构建和冒烟测试
│   │   ├── tests/                    # Electron/TS 契约测试
│   │   ├── package.json              # pnpm workspace manifest
│   │   ├── vite.config.ts
│   │   ├── tsconfig*.json
│   │   └── electron-builder.json
│   │
│   └── mobile/                      # Workspace 3: Flutter 移动端（FFI + Rust Agent Loop 已接入）
│       ├── lib/
│       │   ├── app/                  # 路由、主题、应用级配置
│       │   ├── core/
│       │   │   ├── harness_client.dart # WebSocket JSON-RPC client
│       │   │   ├── harness_ffi.dart  # mobile-ffi 生命周期与 C ABI
│       │   │   └── providers.dart    # 移动端运行时状态模型
│       │   ├── features/
│       │   │   ├── chat/
│       │   │   ├── launchpad/
│       │   │   ├── studio/
│       │   │   └── settings/
│       │   └── l10n/                 # Flutter 本地化资源
│       ├── test/                     # Flutter 测试
│       ├── android/                  # Android 宿主工程
│       ├── ios/                      # iOS 宿主工程
│       ├── pubspec.yaml              # Flutter workspace manifest
│       └── analysis_options.yaml
│
├── harness-rs/                      # Workspace 2: Rust Agent Loop / 公共能力（Cargo workspace）
│   ├── Cargo.toml                    # 唯一 Rust workspace manifest
│   ├── crates/
│   │   ├── protocol/                 # JSON-RPC schema、capabilities、事件帧
│   │   ├── providers/                # OpenAI/Anthropic provider 与 SSE
│   │   ├── tools/                    # 全部内置 Agent 工具和 feature gate
│   │   ├── core/                     # Agent loop、session/turn、权限、dispatcher
│   │   ├── group/                    # 群组协作状态机
│   │   ├── memory/                   # SQLite/FTS5 长期记忆
│   │   ├── skills/                   # YAML Skill 加载与执行
│   │   ├── scheduler/                # 定时任务
│   │   ├── mcp-client/               # MCP stdio/SSE/HTTP 客户端
│   │   ├── docs/                     # 文档解析与编辑能力
│   │   ├── search/                   # Glob/Grep 代码搜索
│   │   ├── app-server/               # Electron stdio NDJSON JSON-RPC
│   │   ├── cli/                      # worldbase chat/run/projects
│   │   ├── exec/                     # 桌面命令执行与沙箱
│   │   ├── project-runtime/          # 桌面 bundled Node/pnpm
│   │   ├── im-gateway/               # 桌面 IM webhook 连接器
│   │   └── mobile-ffi/               # Flutter FFI 导出面（移动端 feature）
│   ├── tests/                        # Rust 单元、集成和协议契约测试
│   └── fixtures/                     # 跨 workspace 测试数据
│
├── docs/                             # 仓库级架构、PRD 和迁移文档
├── scripts/                          # 跨 workspace 的编排脚本（仅保留共享脚本）
├── .github/                          # CI/CD（Rust、Electron、Flutter 分开构建）
├── README.md
└── .gitignore
```

`dist/`、`dist-electron/`、`release/`、Cargo `target/`、Flutter 构建产物和用户运行时数据均为生成目录，不纳入源代码布局。

## 2. 三个 workspace 的边界

| Workspace | Manifest | 负责内容 | 不负责内容 |
|---|---|---|---|
| `apps/electron` | `package.json` | 窗口、菜单、托盘、IPC、Vue UI、桌面宿主能力、Electron 打包、冻结 TS 兼容后端和 Rust host bridge | Rust Agent Loop 的跨端核心、Rust 文档公共能力 |
| `harness-rs` | `Cargo.toml` | Agent Loop、协议/provider、公共工具、群组/Memory/Skill/MCP、文档解析与基础编辑、app-server、CLI、移动 FFI | Vue/Flutter UI；Electron 展示层和非必要宿主服务 |
| `apps/mobile` | `pubspec.yaml` | Flutter UI、导航、移动生命周期、权限和平台 channel、FFI 调用 | Agent Loop、Rust 工具实现和 Rust 状态机 |

三者属于同一个 Git monorepo，但不是一个跨语言的统一依赖 workspace：

```text
apps/electron  ── stdio JSON-RPC ──>  harness-rs (app-server)
apps/mobile    ── dart:ffi + loopback WS ──> harness-rs (mobile-ffi)
harness-rs     ── in-process ──> cli；mobile-ffi ── loopback WS ──> Flutter
```

依赖方向必须保持单向。`harness-rs` 不依赖 Electron 或 Flutter；Electron 不直接链接 Rust crate；Flutter 不复制 Harness 业务逻辑。Rust `protocol` crate 是线协议的规范来源，Electron 与 Flutter 适配器通过跨端契约测试保持字段兼容。

## 3. Harness workspace 的 crate 分层

```text
harness-rs/crates/
├── protocol, providers
├── core, tools
├── group, memory, skills, scheduler, mcp-client, docs, search
├── app-server, cli
├── exec, project-runtime, im-gateway
└── mobile-ffi
```

- **Agent Loop/共享能力层**：`protocol`、`providers`、`core`、`tools`、`group`、`memory`、`skills`、`scheduler`、`mcp-client`、`docs`、`search`。
- **可选桌面接入层**：`app-server`、`exec`、`project-runtime`、`im-gateway`、`cli`；其中 `app-server` 是 Electron Rust 模式的接入点，其他桌面 crate 不构成 Agent Loop 完成的前置条件。
- **移动接入层**：`mobile-ffi`。它只导出 FFI API 和能力协商，不承载 Flutter 页面。
- 移动构建当前主要通过 transport capability ceiling、initialize 能力协商和显式工具白名单隐藏子进程、端口监听、webhook 及 Electron-only 能力；Rust Agent Loop 和文档公共能力仍可复用。`desktop-support` 目前是兼容 feature，不应被描述为完整编译期裁剪。

## 4. 从当前目录迁移到目标目录

| 当前路径 | 目标路径 | 处理方式 |
|---|---|---|
| 根目录 `electron/` | `apps/electron/electron/` | Electron workspace 搬迁时移动 |
| 根目录 `src/` | `apps/electron/src/` | 保持现有模块结构；Agent Loop 通过 Rust app-server 接入，展示层和宿主模块不要求迁移 |
| 根目录 `public/` | `apps/electron/public/` | 随 Electron workspace 移动 |
| 根目录 `scripts/`、`tests/` | `apps/electron/scripts/`、`apps/electron/tests/` | 归属 Electron 的脚本和测试随 workspace 移动；跨 workspace 脚本留在根 `scripts/` |
| 根目录 `package.json`、Vite/TS/Electron 配置 | `apps/electron/` | Electron workspace 独立管理依赖和构建；根 `package.json` 后续仅保留编排脚本 |
| `harness-rs/` | `harness-rs/` | 当前路径即目标 workspace，扩展 crates，不拆成 `harness-core`/`harness-desktop` |
| `apps/mobile/` | `apps/mobile/` | Flutter workspace 已创建并通过 `mobile-ffi` 接入 Harness |
| `docs/` | `docs/` | 保留在 monorepo 根，记录跨 workspace 契约 |

Electron 搬迁已完成，根目录不再承载 Electron 应用源码；`harness-rs/` 作为唯一 Rust workspace 保留，避免出现两份 Rust 源码。后续新增的跨 workspace 脚本才放在根 `scripts/`。

## 5. 用户运行时目录

运行时数据不放入任一 workspace：

```text
~/.the-world/
├── projects/                       # 生成的子项目
├── snapshots/                      # 项目快照
├── config.json
└── app.sqlite
```

Electron、CLI 和移动端通过宿主注入的路径/存储接口访问运行时数据，不在仓库中共享可变状态。

## 6. 迁移约束

1. 先完成目录和 workspace 边界，再接入 Rust Agent Loop 和稳定的 host bridge。
2. `protocol` 的 schema 与版本号先冻结，Electron/Flutter 适配器与契约测试随协议一起维护。
3. 新 provider、Agent 编排、协议和通用工具只在 Rust 增加；Node `AIEngine`/AgentCore/provider 不再开发。`projects/runtime`、窗口/UI、LAN/IM 入口和宿主展示继续由 Electron 维护。
4. Flutter 通过 `mobile-ffi` 和能力协商复用 Rust Agent Loop 与文档公共能力，不复制 Electron 工具实现。
5. 每个 workspace 独立构建、测试和发布；根目录 CI 只负责编排，不混用依赖缓存和产物目录。

新增功能的 ownership 判断、实现入口和测试门禁见 [rust-harness-development.md](rust-harness-development.md)。
