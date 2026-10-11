# 工作区 Tab 2.0：浏览器 Tab + 一文档一 Tab + 混合上下文

## 现状与差距
上一轮已完成通用 tab 面板(注册表 + folder/document 两个单例 tab + AI `open_workspace_tab` 工具)。当前差距：
1. **没有浏览器 tab** —— 工作区只能开代码/文档，"辅助操作网页"能力缺位
2. **文档仍装在单个"文档工作区" tab 里**(左侧文档列表 rail + 右侧预览) —— 与"一文档一 tab"的目标不符
3. **对话上下文与 tab 不对齐** —— 文档上下文来自独立 ref 数组，不是从 tab 集合派生，混合绑定不直观

## 目标形态
```
┌──────────────────────────────────────────────┐
│ [</> 代码] [📄a.pdf] [📄b.xlsx] [🌐 页面] [+] │  ← tab 条,任意混排
├──────────────────────────────────────────────┤
│                当前 tab 内容                   │
└──────────────────────────────────────────────┘
```
- **文档**:一个文档 = 一个 tab,打开/关闭 tab 即绑定/解绑该文档到对话上下文；多个文档 tab 与代码 tab 混排
- **浏览器**:非单例 tab,内嵌完整浏览器(地址栏+网页)，AI 可对其做页面自动化(read/interact/fill_current_page)
- **混合上下文**:对话上下文 = 所有 tab 派生的引用集合(文档 artifacts+selections、代码 root、浏览器活跃页面)，`[[doc:]]`/`[[code:]]` 标签天然混插

## 改造设计

### 1. 文档改为"一文档一 tab"(多实例)
**tab-registry.ts**:定义增加可选 `matches(tab, payload): boolean`(身份去重:document 按 filePath、browser 按 URL、folder 恒单例);`ensureWorkspaceTab(kind, payload)` 改为先用 matches 找已存在 tab,命中则激活返回 `created:false`。

**新组件 `workspace/tabs/DocumentFileTab.vue`**(替代 rail 版 DocumentWorkspaceTab):
- state:`{ filePath, fileName }`;title = fileName
- 内容 = 原 DocumentWorkspace 的预览部分:顶部工具条(打开原文件)+ selection 标签区 + `DocumentRenderHost`(artifact 加载/预览确保/划选高亮/标签增删逻辑从原组件平移)
- 打开 tab 时按 filePath `importDocument`/`listDocuments` 解析 artifactId;关闭 tab 即解绑该文档

**打开入口**:
- "+"菜单"打开文档…" → 容器调 `pickDocumentFiles`,每个文件开一个 tab
- AI:`open_workspace_tab {kind:'document', file_path}` 命中已有同路径 tab 则仅激活
- 会话恢复:N 个绑定文档 → N 个 document tab(恢复 activeTabId)

**workspace-store.ts 数据模型重构**(核心):
- 删除 `documents` / `documentActiveFilePath` 独立 ref —— 文档集合**从 tabs 派生**
- `buildCurrentDocumentWorkspaceState()`(legacy 双写)= 所有 document tab 的 state 并集,activeFilePath = 激活文档 tab 的 filePath
- `buildDocumentWorkspaceContextPrompt()` 遍历 document tabs,"[active]" 标当前激活者
- `removeWorkspaceTab` 的 document 特判删除(解绑自动发生)
- `applyWorkspaceState` legacy 迁移:每个旧文档 → 一个 tab

### 2. 浏览器 tab(非单例)
**新组件 `workspace/tabs/BrowserWorkspaceTab.vue`**:
- 直接包裹现有 `BrowserWebView.vue`(appId=`wsb-<tabId>`、partition 沿用 `persist:the-world-browser`,登录态共享)
- `@stateChange` → 回写 `tab.state.{url,title}` + `tab.title`(tab 条标题随页面标题更新,面板已支持 title 覆盖)
- 注册表:singleton=false、min 520 / max 1800 / default 1100、globe 图标
- "+"菜单新增"浏览器"(无 URL 时开 about:blank 新页)

**会话持久化**:browser tab 持久化 `{kind:'browser', state:{url,title}}`,恢复会话时重开页面(轻量,断连可接受)。

### 3. AI 页面自动化接线(工作区浏览器 tab 成为"当前页面")
沿用现有 active-page 机制,**优先级:内嵌 app 页面 > 工作区浏览器 tab**:
- workspace-store 增加 `browserSurfaces: Map<tabId, {url,title,handle}>`,BrowserWorkspaceTab 挂载/卸载/stateChange 时维护(handle = BrowserWebView 实例,暴露 captureAutomationSnapshot/runAutomationAction)
- ChatPanelContainer computed:激活 tab 为 browser 且面板可见 → 派生 surface,经新事件链 `pageSurfaceChange` → ChatPanel → **App.vue**
- App.vue:`activePageSurface` 与 `getActiveBrowserAutomationHandle()` 增加 fallback 到工作区 surface;`activePageAutomationContext` 放宽"仅 app 视图"限制(聊天视图下工作区浏览器 tab 也作为页面上下文随 chatStream 下发)→ `read_current_page`/`interact_current_page`/`fill_current_page_form` 自动作用于该 tab

### 4. AI 工具扩展(同一工具,参数扩展)
`open_workspace_tab`:
- `kind` enum 增加 `'browser'`;新增 `url` 参数(browser);`file_path` 语义变为单文档路径
- 同步四处:TS 工具定义、services.ts host_request 分发(补 browser+url)、Rust 兼容桩 schema、重新生成 electron-tool-contracts.json(数量仍 69)
- agent.rs 提示语补充 browser 用法

### 5. i18n 与清理
- 新增:workspaceTabBrowser(浏览器)、打开文档/打开浏览器菜单文案;中英双语
- 删除 rail 版 DocumentWorkspaceTab.vue;rail 相关旧 key 保留不碍事

## 文件清单
- **新增**: `workspace/tabs/DocumentFileTab.vue`、`workspace/tabs/BrowserWorkspaceTab.vue`
- **修改**: tab-registry.ts(matches+身份去重)、tab-registry-entries.ts(document 多实例/browser 注册)、workspace-store.ts(文档派生化+browserSurfaces)、WorkspacePanel.vue(无结构性变化,标题已支持)、ChatPanelContainer.vue(openWorkspaceTab 分流+文件选择器+surface 事件)、ChatPanel.vue、App.vue(surface fallback)、panel/types.ts(pageSurfaceChange 事件)、tool-open-workspace-tab.ts、services.ts、Rust compat_tools.rs/lib.rs、i18n
- **删除**: workspace/tabs/DocumentWorkspaceTab.vue(rail 版)
- **不动**: 文档 IPC(artifact/selection)、BrowserWebView 本体、[[doc:]]/[[code:]] 标签机制、窗口宽度管理

## 实施顺序
1. 文档 per-tab 改造(store 派生化 → DocumentFileTab → registry → 容器/持久化/prompt)
2. 浏览器 tab(组件 → 注册 → 标题/持久化)
3. 页面自动化接线(container → App.vue fallback)
4. AI 工具参数扩展 + Rust/契约同步
5. i18n + 删旧组件 + typecheck + cargo/node 测试

## 风险与对策
- 文档上下文从"独立 ref"改为"tabs 派生"是行为等价重构 —— 用 legacy 双写字段做回归锚点,`buildDocumentWorkspaceContextPrompt` 输出格式保持不变
- 多个 webview 常驻(KeepAlive)内存开销 —— 浏览器 tab 数量由用户控制,与现有"多个内嵌浏览器 app"同级;必要时后续再加非激活 tab 挂起
- Rust 契约 schema 必须与 TS 完全一致 —— 用生成器产出后对齐,`test:harness-tool-contracts --check` 把关