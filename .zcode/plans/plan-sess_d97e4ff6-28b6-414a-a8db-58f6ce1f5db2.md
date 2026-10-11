# 工作区浏览器 tab：内容加入上下文 + AI 操作页面

## 已核实的现状（不重复造轮子）

- 刷新/复制链接已完成：`BrowserWorkspaceTab.vue` 的 `reload/copyUrl` 经 WorkspacePanel 页面操作菜单触发。
- **AI 网页操作工具链已完整存在**（启动台路径）：`read_current_page` / `interact_current_page` / `fill_current_page_form` / `save_current_page_as_document`（`tool-active-page.ts`），经 `services.readActivePage/interactWithActivePage` → `pageAutomation:request/response` IPC → `App.vue handlePageAutomationRequest` 分发到活动浏览器 handle。工作区浏览器 tab **已注册** automation handle（`BrowserWorkspaceTab.vue` → `workspaceBrowserSurfaces`），系统提示注入也已接通。**无需新增任何 AI 工具、不触碰 Rust 合同。**
- 发现一个 bug 级不一致：`App.vue getActiveBrowserAutomationHandle`（L358）不检查 `currentView`，只要存在启动台内嵌浏览器应用就优先它；而 `activePageAutomationContext`（L269）在非 app 视图时以工作区 tab 为准 → 提示词声称操作工作区页面、工具实际打到后台内嵌应用。
- 两个真缺口：① 页面内容选取→上下文 完全没有（webview 页面内右键无任何菜单）；② AI 操作页面无可见入口（启动台有「网页操作对话」横幅壳，工作区没有）。

用户确认的两个取舍：壳用**聊天侧横幅**形态（不打乱左右分栏）；选取交互用**右键菜单**（稳定、支持元素级选取）。

## A. 页面右键菜单 → 加入上下文

### A1 主进程监听 guest context-menu 并转发
Electron `<webview>` 标签不直接暴露 `context-menu` 事件，需走主进程 guest webContents：
- `electron/main-process/windows.ts` 的 `did-attach-webview` 处（L102-111）：对 `persist:the-world-browser` 分区的 guest webContents 挂 `context-menu` 监听，将 `{ webContentsId, params: { x, y, selectionText, linkURL, mediaType, srcURL, isEditable } }` 经 `browserPage:contextMenu` 发给宿主窗口。
- `preload.ts` 暴露 `onBrowserPageContextMenu(cb)`（带 cleanup，对齐 `onPageAutomationRequest` 模式）；`src/env.d.ts` 补类型。

### A2 BrowserWebView 页面级右键菜单
`src/renderer/components/app/BrowserWebView.vue`：
- `did-attach`/`dom-ready` 后记录自身 guest id（`webview.getWebContentsId()`），收到转发事件且 id 匹配才响应。
- 打开菜单前立即 `executeInPage` 采集：选区全文 `window.getSelection().toString()`（params.selectionText 可能截断）；元素 `document.elementFromPoint(x, y)` 向上最多爬 3 层取有实际文本（≥40 字）的祖先 → `{ selector（复用快照脚本中 buildSelector 逻辑）, tag, text（上限 20000 字） }`；采集失败（页面跳转中）显示精简菜单。
- 菜单定位：`webview.getBoundingClientRect()` 偏移 + params.x/y，clamp 到窗口内；视觉复用现有地址栏右键菜单（`browser-address-context-menu` Teleport 模式）。
- 菜单项：有选区 → 复制 / 加入上下文；无选区 → 添加此元素到上下文；linkURL 非空 → 复制链接；固定底项「让 AI 操作此页面」。
- 新增语义事件：`contextAdd { kind:'selection'|'element'|'link', url, title, text, selector? }`、`aiOperateRequest`。

### A3 `[[web:]]` 引用标签管线（完全仿 `[[sel:]]` 瞬态引用）
- 新文件 `src/renderer/components/chat/panel/web-quote-state.ts`：`WEB_QUOTE_TAG_PATTERN`、`addWebQuote({url,title,kind,text}) → [[web:id|label]]`、`getWebQuote / removeWebQuote / pruneWebQuotes`（对齐 `selection-quote-state.ts`）。
- `ChatInput.vue`：新增 WebQuoteChip（🌐 pill，解析/移除/Backspace 弹出对齐 SelectionQuoteChip；L97-99 标签模式清单同步）。
- `message-sender.ts`：`extractWebQuoteRefs`（`[[web:id|label]]` → `网页引用「label」`）、`buildWebQuotesPrompt`（`【网页引用：{title} — {url}】…【引用结束】` 块）、发送组装（L279 combinedText）与发送后 prune（对齐 sel 流程；L106-108 模式清单同步）。

### A4 两处宿主接线（启动台同步受益）
- `BrowserWorkspaceTab.vue`：`@context-add` → `addWebQuote` → `emit('insertSelectionTag', tag)`（走既有 WorkspacePanel → ChatPanelContainer `insertDocumentTag` 链，零新增管线）；`@ai-operate-request` → 聚焦聊天输入。
- `App.vue` 启动台内嵌浏览器：`@context-add` → `addWebQuote` + `attachment-state.insertDocumentTag(tag)`，同一管线两路径共用。

### A5 i18n（zh-CN / en-US 同步）
`chatUi.webQuoteFallback`（网页引用）、`chatUi.removeWebQuote`、`chatUi.addElementToContext`（添加此元素到上下文）、`chatUi.copyLink`（如缺）、`chatUi.letAiOperatePage`（让 AI 操作此页面）。

## B. AI 操作页面：目标修正 + 壳移植

### B1 修正工具目标优先级（bug 修复）
`App.vue getActiveBrowserAutomationHandle` 与 `activePageAutomationContext` 对齐：仅当 `currentView === 'app'` 且激活内嵌浏览器应用时用内嵌 handle；否则活动工作区浏览器 tab（`workspacePageSurface`，已含 visible 门控）优先。

### B2 「网页操作」横幅壳（复用启动台 overlay 横幅样式）
`ChatPanelContainer.vue`：`props.activePageContext` 非空（首版限 `wsb-` 前缀，即工作区浏览器 tab）时在聊天输入区上方显示横幅「网页操作 · {title} · {origin}」（复用 `chat-overlay-banner` 样式），点击聚焦输入框，可关闭（页面切换后重新出现）。

### B3 入口收敛
`tab-registry-entries.ts` browser `getActions` 增加 `{ id:'aiOperate', labelKey:'chatUi.workspaceActionAiOperate' }` → `BrowserWorkspaceTab.aiOperate()`；右键菜单底项、tab 操作菜单、横幅三入口指向同一「聚焦聊天」行为。

## C. 验证
- `pnpm typecheck`（vue-tsc + tsc 双工程）。
- 新增 `tests/web-quote-state.test.mjs`（node --test + register-ts-hooks 模式，测停靠/标签替换/prune），并在 package.json 补 `test:web-quote` 脚本。
- 手动回归清单：三种右键形态（选区/元素/链接）；`[[web:]]` chip 展示/移除/发送展开；AI「读取当前页面」端到端（含启动台内嵌浏览器在后台时优先级正确）；刷新/复制链接回归；启动台内嵌浏览器右键加上下文。

## 改动文件清单
新增：`web-quote-state.ts`、`tests/web-quote-state.test.mjs`
修改：`windows.ts`、`preload.ts`、`env.d.ts`、`BrowserWebView.vue`、`BrowserWorkspaceTab.vue`、`tab-registry-entries.ts`、`ChatPanelContainer.vue`、`ChatInput.vue`、`message-sender.ts`、`App.vue`、`locales/{zh-CN,en-US}/index.ts`、`package.json`（test script）

不改动：Rust 工具合同（`electron-tool-contracts.json` / compat_tools.rs）、AI 工具定义——能力已存在，本方案全部是渲染层 + 一处主进程监听。