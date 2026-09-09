# WorldBase Rust Harness 架构方案

**版本**: v6（Agent Loop 边界定案）
**日期**: 2026-09-07
**目标原则**: **Rust 做好 Agent Loop 与跨端公共能力 · Electron 保留展示/宿主层 · 文档解析与基础编辑 Rust 原生化**

**当前实施状态（2026-09-08）**：Rust 已提供可运行的 core/app-server，并已接入 Electron 与 Flutter。Rust 负责 provider、Agent Loop、会话/事件、权限与 Plan、取消/续传、工具编排和动态 MCP；Electron 继续通过 host override 执行项目运行时、窗口/UI、页面自动化、图片队列、调度器、Office 宿主操作、LAN/IM 入口等宿主能力。Rust `docs` crate 已完成跨端文档解析与基础编辑。Electron 默认使用 Rust；TS Harness 仅保留显式旧配置兼容，不再开发新功能，也不会在 Rust 启动失败时被静默启用。

---

## 演进记录

- **v1**: 桌面伴侣 server（已归档）
- **v2**: C/S Dart harness（已归档）
- **v3**: 纯移动端 Dart + WebView 轻应用（已归档）
- **v4**: Dart LSP 模式（已归档）
- **v5**: 全 Rust 方向探索，尝试把当前 TS Harness 全量迁移到 Rust
- **v6**: Agent Loop 边界定案；Rust 聚焦编排核心和跨端公共能力，Electron 保留展示/宿主层，文档解析与基础编辑使用 Rust
- **v7**: Rust 成为默认且唯一维护的 Harness；TS Agent Loop 冻结，新 Rust 原生工具脱离 68 项 Node 宿主快照独立扩展

> **实施状态（2026-09-08）**：Rust workspace、Electron 回归和 Flutter 全量 88 项测试通过。Electron 的冻结 68 项宿主工具契约受 ownership/host callback 测试保护；新增 Rust 工具可通过 ownership metadata 直接进入 Electron。macOS FFI 主路径与 Android/iOS arm64 release 交叉编译通过，真机打包、后台恢复和完整移动发布验证仍待完成。

---

## 目录

1. [核心原则](#1-核心原则)
2. [总体架构与 crate 结构](#2-总体架构与-crate-结构)
3. [通用承载：一个 dispatcher，多种 transport](#3-通用承载一个-dispatcher多种-transport)
4. [宿主能力注入](#4-宿主能力注入)
5. [Electron 集成：Agent Loop 与宿主层协作](#5-electron-集成agent-loop-与宿主层协作)
6. [CLI 模式](#6-cli-模式)
7. [对标 Codex](#7-对标-codex)
8. [移动端降级：宿主层面的能力映射](#8-移动端降级宿主层面的能力映射)
9. [演进路线](#9-演进路线)
10. [风险与边界](#10-风险与边界)

---

## 1. 核心原则

### Rust 的目标是 Agent Loop，不是 Electron 全量重写

- **Rust Agent Loop（必须完成）**：provider 适配、消息与会话上下文、流式事件、tool-call 循环、权限与 Plan、取消、重试、上下文预算、子 Agent/群组编排、宿主反向请求和跨端协议。
- **Rust 公共能力（优先完成）**：跨端文档解析与基础编辑、文件搜索、Memory/Skill/MCP 等可被 CLI、Electron 和 Flutter 复用的能力。
- **Electron 宿主层（允许保留）**：renderer/UI、窗口/菜单/托盘、IPC/preload、项目运行时、LAN、页面自动化、原生通知/对话框、图片队列和 UI 存储、IM webhook 入口，以及依赖 Electron 数据和生命周期语义的业务工具。
- **移动端**：通过 FFI + loopback transport 复用 Rust Agent Loop；握手时过滤 subprocess、port binding、webhook 和 Electron-only 能力，不要求移动端复制 Electron 展示层。

**核心边界**：Rust 负责“如何思考、调用模型、编排工具和传递事件”；Electron 负责“如何展示、如何接入桌面平台和如何维持现有产品语义”。

### 架构决策

**Harness 的最终形态是 Rust workspace：一个 Agent Loop、一个协议/事件模型、三种接入方式；宿主域能力通过 native tool 或 host bridge 注入，不要求所有 Electron handler 在 Rust 中重写。**

- **CLI/TUI**: 直接链接 core crate，验证 Agent Loop 和公共能力。
- **Electron**: spawn harness 二进制，stdio 上运行全双工 JSON-RPC；Rust 接管 Agent Loop，Electron 通过 host bridge 提供展示和桌面服务。
- **移动端**: 通过 `dart:ffi` 在 App 进程内启动 mobile-ffi，复用同一个 Agent Loop，按 capability 过滤宿主能力（见 §8）。

### 为什么选 Rust

选择 Rust 的重点是把 Agent Loop 从 Electron/Node 中抽离出来，换取：

1. **一套 Agent Loop 覆盖 CLI、Electron 和 Flutter**，减少多端行为漂移。
2. **provider、权限、取消、事件和工具编排可以集中测试**，不依赖某个 UI 宿主。
3. **文档解析/基础编辑使用 Rust 生态跨端复用**，不必把 Node 文档依赖带入移动端。
4. **Electron 宿主层可以渐进演进**，不因 UI 或桌面服务迁移成本阻塞 Rust Agent Loop。
5. **保留单二进制/FFI 的分发可能性**，但不把删除 `node_modules` 或删除全部 TS 作为当前验收条件。

### 迁移范围（按 ownership 划分）

不再以 `apps/electron/src/main` 全部平移为目标，当前范围分为“Rust 必须承接”“Rust 公共能力优先”和“Electron 宿主保留”三类：

| 模块 | Rust 目标 | Electron 处理方式 | 当前状态 |
|---|---|---|---|
| Agent Loop | `core` + `providers` + `protocol` | TS `AIEngine` 仅作显式冻结兼容；host bridge 独立保留 | Rust 主路径已完成，后续只维护 Rust |
| 权限/Plan/取消/续传/工具编排 | `core` + `protocol` | Electron 提供 UI 应答和宿主回调 | Rust 主路径已完成 |
| 群组/子 Agent/Memory/Skill/MCP | Rust 公共运行时 | Electron 可通过 host/store 补充产品语义 | Rust 实现和 E2E 已存在 |
| 文档解析与基础编辑 | `docs` + document artifact 工具 | Electron 复杂预览、原文件打开和 UI 工作台可保留 TS | Rust 已有解析与基础写入；内部/公开 artifact 路径已分离 |
| 文件搜索/跨端只读工具 | Rust `search`/tools | Electron 可继续覆盖项目级数据语义 | Rust 已实现 |
| 项目运行时、LAN、窗口、页面自动化 | 不要求全量迁移 | Electron 继续作为宿主权威；Rust 通过 host bridge 或独立 control plane 调用 | Electron 主路径已保留 |
| IM webhook、图片队列、UI 存储、Office 高级编辑 | 不要求全量迁移 | Electron 继续实现；Rust 只在需要时提供公共协议/算法 | Rust connector 库已有，生产入口仍以 Electron 为主 |

**验收原则**：Rust 以 Agent Loop 行为、协议稳定性、取消/权限边界、跨端文档能力和宿主回调可靠性验收；不要求把 Electron 展示/宿主层 Rust 化。Node Agent Loop 可保留兼容代码，但不再是新功能落点。

---

## 2. Monorepo 与三 workspace

仓库采用 monorepo，但按语言和运行时边界拆成三个独立 workspace：

```text
the-world/
├── apps/electron/       # Workspace 1: 原始 Electron + Vue/TypeScript
├── harness-rs/          # Workspace 2: 唯一 Rust Cargo workspace
├── apps/mobile/         # Workspace 3: Flutter（FFI + Rust Agent Loop 已接入）
└── docs/                # monorepo 级契约、架构与迁移文档
```

Electron 源码已迁移至 `apps/electron/`，Rust workspace 位于 `harness-rs/`，Flutter workspace 位于 `apps/mobile/`。目录边界和后续迁移映射以 [docs/project-structure.md](project-structure.md) 为准。

### 总体架构

```
                ┌─ Flutter 移动 App ───── FFI 启动 + loopback WebSocket JSON-RPC
Rust harness ───┼─ CLI(worldbase chat/run/projects)── in-proc(链接 core,Agent Loop + Rust 公共能力)
(monorepo       └─ Electron 桌面 ────────── stdio JSON-RPC(spawn 二进制,按迁移域)
```

### crate 结构（对齐 codex-rs，围绕 Agent Loop 组织）

```
harness-rs/                       # 唯一 Cargo workspace
├── Cargo.toml
└── crates/
    ├── core/             # agent 循环 · session/turn · 工具注册 · 权限引擎
    ├── protocol/         # Rust serde schema；TS/Dart 适配器由跨端契约测试守护
    ├── providers/        # openai / anthropic，SSE 流式(reqwest+rustls)
    ├── tools/            # Rust 原生工具 + Electron 契约快照/宿主覆盖 + capability 过滤
    │   ├── local_file.rs / local_command.rs / web_search.rs / web_fetch.rs
    │   ├── ask_user.rs / auth.rs / todo.rs / plan.rs ...
    │   └── (mobile runtime allow-list: 隐藏 local_command / exec 与宿主专属工具)
    ├── group/            # 群组 deliberation · session · 黑板(纯状态机，全端)
    ├── memory/           # rusqlite FTS5(全端)
    ├── skills/           # YAML 技能引擎(全端)
    ├── scheduler/        # 定时任务(全端，iOS 语义降级为补跑)
    ├── mcp-client/       # stdio 桌面域，SSE/HTTP 全端
    ├── docs/             # 文档引擎（解析与基础编辑，跨端优先）
    │   ├── parse/        # calamine · lopdf · docx · image(解析，全端)
    │   └── edit/         # docx/xlsx/pptx/csv/文本基础写入
    ├── search/           # ignore/grep 系，ripgrep 级检索(全端)
    ├── app-server/       # stdio NDJSON JSON-RPC(Electron)
    ├── cli/              # worldbase chat/run/projects(链接 core，Agent Loop + Rust 公共能力)
    ├── mobile-ffi/       # C ABI 启停/token + 鉴权 loopback WS/HTTP(移动端能力过滤)
    ├── exec/             # 命令执行 + 沙箱(桌面域 only)
    ├── project-runtime/  # 可选 Node 项目运行时(桌面域 only；非 Agent Loop 必迁)
    │   ├── bundled_node.rs   # spawn 内置 Node 二进制
    │   ├── bundled_pnpm.rs   # pnpm install / build
    │   └── dev_server.rs     # 启动 :3100+ / 健康检查 / 日志流
    └── im-gateway/       # IM 连接器(webhook 桌面域，socket 模式可选移动)

apps/electron/                    # 独立 Node/pnpm workspace
├── electron/                      # main/preload/宿主适配
├── src/                           # renderer、迁移期 TS main、shared、locales
├── public/ · scripts/ · tests/
└── package.json                   # Electron 依赖与构建

apps/mobile/                      # 独立 Flutter workspace（FFI + loopback WS）
├── lib/{app,core,features,l10n}/
├── android/ · ios/ · test/
└── pubspec.yaml
```

`core`、`app-server`、`cli` 和 `mobile-ffi` 是同一个 Cargo workspace 内的 crate，不是独立仓库。Electron 通过 spawn `app-server` 的 stdio JSON-RPC 接入；Flutter 通过 FFI 在进程内启动 `mobile-ffi`，再经 loopback WebSocket JSON-RPC 接入。`project-runtime`、`exec` 和 `im-gateway` 属于可选桌面宿主能力，不构成 Rust Agent Loop 完成的前置条件。

**关键**：当前没有 `cfg(feature = "mobile")` 编译期边界。`mobile-ffi` 的 `desktop-support` 是为兼容既有命令保留的空 feature；Android/iOS 脚本虽传入 `--no-default-features`，目前不会从依赖图裁掉 `project-runtime` / `exec` / `im-gateway`。实际安全与可用性边界由 FFI transport 的移动端 capability ceiling、`initialize` 的能力交集/排除项并集，以及 Agent 的显式移动工具白名单共同提供；移动连接无法把自己升级为 desktop，且不会看到 `create_project`(全栈) / `execute_command` 等工具。后续若引入真实的编译期裁剪，应作为独立优化并配套构建矩阵验证，不能替代 runtime gate。

---

## 3. 通用承载：一个 dispatcher，多种 transport

### 协议要点

- **JSON-RPC 2.0 全双工**。宿主 → harness: 命令与流式请求；harness → 宿主: 事件通知（带 seq）、反向请求（交互弹层/页面自动化/对话框）
- **stdio 上用换行分隔 JSON（NDJSON）**，日志走 stderr（codex app-server 同款）
- **握手即能力协商**。连接建立时交换 `protocolVersion` 与 `capabilities`: 宿主声明「我能提供哪些端口/注入工具」，harness 据此启用或隐藏对应 Agent 工具
- **各接入方式共用同一 dispatcher**。CLI 直接链接 core；Electron 使用 stdio NDJSON JSON-RPC；Flutter 通过 FFI 启动 mobile-ffi 后使用 loopback WebSocket JSON-RPC

### 流式与断点续传

移动端网络不稳定是 P0 需求，事件帧格式：

```json
{
  "jsonrpc": "2.0",
  "method": "ai.stream.event",
  "params": {"id": 42, "seq": 117, "kind": "delta", "text": "..."}
}
```

断线重连后：

```json
{
  "jsonrpc": "2.0",
  "id": 43,
  "method": "ai.stream.resume",
  "params": {"id": 42, "afterSeq": 117}
}
```

---

## 4. 宿主能力注入

Rust 负责 Agent Loop，宿主负责平台能力和产品展示——机制是“能力注入 + host bridge”。宿主在握手时声明能力，harness 按能力清单生成可见工具；工具真正执行时，可以由 Rust 原生执行，也可以通过反向 RPC 交给宿主。

| 桌面专属能力 | 实现位置 | harness 侧看到什么 |
|---|---|---|
| 文档解析(docx/xlsx/pdf/pptx/csv/md 读取) | **Rust docs crate(calamine/lopdf/OOXML parser)**，跨端复用 | 核心内置工具 |
| 文档基础编辑(docx/xlsx/pptx/csv/文本) | Rust `docs` crate | Electron 高级预览、原文件打开和 UI 工作台可继续由 TS 提供 |
| Office 高级编辑/PDF 插图 | 不要求 Agent Loop 迁移 | Electron 继续通过 host tool 提供原有语义 |
| Next.js 全栈项目运行时 | Rust `project-runtime` 可作为 control plane，但不是 Agent Loop 必迁 | Electron 继续作为项目运行时和生命周期权威 |
| webview 浏览器自动化 | Electron renderer / flutter_inappwebview | 全端，反向 RPC |
| 原生通知/对话框/项目窗口 | 宿主平台 API | HostServices 端口实现 |

---

## 5. Electron 集成：Agent Loop 与宿主层协作

### 当前接入边界

Electron 设置 → 执行中的“对话 Harness”默认选择 `Rust（app-server）`；`TypeScript（冻结兼容）` 只有显式旧配置才会选择。Rust 承接 `ai:chat` / `ai:chatStream` 的 provider、Agent Loop、会话同步、权限/Plan、取消、事件流和动态 MCP；Electron 继续承接窗口、renderer 展示、项目运行时、页面自动化、图片队列、调度器、Office 宿主操作、LAN/IM 入口和 UI 存储。Electron 权威域工具通过 `tool.execute` 宿主反向 RPC 注册为 `electron_host_override`。Rust 二进制不可用或启动失败会直接报错，不会自动沿用 TS 路径。

Electron 的既有 68 项公开工具定义是冻结的 Node 宿主兼容快照；同名 `electron_host_override` 由 Rust 循环发起 `tool.execute` 宿主 RPC，执行现有 handler。新通用工具在 Rust 实现，并显式返回 `electron_native() == true`；它会进入 Electron 的 `initialize.availableTools`，保留 Rust schema 和执行权，不需要修改 68 项快照或创建 Node placeholder。动态 `mcp__*` 同样留在 Rust。Flutter/FFI 使用 Rust 实现并按 capability 和移动白名单隐藏不可用域。

### 打包与进程模型

- CI 编译 `worldbase-app-server` 二进制(mac/win/linux)，electron-builder 放 `extraResources`
- Rust 默认按需 spawn；进程退出会向当前流发送错误，只有用户显式选择时才使用冻结 TS 后端
- main 职责: 窗口/托盘/对话框/通知/更新 + IPC 代理 + 注入能力

### 渐进切换（保留宿主，不追求全量重写）

**renderer 与 preload 保持稳定**，只有 Agent Loop 和必要的协议入口通过 app-server 接入；Electron 的展示层和宿主 IPC 不需要逐前缀迁移到 Rust：

```ts
// 切换前
ipcMain.handle('conversations:list', (e, args) => conversationStore.list(args))
// 切换后
ipcMain.handle('conversations:list', (e, args) => harness.call('conversations.list', args))
```

当前优先顺序: `providers` → `conversation/stream` → `ai:chatStream` → `permissions/host bridge` → `document parse/edit`。`projects/runtime`、窗口/UI、LAN、IM 和 Electron 展示相关 IPC 保持宿主实现；不再以逐域删除 TS 为目标。

---

## 6. CLI 模式

CLI 是 `cli` crate，直接链接 core，提供 Agent Loop 和 Rust 公共能力：

```bash
worldbase chat "..."
worldbase run --task "每日汇总"
worldbase projects ls
```

---

## 7. 对标 Codex

OpenAI Codex([openai/codex](https://github.com/openai/codex))架构同构验证:
- Rust core + App Server(JSON-RPC 2.0 stdio JSONL + initialize 握手 + generate-ts)
- 先试 MCP server 后自建协议——与我们判断一致
- **关键边界**: codex 无移动端进程内，移动走云

---

## 8. 移动端降级：宿主层面的能力映射

**目标重申**：移动端复用 Rust Agent Loop 和跨端公共能力；移动端的「降级」发生在宿主接入层。Electron 通过设置保留 TS/Rust 双后端，Rust 选择下 Agent Loop 进入 Rust，但 Electron 展示层和宿主域仍由 Electron 执行。Rust 不以复刻全部 Electron UI/宿主服务为目标。

### 接入方式：FFI 进程内

- Rust 库由 `dart:ffi` 加载；当前 C ABI 仅导出 `worldbase_start`、`worldbase_get_auth_token` 和 `worldbase_stop`
- tokio runtime 独立线程组，Dart 全异步
- `worldbase_start` 在 App 进程内启动 harness 并返回动态端口；每次启动同时生成随机 64 字符 token，Flutter 读取 token 后通过 loopback WebSocket JSON-RPC 收发请求、事件与反向请求
- `/health`、`/rpc`、`/ws`、`/studio/{id}` 与 `/lightapp/{id}` 均要求同一 token；服务只绑定 `127.0.0.1`
- 三个 C ABI 入口均以 `catch_unwind` 阻止 panic 穿过 FFI 边界；启动与 token 读取失败返回 `-1`，停止入口吞下 unwind，同时保留 panic hook/tracing 诊断

### 能力协商：握手时过滤工具集

移动端 FFI 握手声明 `capabilities`:

```json
{
  "platform": "mobile-ios",
  "features": ["lightweight_runtime", "webview_automation"],
  "excludes": ["subprocess", "port_binding", "webhook_receiver"]
}
```

Harness 据此**动态过滤 Agent 工具集**：

| 工具/能力 | Rust Agent Loop/公共层 | 移动端暴露 | 替代/说明 |
|---|---|---|---|
| `create_project`(全栈 Next.js) | Agent Loop 可编排；宿主实现可选 | ❌ | 移动端使用 `create_lightweight_app`（WebView 轻应用 + 数据桥） |
| `execute_command` / exec 类 | Rust 桌面能力 | ❌ | 移动端不暴露，Electron 可继续使用宿主工具 |
| IM webhook 接收 | 宿主入口能力，不是 Agent Loop 必迁 | ❌ | Electron 继续承接；移动端不启动 webhook server |
| 文档解析 | ✅ Rust docs crate | ✅ | calamine/lopdf/OOXML 等跨端复用 |
| 文档基础编辑 | ✅ Rust docs crate | 🟡 | 移动端按 UI 能力开放；Electron 高级 Office/PDF 操作可保留 TS |
| 浏览器自动化 | Agent Loop 通过 host bridge 调用 | ✅ | flutter_inappwebview |
| skills / memory / MCP(远程) | ✅ Rust 公共能力 | ✅ | 全端；MCP 移动端仅远程传输 |
| 群组协作 | ✅ Rust 状态机与 Agent 编排 | ✅ | 全端复用 |
| 定时任务 | ✅ Rust scheduler 核心 | 🟡 | iOS 补跑；Android WorkManager |

### 移动端功能清单（经过滤后）

UI 以**对话**为主页，历史会话、应用、绘图和设置从抽屉进入。

| 处置 | 功能 |
|---|---|
| ✅ 主路径 | 对话/流式 Agent Loop、群组(5 模式/黑板)、文档解析、Studio、WebView 轻应用、浏览器自动化、skills/memory/MCP 远程 |
| 🟡 降级 | 定时任务(iOS 补跑)、LAN 分享(前台) |
| ❌ 不暴露 | 全栈项目(替代为轻应用)、exec、IM webhook、重文档编辑、多设备同步 |

**关键**：Rust Agent Loop 和公共能力跨端复用；Electron 专属展示/宿主能力在移动端通过 capability 和工具白名单隐藏，不要求这些能力在 Rust 中完整重写。

### 双端兼容工程

- 构建: `scripts/build_rust_android.sh` 与 `scripts/build_rust_ios.sh` 直接调用 rustup/cargo；当前未接入 cargokit
- 依赖: reqwest+rustls、rusqlite bundled FTS5
- runtime gate: transport capability ceiling + 移动端工具白名单；移动构建命令关闭默认 features，但空 feature 目前不改变依赖图
- 已验证: Android `aarch64-linux-android` 与 iOS `aarch64-apple-ios` release 交叉编译；macOS FFI 主路径
- 待验证: Android/iOS 真机打包、安装、UI/生命周期、后台恢复与所有 ABI；当前不能把交叉编译通过等同于可上架

### Flutter 架构

```
lib/
├── app/            # 路由、主题、i18n
├── core/
│   ├── harness_ffi.dart     # 手写 dart:ffi C ABI 绑定与动态库解析
│   ├── harness_client.dart  # loopback WS/HTTP JSON-RPC 客户端与协议模型
│   └── providers.dart       # Riverpod 状态与业务控制器
├── features/       # chat / launchpad / studio / settings
└── l10n/
```

状态管理: Riverpod；导航: 对话主页 + 抽屉入口

---

## 9. 演进路线

| 阶段 | 内容 | 出口 | 估期 |
|---|---|---|---|
| P0 | Rust 骨架：core + providers + protocol + cli | CLI 跑通 Agent Loop | 已完成 |
| P1 | Agent Loop 能力：权限、工具编排、Memory、群组、Scheduler、MCP、子 Agent | Rust core/E2E 和协议契约通过 | 已完成主要路径 |
| P2 | app-server + Electron host bridge | Electron 可选择 TS/Rust；Rust 接管 Agent Loop，宿主层保持 Electron | 已完成主要路径 |
| P3 | mobile-ffi + Flutter 接入 | 移动端复用 Rust Agent Loop；macOS 主路径通过，交叉编译通过 | 已完成主要路径 |
| P4 | Rust 文档能力 | 跨端解析与基础编辑；artifact/预览 DTO 收敛 | 已完成主要路径 |
| P5 | 发布验证与边界收敛 | 真机打包、后台恢复、生产回归 | 待完成 |

**当前方向**：所有新 Harness 功能进入 Rust；Electron 展示层和宿主业务可以长期保留。TS Agent Loop 不要求立即删除，但已冻结，不再参与能力演进。具体扩展流程见 [rust-harness-development.md](rust-harness-development.md)。

---

## 10. 风险与边界

### 风险

- **FFI 边界**：loopback token、生命周期和导出函数 panic containment 自动化测试已就位；Android/iOS 真机生命周期与后台恢复仍需验证
- **边界漂移**：Rust Agent Loop 与 Electron host tool 的 ownership 必须有契约检查，避免把“工具契约对齐”误解成“所有 handler 都已 Rust 化”
- **冻结后端漂移**：TS 后端只修复阻断旧配置的严重兼容问题，不能继续添加 provider、编排或通用工具能力
- **构建矩阵**：5 target + 4 平台，P0 就建 CI
- **协议冻结**：P0 协议带 protocolVersion + capabilities
- **文档 artifact 边界**：内部 source/render path 保留给持久化和 host callback；公开 DTO 必须返回 workspace 相对路径或外部文件 basename

### 边界

- 移动端功能收敛是宿主降级；Rust Agent Loop 和公共文档能力保持跨端
- Electron 展示层、窗口层、LAN/IM 入口和项目运行时不属于 Rust Agent Loop 的强制迁移范围
- iOS 后台物理限制，断点续跑+补跑+通知
- 交互重构非像素对齐

### fallback

若后续平台限制导致 FFI 无法继续，需另行评审远端 transport 或 Dart/Rust 插件拆分；当前产品不提供独立 `serve` 部署层。

---

## 参考

- [OpenAI Codex](https://github.com/openai/codex)
- [AppFlowy](https://github.com/AppFlowy-IO/AppFlowy)(Flutter+Rust FFI 验证)

---

**文档状态**: v7（2026-09-08）。Rust 是默认且唯一维护的 Agent Harness；Rust workspace、Electron 回归和 Flutter 全量 88 项测试通过。Electron host bridge 与 Flutter mobile-ffi 已接入，Rust docs crate 已提供跨端解析与基础编辑，artifact 公开路径已脱敏。Android/iOS 真机打包、后台行为和发布验证仍待完成。
**维护**: 以 Rust Agent Loop / host bridge / docs crate 的 ownership 和验证状态为准；TS Agent Loop 仅作冻结兼容。
