# WorldBase Rust Harness 架构方案

**版本**: v5（定案）  
**日期**: 2026-08-28  
**目标原则**: **Harness 完整迁移当前 TS 全部能力（零删减）· 移动端宿主按平台能力降级 · 桌面/CLI/server 零降级**

**当前实施状态（2026-08-30）**：Rust 已提供可运行的 core/app-server，并已接入 Electron 的可选 Harness 后端。Electron 默认仍使用 TS；选择 Rust 后，聊天、项目、文件工作区、图片 Studio 与 MCP 均通过 Rust 的 JSON-RPC/事件流处理，群组原生会话接入同步收敛中。TS Harness 保留为显式迁移选项，以及 Rust 可执行文件缺失或初始握手失败时的启动兜底。

---

## 演进记录

- **v1**: 桌面伴侣 server（已归档）
- **v2**: C/S Dart harness（已归档）
- **v3**: 纯移动端 Dart + WebView 轻应用（已归档）
- **v4**: Dart LSP 模式（已归档）
- **v5**: 全 Rust，Harness 完整迁移当前 TS 能力，移动端宿主降级

> **实施状态（2026-08-29）**：P0–P1 主体与移动端已完成并端到端跑通。
> Rust 48 测试、Flutter 全功能面 E2E 与 GUI 集成测试全过；移动端经 FFI 进程内
> 运行 harness（`mobile-ffi` 内置 loopback 传输），**serve 独立部署层已删除**
> （§3 的四种 transport 中 mobile/CLI 走 FFI in-process，serve 模式取消，
> Electron 仍走 app-server stdio）。详见 HARNESS.md。

---

## 目录

1. [核心原则](#1-核心原则)
2. [总体架构与 crate 结构](#2-总体架构与-crate-结构)
3. [通用承载：一个 dispatcher，四种 transport](#3-通用承载一个-dispatcher四种-transport)
4. [宿主能力注入](#4-宿主能力注入)
5. [Electron 集成：渐进迁移、全能力保留](#5-electron-集成渐进迁移全能力保留)
6. [CLI 与 serve 模式](#6-cli-与-serve-模式)
7. [对标 Codex](#7-对标-codex)
8. [移动端降级：宿主层面的能力映射](#8-移动端降级宿主层面的能力映射)
9. [演进路线](#9-演进路线)
10. [风险与边界](#10-风险与边界)

---

## 1. 核心原则

### Harness 是能力的全集，宿主按需裁剪（目标）

- **Rust harness core**: 目标是将 `apps/electron/src/main` 全部业务逻辑 1:1 平移——全栈项目运行时（bundled Node）、全部 60+ 工具、IM webhook 接收、重文档编辑、命令沙箱、群组协作、记忆、技能、MCP、scheduler……**零功能删减**
- **桌面端/CLI/server**: 完成迁移后与 Electron 版功能完全对齐；当前 Electron 仍以 TS 为完整实现，Rust 按迁移清单逐域补齐
- **移动端**: 通过 `cfg(feature = "mobile")` 裁剪出可编译子集 + 握手时能力协商过滤工具集（不跑 Node 子进程，用 WebView 轻应用替代全栈项目）

**不是「为了移动端简化 harness」，而是「harness 保持完整，移动端选择性接入」。**

### 架构决策

**Harness 的最终形态是 Rust workspace: 完整迁移当前 TS 版全部能力，唯一 dispatcher + 四种接入方式。迁移期间 Electron 保持 TS/Rust 双后端可选。**

- **CLI/TUI**: 直接链接 core crate（进程内，同 codex），**全能力**
- **Electron**: spawn harness 二进制，stdio 上跑全双工 JSON-RPC（codex app-server 同款）；设置可选 TS/Rust，Rust 选择时由 Rust 承接已接入的业务域
- **移动端**: 经 flutter_rust_bridge 把 core 编译为静态库链入 App（FFI 进程内），**按平台能力降级**（见 §8）
- **server**: 同一二进制加 `serve`（axum，WS/HTTP），**全能力**

### 为什么选 Rust

用户定案全 Rust 路线——接受编排核心 Rust 化的 1.5–2 倍工期（约 9–12 个月 vs Dart 5–7 个月），换取：

1. **核心一种语言覆盖全部宿主**（与 codex 完全同构，架构心智成本最低）
2. **文档/搜索用 Rust 生态直接做满**（calamine/lopdf/ignore），不再是降级项
3. **命令沙箱、本地推理等未来能力的语言位置就位**
4. **单二进制分发**（distroless ~30MB，无 node_modules）
5. **最终与当前 TS 版功能完全对齐**（bundled Node 运行时、exec、IM webhook 等全部可 1:1 迁移）

### 迁移范围（Harness 层面，全量 1:1）

当前 TS 版 `apps/electron/src/main` 共约 **40,325 行**，全部平移到 Rust：

| 模块 | 当前 TS | Rust 迁移目标 | 说明 |
|---|---|---|---|
| AI 引擎 | providers / agent / 60+ 工具 / 权限引擎 | `core` + `tools` crate | 完整保留，包括 tool-local-command（桌面/server feature）|
| 群组协作 | deliberation / session / 黑板 / 5 模式 / HITL | `group` crate | 纯状态机，全端可用 |
| 项目运行时 | bundled-runtime / project-* 四件套 | `project-runtime` crate | **bundled Node + pnpm**，desktop/server feature only |
| 文档引擎 | mammoth / pdf-lib / exceljs / officegen / sharp | `docs` crate | 解析全端（calamine/lopdf）；编辑桌面（printpdf/docx-rs 或保留 TS 注入） |
| MCP client | stdio / SSE / HTTP transports | `mcp-client` crate | 全端，移动端仅远程（SSE/HTTP）|
| IM 网关 | 飞书/微信/Slack 等 7 连接器 | `im-gateway` crate | webhook 模式 desktop/server only；socket 模式可选移动端 |
| scheduler / 长期目标 / 记忆 | cron / FTS5 | `scheduler` + `memory` crate | 全端；移动端定时语义降级（iOS 补跑）|
| LAN server | Express :19527 | app-server(stdio/WS) + serve(axum) | desktop/server；移动端不监听端口 |
| 命令执行 / 沙箱 | exec / Seatbelt/Landlock | `exec` crate | desktop/server feature only |
| 浏览器自动化 | webview executeJavaScript | 反向 RPC + platform channel | 全端（桌面 Electron webview，移动 flutter_inappwebview）|

**零删减**：移动端砍的不是 harness 的功能，而是在 FFI 边界通过能力协商拦截（见 §8）。

---

## 2. Monorepo 与三 workspace

仓库采用 monorepo，但按语言和运行时边界拆成三个独立 workspace：

```text
the-world/
├── apps/electron/       # Workspace 1: 原始 Electron + Vue/TypeScript
├── harness-rs/          # Workspace 2: 唯一 Rust Cargo workspace
├── apps/mobile/         # Workspace 3: Flutter（P3 创建）
└── docs/                # monorepo 级契约、架构与迁移文档
```

Electron 源码已迁移至 `apps/electron/`，Rust workspace 位于 `harness-rs/`，Flutter workspace 位于 `apps/mobile/`。目录边界和后续迁移映射以 [docs/project-structure.md](project-structure.md) 为准。

### 总体架构

```
                ┌─ Flutter 移动 App ───── FFI(flutter_rust_bridge,进程内,能力过滤)
Rust harness ───┼─ CLI(worldbase chat/run/projects)── in-proc(链接 core,全能力)
(monorepo       ├─ Electron 桌面 ────────── stdio JSON-RPC(spawn 二进制,按迁移域)
 multi-workspace)└─ worldbase serve ─────── WS/HTTP(axum,全能力)
```

### crate 结构（对齐 codex-rs，完整迁移当前 TS）

```
harness-rs/                       # 唯一 Cargo workspace
├── Cargo.toml
└── crates/
    ├── core/             # agent 循环 · session/turn · 工具注册 · 权限引擎
    ├── protocol/         # serde schema 单一来源 → codegen(TS for Electron / Dart for FFI)
    ├── providers/        # openai / anthropic，SSE 流式(reqwest+rustls)
    ├── tools/            # 60+ 内置工具(与当前 TS 版 1:1 对齐，cfg 门控平台子集)
    │   ├── local_file.rs / local_command.rs / web_search.rs / web_fetch.rs
    │   ├── ask_user.rs / auth.rs / todo.rs / plan.rs ...
    │   └── (mobile feature: 裁剪 local_command / exec 类，保留其余)
    ├── group/            # 群组 deliberation · session · 黑板(纯状态机，全端)
    ├── memory/           # rusqlite FTS5(全端)
    ├── skills/           # YAML 技能引擎(全端)
    ├── scheduler/        # 定时任务(全端，iOS 语义降级为补跑)
    ├── mcp-client/       # rmcp(stdio desktop/server, SSE/HTTP 全端)
    ├── docs/             # 文档引擎
    │   ├── parse/        # calamine · lopdf · docx · image(解析，全端)
    │   └── edit/         # printpdf · docx-rs(编辑，desktop/server or TS 注入)
    ├── search/           # ignore/grep 系，ripgrep 级检索(全端)
    ├── app-server/       # JSON-RPC stdio/WS(Electron / 远端客户端)
    ├── serve/            # axum WS/HTTP server 模式(未来多设备/Web，全能力)
    ├── cli/              # worldbase chat/run/projects/serve(链接 core，全能力)
    ├── mobile-ffi/       # flutter_rust_bridge API 面(移动端宿主，能力协商过滤)
    ├── exec/             # 命令执行 + 沙箱(desktop/server only)
    ├── project-runtime/  # **Node 项目运行时**(desktop/server feature only)
    │   ├── bundled_node.rs   # spawn 内置 Node 二进制
    │   ├── bundled_pnpm.rs   # pnpm install / build
    │   └── dev_server.rs     # 启动 :3100+ / 健康检查 / 日志流
    └── im-gateway/       # IM 连接器(webhook desktop/server, socket 模式可选移动)

apps/electron/                    # 独立 Node/pnpm workspace
├── electron/                      # main/preload/宿主适配
├── src/                           # renderer、迁移期 TS main、shared、locales
├── public/ · scripts/ · tests/
└── package.json                   # Electron 依赖与构建

apps/mobile/                      # 独立 Flutter workspace（P3 创建）
├── lib/{app,core,features,l10n}/
├── android/ · ios/ · test/
└── pubspec.yaml
```

`core`、`app-server`、`cli`、`serve` 和 `mobile-ffi` 是同一个 Cargo workspace 内的 crate，不是独立仓库。Electron 通过 spawn `app-server` 的 stdio JSON-RPC 接入；Flutter 通过 `mobile-ffi` 接入。

**关键**：`project-runtime` / `exec` / `im-gateway`(webhook) 等「需要子进程/端口监听」的模块用 `#[cfg(not(feature = "mobile"))]` 门控，编译到移动端静态库时自动排除。Agent 工具集在握手时根据 `capabilities` 动态调整——桌面端全量，移动端自动隐藏 `create_project`(全栈) / `execute_command` 等工具。

---

## 3. 通用承载：一个 dispatcher，四种 transport

### 协议要点

- **JSON-RPC 2.0 全双工**。宿主 → harness: 命令与流式请求；harness → 宿主: 事件通知（带 seq）、反向请求（交互弹层/页面自动化/对话框）
- **stdio 上用换行分隔 JSON（NDJSON）**，日志走 stderr（codex app-server 同款）
- **握手即能力协商**。连接建立时交换 `protocolVersion` 与 `capabilities`: 宿主声明「我能提供哪些端口/注入工具」，harness 据此启用或隐藏对应 Agent 工具
- **四种 transport 共用同一 dispatcher**。CLI/移动端 FFI 走内存 transport，零序列化开销；协议语义完全一致

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

桌面端不减配，移动端降级——机制是「能力注入」。宿主在握手时注册自己的专属能力，harness 按能力清单动态启用工具。

| 桌面专属能力 | 实现位置 | harness 侧看到什么 |
|---|---|---|
| 文档解析(docx/xlsx/pdf 读取) | **Rust docs crate(calamine/lopdf/image)**，全端可用 | 核心内置工具 |
| 重文档编辑(PDF 插图/Office 生成) | 短期保留 TS(pdf-lib/officegen)作注入；长期 Rust(printpdf/docx-rs) | 宿主注册工具，Agent 无感知 |
| Next.js 全栈项目运行时 | Rust `project-runtime` crate(spawn Node/pnpm) | 桌面/server 独有 |
| webview 浏览器自动化 | Electron renderer / flutter_inappwebview | 全端，反向 RPC |
| 原生通知/对话框/项目窗口 | 宿主平台 API | HostServices 端口实现 |

---

## 5. Electron 集成：渐进迁移、全能力保留

### 当前接入边界

Electron 设置 → 执行中的“对话 Harness”提供 `TypeScript（旧版）`（默认）和 `Rust（app-server）` 两个后端。Rust 分支承接完整的 `ai:chat` / `ai:chatStream` 模型与工具循环，并同步会话历史、权限确认、项目、工作区、群组、页面、多模态附件、图片 Studio 与 MCP 上下文。项目、工作区、图片 Studio 与 MCP 已有 Rust 原生 RPC 路径；群组正在从 Electron 会话编排切换到 Rust 原生会话事件流。Electron 权威域工具通过 `tool.execute` 宿主反向 RPC 注册为 `electron_host_override`；Rust 二进制不可用或启动失败时才自动沿用 TS 路径。已有 Rust 流在切回 TS 后仍可完成、授权和停止。

选择 Rust 不会丢弃 Electron 上下文，也不会根据上下文回退 TS。Rust 已注册 Electron 的公开 Agent 工具名；当操作依赖 Electron 权威数据、运行时或 UI 时，同名的 `electron_host_override` 描述符替换 Rust 内建工具，并由 Rust 循环发起 `tool.execute` 宿主 RPC。Electron 模式仅把 Rust 的计划模式控制作为原生工具暴露给模型，其余域工具均走宿主桥，避免绕过 Electron 的项目、工作区、权限、图库或 MCP 状态。项目目录/运行时日志、文档 artifact store、图片 Studio 队列、subagent、MCP/Skill/Agent Workspace 持久化以及完整 memory/group 行为仍需逐项验证 1:1 语义，但它们已进入 Rust 可测试执行路径。对应的 parity 清单维护在 [HARNESS.md](../HARNESS.md)，完成前不得删除 TS `AIEngine`、工具和 Electron 服务。

### 打包与进程模型

- CI 编译 `worldbase-app-server` 二进制(mac/win/linux)，electron-builder 放 `extraResources`
- 用户选择 Rust 后按需 spawn；进程退出会向当前流发送错误，TS 后端仍可继续使用
- main 职责: 窗口/托盘/对话框/通知/更新 + IPC 代理 + 注入能力

### 渐进切换（strangler）

**renderer 与 preload 完全不动**，ipc.ts handler 逐前缀替换为转发：

```ts
// 切换前
ipcMain.handle('conversations:list', (e, args) => conversationStore.list(args))
// 切换后
ipcMain.handle('conversations:list', (e, args) => harness.call('conversations.list', args))
```

切换顺序: `settings:*` → `conversations:*` → `agents` → `ai:chatStream` → `projects/runtime` → `document`。每个域在契约、行为和宿主交互完成验证前，不删除对应 TS 实现。

---

## 6. CLI 与 serve 模式

CLI 是 `cli` crate，直接链接 core，全能力：

```bash
worldbase chat "..."
worldbase run --task "每日汇总"
worldbase projects ls
worldbase serve --port 19527  # 同一二进制变 server
```

---

## 7. 对标 Codex

OpenAI Codex([openai/codex](https://github.com/openai/codex))架构同构验证:
- Rust core + App Server(JSON-RPC 2.0 stdio JSONL + initialize 握手 + generate-ts)
- 先试 MCP server 后自建协议——与我们判断一致
- **关键边界**: codex 无移动端进程内，移动走云

---

## 8. 移动端降级：宿主层面的能力映射

**目标重申**：Rust harness 最终保持完整（与当前 TS 版 1:1），移动端的「降级」发生在**宿主接入层**，不是 harness 层。当前 Rust 仍在补齐 Electron TS parity。

### 接入方式：FFI 进程内

- core 编译为静态库链入 App（无子进程/JIT，AppFlowy 验证）
- tokio runtime 独立线程组，Dart 全异步
- 单实例 + 双通道；流式按 ~16ms 帧批量聚合跨 FFI
- panic 防线: catch_unwind，错误映射协议帧

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

| 工具/能力 | Harness 里存在 | 移动端暴露 | 替代/说明 |
|---|---|---|---|
| `create_project`(全栈 Next.js) | ✅ | ❌ | `create_lightweight_app`(WebView 轻应用 + 数据桥) |
| `execute_command` / exec 类 | ✅ | ❌ | 无替代，移动端不可用 |
| IM webhook 接收 | ✅ | ❌ | Socket 模式（可选后续） |
| 文档解析 | ✅ | ✅ | calamine/lopdf 全端 |
| 重文档编辑 | ✅ | ❌ | 只预览 |
| 浏览器自动化 | ✅ | ✅ | flutter_inappwebview |
| skills / memory / MCP(远程) | ✅ | ✅ | 全端 |
| 群组协作 | ✅ | ✅ | 全端 |
| 定时任务 | ✅ | 🟡 | iOS 补跑；Android WorkManager |

### 移动端功能清单（经过滤后）

UI 四 Tab: **对话 · 应用 · 绘图 · 我的**

| 处置 | 功能 |
|---|---|
| ✅ 全量 | 对话(24 blocks/分叉)、群组(5 模式/黑板)、文档解析(桌面级)、Studio、WebView 轻应用、浏览器自动化、skills/memory/MCP 远程 |
| 🟡 降级 | 定时任务(iOS 补跑)、LAN 分享(前台) |
| ❌ 不暴露 | 全栈项目(替代为轻应用)、exec、IM webhook、重文档编辑、多设备同步 |

**关键**：harness 里全部存在，移动端握手时在工具白名单里排除。

### 双端兼容工程

- 构建: cargokit，5 target(iOS/Android)
- 依赖: reqwest+rustls、rusqlite bundled FTS5
- cfg gate: mobile/desktop/server feature
- 二进制预算: ≤15MB/ABI
- iOS: checkpoint 断点续跑

### Flutter 架构

```
lib/
├── app/            # 路由、主题、i18n
├── core/
│   ├── rust_bridge/  # flutter_rust_bridge 生成
│   ├── protocol/     # Rust codegen Dart
│   └── harness.dart  # 单例管理
├── features/       # chat / launchpad / studio / settings
└── l10n/
```

状态管理: Riverpod；导航: 底部 Tab

---

## 9. 演进路线

| 阶段 | 内容 | 出口 | 估期 |
|---|---|---|---|
| P0 | Rust 骨架: core + providers + protocol + cli | CLI 跑通对话 | 5–6 周 |
| P1 | 核心移植: tools/skills/memory/群组/scheduler/MCP | 契约测试对齐桌面 | 8–10 周 |
| P2 | app-server + Electron 接入按域切换（当前进行中，聊天路径已可选） | 桌面可选择 Rust/TS，未迁移域继续 TS | 4–5 周 |
| P3 | mobile-ffi + Flutter 四 Tab + 轻应用 + cargokit | 移动端双端上架 | 6–8 周 |
| P4 | docs/search 全端 + exec/project-runtime(Rust 或 TS 注入) | 文档桌面级；全栈项目桌面可用 | 4–6 周 |
| P5 | 通过行为/E2E parity gate 后再删 TS + 上架打磨 | 一套 Rust 核心四宿主 | 3–4 周 |

**总计**: 9–12 个月(1–2 人)

---

## 10. 风险与边界

### 风险

- **FFI 边界**：单流+帧批量+panic 防线 P3 就位
- **Rust 工期单价**：P1 超 50% 触发 fallback 评估
- **移植期双运行**：Rust 域通过设置按需启用；未完成 parity 前保留 TS 默认实现和回退路径
- **构建矩阵**：5 target + 4 平台，P0 就建 CI
- **协议冻结**：P0 协议带 protocolVersion + capabilities
- **文档编辑 Rust 缺口**：桌面短期保留 TS 注入

### 边界

- 移动端功能收敛是宿主降级，harness 全能力
- iOS 后台物理限制，断点续跑+补跑+通知
- 交互重构非像素对齐

### fallback

若 P1 超 50%或 P3 FFI 不可解:
1. 移动端退 WS 客户端连 server
2. 核心退 Dart+Rust 插件

---

## 参考

- [OpenAI Codex](https://github.com/openai/codex)
- [AppFlowy](https://github.com/AppFlowy-IO/AppFlowy)(Flutter+Rust FFI 验证)
- [flutter_rust_bridge](https://github.com/fzyzcjy/flutter_rust_bridge)

---

**文档状态**: 🟡 v5 目标保留；当前处于 TS/Rust 渐进迁移，Electron 提供可选后端，Harness 全能力 parity 尚未完成
**维护**: 随 P0–P5 更新细节
