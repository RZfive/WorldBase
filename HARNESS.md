# WorldBase Rust Harness

`the-world` 采用 monorepo，但按语言和运行时边界拆成三个独立 workspace：现有 Electron、Rust Harness、Flutter 移动端。三个 workspace 独立构建、测试和发布，不合并成一个跨语言依赖图。

## Workspace 结构

```text
the-world/
├── apps/
│   ├── electron/                  # Workspace 1: 现有 Electron/Vue 桌面端
│   └── mobile/                    # Workspace 3: Flutter 移动端（FFI + Rust Agent Loop 已接入）
├── harness-rs/                    # Workspace 2: 唯一 Rust Cargo workspace
│   ├── Cargo.toml
│   ├── crates/
│   │   ├── protocol/              # JSON-RPC schema、capabilities、事件帧（camelCase 冻结）
│   │   ├── providers/             # Anthropic / OpenAI(兼容端点) / Mock + SSE 解析
│   │   ├── tools/                 # Agent 工具编排、跨端工具、Electron host 兼容层和能力过滤
│   │   ├── core/                  # Hub、Agent loop、权限引擎、dispatcher
│   │   ├── group/                 # 群组协作状态机（5 模式 + 黑板）
│   │   ├── memory/                # SQLite/FTS5 会话/消息/长期记忆/设置
│   │   ├── skills/                # YAML Skill 加载与执行
│   │   ├── scheduler/             # 标准 5 段 cron 定时任务（SQLite 持久化）
│   │   ├── mcp-client/            # MCP stdio/HTTP 客户端
│   │   ├── docs/                  # 跨端文档解析与基础编辑（xlsx/pdf/docx/pptx/csv/md）
│   │   ├── search/                # Glob/Grep（ignore crate，尊重 gitignore）
│   │   ├── app-server/            # stdio NDJSON JSON-RPC（Electron 接入）
│   │   ├── cli/                   # worldbase chat/run/projects
│   │   ├── exec/                  # 命令执行 + macOS Seatbelt 沙箱（desktop 域）
│   │   ├── project-runtime/       # Node/pnpm 全栈项目运行时（desktop 域）
│   │   ├── im-gateway/            # IM webhook（通用/飞书/Slack 适配，desktop 域）
│   │   └── mobile-ffi/            # Flutter FFI 导出面（start/get_auth_token/stop）
│   └── crates/core/tests/e2e.rs   # 端到端集成测试（mock provider 驱动完整链路）
└── docs/                          # monorepo 架构与迁移文档
```

## 依赖关系

```text
apps/mobile    -- dart:ffi 三个 C ABI ----------> harness-rs/mobile-ffi    # ✅ 主路径（进程内）
apps/mobile    -- WS 127.0.0.1:<动态端口> ------> mobile-ffi 内置 loopback # ✅ 已跑通
apps/electron  -- spawn stdio NDJSON JSON-RPC --> harness-rs/app-server   # Rust 默认；TS 仅兼容
harness-rs/cli -- in-process -------------------> harness-rs/core
```

移动端 **FFI 进程内启动**：`dart:ffi` 加载 `libworldbase_mobile_ffi`，依次使用 `worldbase_start`、`worldbase_get_auth_token` 与 `worldbase_stop`。启动函数返回动态端口并为本次生命周期生成随机 64 字符 token；Flutter 随后通过 mobile-ffi 私有的鉴权 loopback WebSocket JSON-RPC 传输（`transport.rs`）通信，UI 不展示连接状态/配置。

- `harness-rs` 是唯一 Rust workspace，不拆分多个 Cargo workspace。
- `harness-rs` 不依赖 Electron 或 Flutter；Electron 不直接链接 Rust crate；Flutter 不复制 Agent 业务逻辑。
- `protocol` crate 是 Rust 侧协议 schema 来源，JSON 字段统一 camelCase；Electron/Flutter 适配器目前手写，并由跨端契约测试防止漂移。
- 当前移动构建没有真实的编译期 desktop feature 裁剪；`desktop-support` 是空兼容 feature。FFI transport capability ceiling、握手能力交集/排除项并集与显式移动工具白名单共同过滤 `exec`、`project-runtime`、`im-gateway` 等桌面能力。
- Electron 设置中的“对话 Harness”默认使用 `Rust（app-server）`。`TypeScript（冻结兼容）` 只为已显式保存的旧配置保留，不再承接新功能。Rust 负责 Agent Loop、provider、会话/事件、权限/Plan、取消/续传和工具编排；Electron 继续承担窗口、renderer 展示、IPC/preload、项目运行时、LAN、页面自动化、图片队列/UI 存储和宿主适配。

## 当前状态（2026-09-08）

- ✅ **Agent Loop 主体完成**：`protocol`、`providers`（SSE 跨 chunk 解析、OpenAI-compatible、Anthropic、Mock、图片生成）、`core`（Hub/Agent loop/权限 ask-allow-deny/Plan/事件总线/中止/续传/宿主反向 RPC/工具结果存储）、`group`、`memory`、`skills`、`mcp-client`、`app-server`、`cli` 和 `mobile-ffi` 均已有可运行实现。
- ✅ **跨端文档能力已迁移**：`docs` crate 已提供 xlsx/xls、pdf、docx、pptx、csv、md、json、txt 等解析，以及 docx/xlsx/pptx/csv/文本的基础写入；Electron 复杂展示、原文件打开、Office 兼容和桌面 UI 语义仍可由宿主层实现。
- ✅ **Rust workspace 验证通过**：`cargo test --manifest-path harness-rs/Cargo.toml --workspace` 通过；core 单元/E2E、provider、tools、docs、project-runtime、IM connector 等均有测试覆盖。
- ✅ **协议新增（对齐桌面端）**：`provider.list/save/delete/setActive`（多供应商）、`agent.list/get/save/delete`（Agent 绑定人设/供应商/模型）、`studio.generate/list/delete`（绘图）、`conversation.fork`（分叉 fork 模式 / 就地编辑 inplace 模式）、`group.inject`（HITL 澄清注入）、`group.board.update`（黑板操作）、`skill.save/delete`、`host.respond`（反向请求应答）、`ask_user`/`read_current_page`/`interact_current_page` 宿主域工具。
- ✅ **Electron 默认走 Rust**：`ai:chat`、`ai:chatStream`、`ai:updateSessionAuthMode`、`ai:stopStream` 按设置选择后端；缺失或非法配置归一化为 Rust，只有显式 `ts` 才进入冻结兼容实现。Rust 不可用或握手失败会向调用方报错，不会静默启动 Node Agent Loop。
- ✅ **Electron 工具 ownership 已明确**：现有 68 个 Node 宿主工具是冻结兼容子集，名称、description 和 JSON Schema 由快照检查保持一致。新 Rust 工具可通过 `electron_native()` 进入 Electron 目录，无需新增 Node placeholder，且不能被同名 host override 覆盖。
- ✅ **移动端 Agent Loop 主路径已跑通**：`apps/mobile` Flutter 工程（四 Tab：对话/应用/绘图/我的，**iOS/Apple 风格 UI**——浅色分组列表、iOS 信息气泡、Cupertino 分段控件/弹窗/动作表、毛玻璃 TabBar，设计系统在 `lib/core/ios_ui.dart`）；这里的“跑通”指 Rust Agent Loop、FFI/WS 协议和主要功能面，不等同于已完成真机发布验证：
  - **对话**：会话抽屉（搜索/重命名/删除/分叉标记）、消息长按菜单（复制/编辑重发-分叉模式/就地覆盖/从此分叉）、Agent 选择、流式气泡、工具卡片、权限确认弹窗、ask_user 问答弹窗
  - **群组**：桌面 5 模式选择、成员编辑器、成员气泡、六字段黑板查看、HITL 注入
  - **绘图 Studio**：提示词 + 8 种比例 + 数量 → 生成（OpenAI images / mock SVG）→ 图库网格（`/studio/{id}` 取图）→ 删除
  - **应用**：轻应用（Web 快捷方式 + 内置 WebView + 页面自动化桥）、技能管理（新建/删除）、定时任务（创建/删除，移动端降级提示）
  - **我的**：**模型供应商管理**（协议 auto/openai/anthropic、Base URL、API Key、模型列表、生图能力、设默认）、Agent 工作区、长期记忆检索/添加、MCP 服务状态、连接配置收进「高级」
- ✅ **文档 DTO 路径边界已收敛**：artifact 内部持久化保留 canonical source/render 路径，`doc.import/get/list/preview.ensure` 对外只返回 workspace 相对路径；workspace 外部文件只返回 basename。Electron 打开原文件与预览 host callback 仍使用内部路径。
- ✅ **验证入口已统一**：`pnpm harness:check` 执行 Rust 格式、workspace 测试、Electron 类型检查和 Harness/Electron 回归；`pnpm test:flutter` 全量 88 项通过，作为独立的较慢跨端门禁。
- ⏳ **后续发布验证**：cargokit/最终打包、Android/iOS 真机 UI 与生命周期、后台恢复和所有 ABI 仍待完成。Node Agent Loop 不再开发；Electron host tools 继续按平台适配器维护。

## Electron Harness 选择与迁移

在 Electron 的设置 → 执行中选择“对话 Harness”：

- `Rust（app-server）`：默认且唯一持续开发的 Harness。provider、Agent Loop、会话/事件、权限/Plan、取消/续传、工具编排和动态 MCP 由 Rust 负责；Electron 域能力通过宿主反向 RPC 保留现有数据与展示语义。
- `TypeScript（冻结兼容）`：只供显式保存的旧配置临时使用。Node `AIEngine`、AgentCore 和 provider 不再添加新能力。

切换只影响之后创建的聊天流。已有 Rust 流会继续运行并可停止；只有用户明确切到 TS 后，新流才走兼容后端。Rust 二进制不可用或进程启动失败时直接报错，不会根据启动状态或聊天上下文静默回退。开发环境可运行 `pnpm --dir apps/electron build:harness`，也可通过 `WORLDBASE_RUST_HARNESS` 指定二进制。

### 当前 parity 清单

Electron Agent 的既有 68 个公开工具名构成冻结的 Node 宿主目录。名称、description 与 JSON Schema 从 Electron 注册表生成到 Rust 契约快照；漂移检查防止兼容接口意外变化。Rust 模式下，Rust 负责模型循环、会话、计划状态、权限和动态 `mcp__*`；既有宿主工具通过反向 `tool.execute` RPC 调用 Node handler。新通用工具必须在 Rust 实现；设置 `Tool::electron_native() == true` 后即可随 `initialize.availableTools` 暴露给 Electron，不修改 68 项快照，也不注册 Node placeholder/override。

Flutter/FFI 不依赖 Electron host handler，使用 Rust 原生实现，并在握手时按移动端 capability 和显式白名单隐藏子进程、端口和 Electron-only 工具。TS `AIEngine`/provider 只作为冻结兼容代码保留；不能删除仍被 Rust host bridge 调用的 Electron 工具与平台服务。

详细边界见 [docs/rust-harness-architecture.md](docs/rust-harness-architecture.md)；新增 provider、工具、RPC、事件或文档能力按 [docs/rust-harness-development.md](docs/rust-harness-development.md) 执行。

## 构建与运行

```bash
# Rust Harness
cargo build --manifest-path harness-rs/Cargo.toml
cargo test --manifest-path harness-rs/Cargo.toml --workspace
cargo run --manifest-path harness-rs/Cargo.toml -p worldbase-cli -- chat "你好"   # in-process CLI

# 提交前主门禁（Rust fmt/test + Electron typecheck/test）
pnpm harness:check

# 真实模型（可选；缺省 mock provider）
export ANTHROPIC_API_KEY=sk-...          # 或 OPENAI_API_KEY / settings.set provider

# Flutter 移动端（根脚本先重建当前 FFI 库，避免加载旧 dylib）
pnpm test:flutter                                             # 无默认 feature 的 dylib + Flutter 全量测试
pnpm harness:test:android-build                               # 自动解析 SDK/NDK，Android arm64 release
cd apps/mobile
flutter test                                                  # Flutter 全量 unit/widget/E2E
flutter test integration_test/app_e2e.dart -d macos            # GUI E2E
flutter run -d macos                                           # 桌面预览（移动端 UI）
```

Android 与 iOS 交叉编译统一通过 `scripts/build_rust_android.sh` 和
`scripts/build_rust_ios.sh`，移动产物始终传入 `--no-default-features`；当前默认的
`desktop-support` 是空兼容 feature，因此安全边界仍是 runtime capability gate。Android CI 应设置
`ANDROID_NDK_HOME`（或 `ANDROID_SDK_ROOT` + `ANDROID_NDK_VERSION`）；本地未设置时脚本
会从 Android SDK 的已安装 NDK 中解析 linker。两个脚本优先使用 rustup 当前工具链，
也可用 `RUSTUP_TOOLCHAIN` 固定版本，不依赖仓库内的机器绝对路径。

## 移动端接入协议（mobile-ffi loopback）

1. FFI 读取本次启动 token，并连接 `ws://127.0.0.1:<port>/ws?token=<token>`；`/health`、`/rpc`、`/studio/{id}` 与 `/lightapp/{id}` 也必须携带同一 token。
2. WebSocket 连接后发送 `initialize`，声明移动端 capabilities：
   `excludes: ["subprocess", "port_binding", "webhook_receiver"]`
3. harness 返回过滤后的 `availableTools` / `availableDomains`（desktop 域不可见）。
4. `chat.send` 后事件以 `method:"event"` 通知下行，`seq` 单调递增；断线重连后
   `chat.resume {streamId, afterSeq}` 续传。
5. `permission_request` 事件弹出确认 UI，宿主以 `chat.respond {requestId, allow}` 应答；`host_request` 使用 `host.respond`。

迁移映射详见 [docs/project-structure.md](docs/project-structure.md)；架构决策详见 [docs/rust-harness-architecture.md](docs/rust-harness-architecture.md)。
