# 工作区终端 tab + AI 操作终端 + 内置应用 tab — 架构方案（Rust 单引擎版）

## 已核实的地基（同前）+ 本次新确认
- 终端设施为零（无 xterm/node-pty）；工作区 tab 注册体系、Rust 宿主请求桥（`host_tools.rs` → `services.ts handleRustHostRequest`）、内置应用启动流（`getProjectStatus → startProject → 15s 轮询端口`）均已确认。
- **Rust 工具的模型可见 schema 来自 `electron-tool-contracts.json`（由 TS 冻结 registry 生成，`ElectronContractTool` 覆盖兼容工具的 description/schema）**；Rust 原生新工具通过 trait 的 `electron_native() -> true` 直接暴露（`execute_command` 先例），不进合同文件。
- `ai:chatStream`（ipc.ts）是引擎无关入口：`buildActivePagePromptSection` 在 Electron 侧拼进消息数组后交给 Rust harness——终端上下文照此注入。
- 按用户指示：**不新增任何 TS 引擎代码**（aiEngineServices / tools/index.ts 不动）；TS 工具定义仅作为合同 schema 源维护。

## Part 1 — 终端基础设施（Electron 主进程，node-pty）

依赖与打包：`node-pty`、`@xterm/xterm`、`@xterm/addon-fit`；`pnpm.onlyBuiltDependencies` 加 node-pty；`electron-builder.json asarUnpack` 加 `**/node_modules/node-pty/**`；`pnpm rebuild:native`。

新文件 `electron/main-process/terminal/terminal-manager.ts` + `terminal-ansi.ts`（纯函数）：
- `TerminalSession { id, cwd, cols, rows, pty, scrollback(环形 ~200KB), exitCode? }`
- `createSession({cwd,cols,rows})`（cwd 限定文件夹工作区根/项目目录/$HOME）、`write/resize/kill/snapshot({lines?,maxChars?})`（ANSI 清洗+尾部截断）、`setActive/getActive`、quit 时 `disposeAll`
- 输出事件 `terminal:data:{sessionId}`、退出 `terminal:exit:{sessionId}` 推送到窗口

IPC（ipc.ts + preload.ts + env.d.ts）：invoke `terminal:create/write/resize/kill/snapshot/setActive`；on `terminal:data/terminal:exit`。

## Part 2 — 终端 tab（渲染层，同前版）

`tabs/TerminalWorkspaceTab.vue`：xterm + FitAddon；`onData→write`、`data→term.write`、`onActivated` 快照回放补齐；关 tab → kill；`state={cwd}`（持久化 cwd/title，restore 重建会话）；默认 cwd=文件夹工作区根否则 $HOME；`matches` 按 cwd 去重；actions：clear/copyOutput/aiOperate；激活时 `terminal:setActive` 并维护 `workspaceTerminalSurfaces`。
注册 kind `terminal`（420–1320/760）+ i18n + `removeWorkspaceTab` 清理 + ChatPanelContainer terminal 分支 + `terminalSurfaceChange` emit → App.vue `activeTerminalContext`。

## Part 3 — AI 操作终端（仅 Rust 工具 + 宿主请求）

- `harness-rs/crates/tools/src/host_tools.rs` 新增：
  - `ReadActiveTerminalTool`（read_active_terminal {lines?, max_chars?} → cwd+清洗后输出尾部+运行状态）
  - `WriteActiveTerminalTool`（write_active_terminal {text, execute?, wait_ms?}，execute 补 `\r`，等待后回读增量；**permission 'ask'**——人工批准即门槛，不做命令白名单）
  - 两者 `electron_native() -> true`、domain "host"；**不进合同 JSON，不碰 TS 工具**
- `lib.rs`：注册清单加入两个工具（electron_native 白名单处同步）
- `services.ts handleRustHostRequest` 新增 `terminal_automation {action:'read'|'write', text?, execute?, max_chars?, wait_ms?}` 分支 → 直调 TerminalManager（无需 renderer 往返）
- 提示词注入（引擎无关层）：`ai:chatStream`（ipc.ts）参数加 `activeTerminalContext {cwd,title}`（preload/env.d.ts/message-sender 同步，仿 activePageContext 全链路）→ `windows.ts buildActiveTerminalPromptSection`（"## Active terminal … use read/write_active_terminal"）→ 与 activePagePromptSection 并列拼入（ipc.ts L677/L706）

## Part 4 — 内置应用 tab（kind `project`，载体 BrowserWebView）

- `tabs/ProjectAppWorkspaceTab.vue`：启动流对齐 `openEmbeddedProject`（getProjectStatus → startProject → 轮询端口 15s，错误态+重试）；就绪后 `BrowserWebView` 加载 `http://127.0.0.1:{port}` 并注册 `workspaceBrowserSurfaces`（appId `wsb-{tab.id}`）→ AI 页面操作/右键加入上下文/刷新全部免费继承；周期校验运行状态，端口变化自动重载。
- `state={projectId,name}`，title=项目名，`matches` 按 projectId，持久化只存 projectId；actions：reload/copyUrl/aiOperate。
- 注册 kind `project` + i18n + ChatPanelContainer project 分支（无 payload → `listProjects` 项目选择弹层）。

`open_workspace_tab` 扩展（合同源维护，非 TS 引擎实现）：
1. `tool-open-workspace-tab.ts` 仅改 schema 源：kind 枚举 + `project_id` 属性 + 描述（Rust 兼容实现照旧映射，ElectronContractTool 由此取模型可见 schema）
2. `pnpm generate:harness-tool-contracts` 再生成 JSON（`test:harness-tool-contracts` 保持绿）
3. `compat_tools.rs OpenWorkspaceTabTool`：自身 schema 的 enum 同步加 project（非 Electron 宿主路径一致）+ execute 映射 `project_id→payload.projectId`
4. `services.ts` open_workspace_tab 宿主请求校验加 `project` + projectId 映射

## 实施顺序
1. 依赖 + TerminalManager + IPC → 2. 终端 tab → 3. project 应用 tab → 4. Rust 终端工具 + 宿主请求 + 提示词注入 → 5. open_workspace_tab project 扩展（合同再生成）

## 验证
- `pnpm typecheck`；`pnpm test:harness-tool-contracts`；`pnpm test:rust-harness-host-callbacks`
- 新增 `tests/terminal-snapshot.test.mjs`（ANSI 清洗/环形裁剪/快照截断纯函数）；Rust 侧 `cargo test -p the-world-tools`（lib.rs 注册断言）
- 手动：终端交互与 KeepAlive 回放/restore 重建；应用 tab 启动→AI 操作页面→右键引用；AI「在终端跑 npm install」端到端（严格授权弹窗、Rust 引擎路径）；合同再生成 diff 仅含预期变更

## 风险与对策（同前）
node-pty 三平台 ABI/打包；输出进模型前 ANSI 清洗+截断；write 权限 ask+严格授权默认；project tab 不持久化端口。

## 改动文件清单
新增：`electron/main-process/terminal/{terminal-manager,terminal-ansi}.ts`、`tabs/{TerminalWorkspaceTab,ProjectAppWorkspaceTab}.vue`、`tests/terminal-snapshot.test.mjs`
修改：`package.json`、`electron-builder.json`、`ipc.ts`、`preload.ts`、`env.d.ts`、`services.ts`（宿主请求×2）、`windows.ts`、`tab-registry-entries.ts`、`workspace-store.ts`、`ChatPanelContainer.vue`、`App.vue`、`message-sender.ts`、`tool-open-workspace-tab.ts`（仅 schema 源）、`locales/{zh-CN,en-US}`；Rust：`host_tools.rs`、`compat_tools.rs`、`lib.rs`、`electron-tool-contracts.json`（再生成）