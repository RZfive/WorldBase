# AI 工作区 Tab 管理与切换能力 — 架构方案

## 现状与结论

探索确认：切换/管理 tab 的**底层能力在渲染层已全部存在**，只是没暴露给 AI：

- `workspace-store.ts:263` `activateWorkspaceTab(tabId)` — 切换（目前只有用户点击会调到）
- `workspace-store.ts:239` `removeWorkspaceTab(tabId)` — 关闭（含杀终端 PTY）
- `workspaceStore.tabs` + 各 tab 的 `state`（url/cwd/filePath/projectId）— 可生成 tab 清单
- 切换后的副作用**已自动接通**：KeepAlive `onActivated` 会把目标终端设为 `setActiveTerminalSession`（`read/write_active_terminal` 自动改道），browser surface watcher 会让 `read_current_page`/`interact_current_page` 自动指向新网页。**即：切了终端 tab，AI 的终端读写就跟着切；切了网页 tab，AI 的页面交互就跟着切——这正是你要的效果，零额外代码。**

缺的是三层：① 渲染层没有可被 IPC 调用的控制入口（且面板 reveal 必须走 `ChatPanelContainer.openWorkspace()` 才有窗口宽度动画）；② 主进程没有"发请求拿结果"的通道（`open_workspace_tab` 是发射后不管，AI 拿不到 tab 列表）；③ 没有 AI 工具。

## 架构设计

新增一个 AI 工具 **`manage_workspace_tabs`**（单工具 + action 枚举，冻结的工具目录只从 7 → 8，一次合约再生成即可）：

```
action: "list" | "activate" | "close"
tabId?                        — 精确 id（list 的结果）
kind? + url?/cwd?/filePath?   — 无 id 时按 kind+匹配字段定位（复用 tab-registry 的 matches()）
```

- `list`：返回所有 tab 的 `{id, kind, title, active, url|cwd|filePath|projectId}`，AI 先 list 再操作
- `activate`：只查找不创建（创建走已有 `open_workspace_tab`），切 tab 并保证面板展开
- `close`：关 tab（终端 tab 自动杀 PTY），关最后一个 tab 时收起面板
- 找不到目标时，错误信息里附带当前 tab 清单，模型可自我纠正

调用链（完全复用现有两种模式）：

```
模型 → manage_workspace_tabs
  ├─ Rust 路径: compat_tools.rs 新工具 → host.request("manage_workspace_tabs")
  │     → services.ts handleRustHostRequest 新分支
  ├─ TS 路径: ai-host/agent/tools/tool-manage-workspace-tabs.ts
  └─ 都汇聚到 windows.ts 新增 requestWorkspaceTabControlFromRenderer()
        （克隆 page_automation 的 requestId + pending map + 超时 请求-应答模式，windows.ts:411）
        → win.webContents.send('workspace:tabControl', {requestId, action, payload})
        → preload onWorkspaceTabControl → App.vue（seq-bump request ref，同 workspaceTabRequest 模式）
        → ChatPanelContainer watcher → handleWorkspaceTabControl()
             ├─ list:     读 store 生成摘要
             ├─ activate: activateWorkspaceTab() + 面板隐藏时 openWorkspace()（窗口动画）
             └─ close:    removeWorkspaceTab() + 最后一个 tab 时 closeWorkspace()
        → emit 结果 → App.vue → preload 回发 'workspace:tabControlResult'
        → ipcMain 兑现 pending → 结果作为 tool result 返回模型
```

**为什么处理逻辑放 ChatPanelContainer 而不是 App.vue 直接改 store**：面板展开/收起要走 `openWorkspace()`/`closeWorkspace()`（含窗口宽度动画与最小宽度调整，ChatPanelContainer.vue:703-734），直接改 `visible` 会让面板被挤压显示。

**权限**：与 `open_workspace_tab` 一致走默认 allow（UI 本地操作，非破坏性）。

## 实施步骤

1. **共享类型** `apps/electron/src/shared/workspace-control-types.ts`（新）：`WorkspaceTabSummary`、action/payload/result 类型，主进程/渲染层/preload 共用（仿 `shared/page-automation-types.ts`）
2. **渲染层 store** `workspace-store.ts`：新增 `findWorkspaceTabs(kind?, match?)`（复用 `definition.matches`）和 `buildWorkspaceTabSummaries()`
3. **主进程** `windows.ts` 加 `requestWorkspaceTabControlFromRenderer()`；`services.ts` 的 `handleRustHostRequest` 加 `manage_workspace_tabs` 分支（校验参数、restore/focus 窗口、await 应答）
4. **IPC 桥** `preload.ts` 加 `onWorkspaceTabControl` + `resolveWorkspaceTabControl`；`env.d.ts` 补类型
5. **渲染层接线** `App.vue` 订阅并经 request ref 传给 `ChatPanelContainer`（仿 `workspaceTabRequest`，App.vue:1389 / ChatPanelContainer.vue:955）；ChatPanelContainer 实现三个 action 的处理并发回结果
6. **TS 工具** `tool-manage-workspace-tabs.ts`（新）+ 注册进 `tools/index.ts`
7. **Rust 工具** `compat_tools.rs` 加 `ManageWorkspaceTabsTool`（domain `electron_host`，snake_case 参数，description 写清"先 list、activate 会改道终端读写/页面交互目标"）；`lib.rs` 注册导出
8. **合约** 更新 lib.rs 规范目录测试（7→8），跑 `pnpm --dir apps/electron generate:harness-tool-contracts` 再生成 `electron-tool-contracts.json`
9. **测试验证**：新增 tab 控制纯函数的 node 单测（仿 `apps/electron/tests/` 现有风格）；跑 Rust 目录测试 + 两侧 typecheck

## 涉及文件

新 3 个：shared 类型、TS 工具、渲染层单测；改 10 个：workspace-store.ts、windows.ts、services.ts、preload.ts、env.d.ts、App.vue、ChatPanelContainer.vue、tools/index.ts、compat_tools.rs、lib.rs + 合约 JSON 再生成。

## 明确不做（可后续扩展）

重命名/排序/固定 tab、管理 launchpad 停靠应用（那是 `current_page` 抽象的地盘）、把切换写入会话持久化（与用户手动点击行为保持一致，不额外触发保存）。