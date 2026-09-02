# WorldBase Rust Harness

`the-world` 采用 monorepo，但按语言和运行时边界拆成三个独立 workspace：现有 Electron、Rust Harness、Flutter 移动端。三个 workspace 独立构建、测试和发布，不合并成一个跨语言依赖图。

## Workspace 结构

```text
the-world/
├── apps/
│   ├── electron/                  # Workspace 1: 现有 Electron/Vue 桌面端
│   └── mobile/                    # Workspace 3: Flutter 移动端（已完成骨架）
├── harness-rs/                    # Workspace 2: 唯一 Rust Cargo workspace
│   ├── Cargo.toml
│   ├── crates/
│   │   ├── protocol/              # JSON-RPC schema、capabilities、事件帧（camelCase 冻结）
│   │   ├── providers/             # Anthropic / OpenAI(兼容端点) / Mock + SSE 解析
│   │   ├── tools/                 # Rust 工具集、Electron 兼容层和能力协商过滤
│   │   ├── core/                  # Hub、Agent loop、权限引擎、dispatcher
│   │   ├── group/                 # 群组协作状态机（5 模式 + 黑板）
│   │   ├── memory/                # SQLite/FTS5 会话/消息/长期记忆/设置
│   │   ├── skills/                # YAML Skill 加载与执行
│   │   ├── scheduler/             # 标准 5 段 cron 定时任务（SQLite 持久化）
│   │   ├── mcp-client/            # MCP stdio/HTTP 客户端
│   │   ├── docs/                  # 文档解析（xlsx/pdf/docx/csv/md）与编辑（docx/xlsx/csv）
│   │   ├── search/                # Glob/Grep（ignore crate，尊重 gitignore）
│   │   ├── app-server/            # stdio NDJSON JSON-RPC（Electron 接入）
│   │   ├── cli/                   # worldbase chat/run/projects
│   │   ├── exec/                  # 命令执行 + macOS Seatbelt 沙箱（desktop 域）
│   │   ├── project-runtime/       # Node/pnpm 全栈项目运行时（desktop 域）
│   │   ├── im-gateway/            # IM webhook（通用/飞书/Slack 适配，desktop 域）
│   │   └── mobile-ffi/            # Flutter FFI 导出面（worldbase_start/stop）
│   └── crates/core/tests/e2e.rs   # 端到端集成测试（mock provider 驱动完整链路）
└── docs/                          # monorepo 架构与迁移文档
```

## 依赖关系

```text
apps/mobile    -- dart:ffi worldbase_start ----> harness-rs/mobile-ffi    # ✅ 主路径（进程内）
apps/mobile    -- WS 127.0.0.1:<动态端口> ------> mobile-ffi 内置 loopback # ✅ 已跑通
apps/electron  -- spawn stdio NDJSON JSON-RPC --> harness-rs/app-server   # 渐进迁移：TS/Rust 可选
harness-rs/cli -- in-process -------------------> harness-rs/core
```

移动端 **FFI 进程内**：`dart:ffi` 加载 `libworldbase_mobile_ffi`，`worldbase_start` 在进程内启动完整 harness（返回动态端口），loopback WS/HTTP 传输是 mobile-ffi 的私有实现（`transport.rs`），UI 不展示任何连接状态/配置。独立的 serve 部署层已删除（2026-08-29 用户决策）。

- `harness-rs` 是唯一 Rust workspace，不拆分多个 Cargo workspace。
- `harness-rs` 不依赖 Electron 或 Flutter；Electron 不直接链接 Rust crate；Flutter 不复制 Agent 业务逻辑。
- `protocol` crate 是协议 schema 单一来源，JSON 字段统一 camelCase；后续产出 TS/Dart 绑定。
- 桌面/server 专属 crate（`exec`、`project-runtime`、`im-gateway`）按 `domain = "desktop"` 标注，握手时依据 capabilities（excludes: subprocess / port_binding / webhook_receiver）过滤工具与方法。
- Electron 设置中的“对话 Harness”可选择 `TypeScript（旧版）` 或 `Rust（app-server）`，默认使用 TS；选择 Rust 时，聊天模型/工具循环，以及项目、文件工作区、图片 Studio、MCP 和群组的已接入业务调用均由 Rust 处理。Electron 仍承担窗口、文件/目录选择和渲染器事件桥接等宿主职责。

## 当前状态（2026-08-31）

- ✅ **P0–P1 主体完成**：`protocol`、`providers`（SSE 跨 chunk 解析修复、OpenAI 兼容端点、Mock provider、供应商条目 auto 协议解析、OpenAI images 生图）、`tools`（原生工具、Electron 名称兼容层和 host 域工具）、`core`（Hub/Agent loop/权限 ask-allow-deny/事件总线/中止/续传/**宿主反向 RPC**/Studio 生图服务）、`memory`（FTS5 + CJK 兜底 + agents/images/分叉谱系表）、`skills`、`group`（桌面 5 模式 + 六字段黑板 + HITL 注入）、`scheduler`、`mcp-client`、`docs`、`search`、`exec`、`project-runtime`、`im-gateway`、`app-server`、`serve`（WS/HTTP + /studio 图片路由 + --host LAN 绑定）、`cli`、`mobile-ffi`。
- ✅ **协议新增（对齐桌面端）**：`provider.list/save/delete/setActive`（多供应商）、`agent.list/get/save/delete`（Agent 绑定人设/供应商/模型）、`studio.generate/list/delete`（绘图）、`conversation.fork`（分叉 fork 模式 / 就地编辑 inplace 模式）、`group.inject`（HITL 澄清注入）、`group.board.update`（黑板操作）、`skill.save/delete`、`host.respond`（反向请求应答）、`ask_user`/`read_current_page`/`interact_current_page` 宿主域工具。
- ✅ **Electron 双后端接入**：`ai:chat`、`ai:chatStream`、`ai:updateSessionAuthMode`、`ai:stopStream` 已支持按设置选择 TS/Rust；Rust 客户端会同步供应商、Agent/Agent Group 配置和会话文本历史，并转发权限、`ask_user`、页面自动化、文档和 `open_project_app` 反向请求。Rust 流在切回 TS 后仍可完成、授权和停止；Rust 二进制不可用或初始握手失败时才回退到 TS。
- ✅ **Rust 测试**：workspace 单元与集成测试全过（`cargo test --workspace`）。
- ✅ **移动端按桌面端功能完整实现并跑通**：`apps/mobile` Flutter 工程（四 Tab：对话/应用/绘图/我的，**iOS/Apple 风格 UI**——浅色分组列表、iOS 信息气泡、Cupertino 分段控件/弹窗/动作表、毛玻璃 TabBar，设计系统在 `lib/core/ios_ui.dart`）：
  - **对话**：会话抽屉（搜索/重命名/删除/分叉标记）、消息长按菜单（复制/编辑重发-分叉模式/就地覆盖/从此分叉）、Agent 选择、流式气泡、工具卡片、权限确认弹窗、ask_user 问答弹窗
  - **群组**：桌面 5 模式选择、成员编辑器、成员气泡、六字段黑板查看、HITL 注入
  - **绘图 Studio**：提示词 + 8 种比例 + 数量 → 生成（OpenAI images / mock SVG）→ 图库网格（`/studio/{id}` 取图）→ 删除
  - **应用**：轻应用（Web 快捷方式 + 内置 WebView + 页面自动化桥）、技能管理（新建/删除）、定时任务（创建/删除，移动端降级提示）
  - **我的**：**模型供应商管理**（协议 auto/openai/anthropic、Base URL、API Key、模型列表、生图能力、设默认）、Agent 工作区、长期记忆检索/添加、MCP 服务状态、连接配置收进「高级」
- ✅ **验证**：Dart E2E（真实二进制 + WS 全功能面：供应商/Agent/对话/分叉/群组/Studio/技能/定时/记忆）+ GUI 集成测试（真实 macOS 窗口驱动六步全流程）全过。
- ⏳ **P2**：继续收敛剩余边缘行为与移动端 WebView 轻应用的真机内嵌。TS Harness 保留为显式迁移选项；仅当 Rust 可执行文件缺失或初始握手失败时，Rust 选择才回退至 TS。
- ✅ **P3 部分**：macOS 桌面已跑通 FFI 进程内模式（`flutter test test/harness_ffi_test.dart` 验证 启动→握手→对话→持久化→停止）；iOS/Android 真机构建（cargokit 打包 dylib/静态库）待做。

## Electron Harness 选择与迁移

在 Electron 的设置 → 执行中选择“对话 Harness”：

- `TypeScript（旧版）`：默认实现，覆盖当前 Electron 全部 Agent 工具和宿主服务。
- `Rust（app-server）`：启用 Rust stdio NDJSON JSON-RPC。项目、群组/频道、文件夹工作区、页面上下文、多模态附件、Skill、Agent 策略、图片 Studio 与 MCP 均使用 Rust 模型/工具循环；Electron 域工具经宿主反向 RPC 执行以保留现有数据和 UI 语义。

切换只影响之后创建的聊天流。已有 Rust 流会继续运行并可停止；切回 TS 后新流走 TS。仅在 Rust 二进制不可用或进程启动失败时回退到 TS，不会再根据聊天上下文静默回退。开发环境可运行 `pnpm --dir apps/electron build:harness`，也可通过 `WORLDBASE_RUST_HARNESS` 指定二进制。

### 当前 parity 清单

Electron TS Agent 当前有 61 个公开工具名。Rust 的 `builtin_tools()` 已注册这 61 个名称，并由回归测试防止漏注册；它另外保留 Rust 自身的原生工具名。**这只保证发现和调用名称兼容，不代表行为已 1:1 等价。**

Rust 选择时，项目运行时/日志、文件工作区、图片 Studio、MCP、Agent Workspace 群组、IM 群组路由和 Electron 宿主工具均已进入 Rust 执行路径；文档 artifact store、subagent service、频道编排和记忆策略继续由契约与 E2E 测试守护存储兼容性。Electron 只保留窗口、选择器、渲染器状态和必要宿主回调。TS `AIEngine`、工具和服务仍不能删除，因为用户可随时显式选择 TS 后端。

详细边界见 [docs/rust-harness-architecture.md](docs/rust-harness-architecture.md)。

## 构建与运行

```bash
# Rust Harness
cargo build --manifest-path harness-rs/Cargo.toml
cargo test --manifest-path harness-rs/Cargo.toml --workspace
cargo run --manifest-path harness-rs/Cargo.toml -p worldbase-cli -- chat "你好"   # in-process CLI

# 真实模型（可选；缺省 mock provider）
export ANTHROPIC_API_KEY=sk-...          # 或 OPENAI_API_KEY / settings.set provider

# Flutter 移动端（harness 经 FFI 进程内启动，无外部依赖）
cd apps/mobile
flutter test test/harness_e2e_test.dart                        # 全功能面 E2E（FFI 进程内）
flutter test test/harness_ffi_test.dart                        # FFI 生命周期专项
flutter test integration_test/app_e2e.dart -d macos            # GUI E2E
flutter run -d macos                                           # 桌面预览（移动端 UI）
```

## 移动端接入协议（与 `worldbase serve`）

1. `ws://127.0.0.1:<port>/ws` 连接后发送 `initialize`，声明移动端 capabilities：
   `excludes: ["subprocess", "port_binding", "webhook_receiver"]`
2. harness 返回过滤后的 `availableTools` / `availableDomains`（desktop 域不可见）。
3. `chat.send` 后事件以 `method:"event"` 通知下行，`seq` 单调递增；断线重连后
   `chat.resume {streamId, afterSeq}` 续传。
4. `permission_request` 事件弹出确认 UI，宿主以 `chat.respond {requestId, allow}` 应答。

迁移映射详见 [docs/project-structure.md](docs/project-structure.md)；架构决策详见 [docs/rust-harness-architecture.md](docs/rust-harness-architecture.md)。
