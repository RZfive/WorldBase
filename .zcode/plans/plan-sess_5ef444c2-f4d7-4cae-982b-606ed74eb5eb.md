# 对话中写入/生成的文档可点击,在 tab 页打开查看

## 现状与思路

探索发现三块现成机制,只需接通:

1. **展示通道(死代码复活)**:聊天 block 已有 `file_preview` 类型 + `FilePreviewBlock.vue` 卡片组件,renderer 的事件处理(`message-sender.ts:504-542`)完好,block 会随会话 JSON 持久化。但旧 TS agent 循环移除后,Rust harness 再也不发 `file_preview_start/end` 事件 —— 只需在引擎里把写入类工具的结果转成这两个事件即可,renderer 零改动。
2. **打开通道**:`ChatPanelContainer.vue` 的 `openWorkspaceTab('document', { filePath, fileName })`(1080 行起)是现成入口,`document` tab(`DocumentFileTab.vue`)支持 md/pdf/office 富渲染,按路径自动去重;folder tab 支持 `activeFilePath` 定位文件(`FolderWorkspaceTab.vue` 已有 watcher)。
3. **点击拦截点**:`MessageList.vue` 的 `handleMessageLinkClick`(189-201 行)已用捕获阶段拦截 markdown 链接,但只处理 http(s)。

写入工具的结果字段(已从 Rust 源码确认):`write_file`/`edit_file`/`patch_file`/`doc_write` → `path`(相对 harness workspace = projectsDir);`write_workspace_file`/`edit_workspace_file`/`patch_workspace_file` → `file_path`(相对 folder workspace root);`write_project_file`/`edit_project_file` → `file_path`(相对项目根);`local_write_file` → `file_path`(绝对路径)。

## 实施步骤

### 1. Rust 引擎:写入工具结果 → file_preview 流事件
- `apps/electron/electron/main-process/rust-harness-client.ts`:加一个公开 getter `get workspaceDir()` 返回 `this.options.workspace`(当前是 private,213 行),供引擎解析 projectsDir。
- `apps/electron/src/main/ai-harness/rust-harness-engine.ts`:在 `chatStream` 的 native `tool_result` 分支(233-251 行,`todo_update`/web 事件旁)新增 helper `fileWritePreviewEvents(name, content, context)`:
  - 按上表取路径字段与主 root;路径为绝对则直接用,否则按候选 root(`context.workspaceRoot`、`client.workspaceDir`)用 `fs.existsSync(join(root, p))` 选存在的那个,兜底 join 主 root。
  - 跳过:无路径、`delete_*` 工具、`isError`。
  - 同步 emit `file_preview_start { filePath }` + `file_preview_end { filePath, lineCount: 0, added: 0, removed: 0 }` —— 必须在 `frameToStreamEvent` 发出 `tool_end` 之前(249-250 行同款 emit 模式),保证卡片挂在当前运行中的工具 run 上。
- renderer `message-sender.ts` 无需改动(卡片创建、进度条目、持久化全部现成);绝对路径保证会话重载后仍可点击。

### 2. 文件写入卡片可点击
- `apps/electron/src/renderer/components/chat/blocks/FilePreviewBlock.vue`:`.fw-path`(40 行)从纯 div 改为 `<button type="button" :data-file-path="block.filePath">`,加 hover 下划线与 title 提示;locales(en-US/zh-CN)新增 `chatUi.clickToOpenHint`(「点击查看」/ "Click to view")。
- 不做 emit 逐层透传:由 MessageList 捕获 `[data-file-path]`(步骤 3),避免 ToolGroupBlock/MessageRow 加噪音。

### 3. MessageList 点击拦截扩展
- `apps/electron/src/renderer/components/chat/messages/MessageList.vue` `handleMessageLinkClick`:
  - 新增 `closest('[data-file-path]')` 分支 → `preventDefault()` + `emit('openFilePath', el.dataset.filePath)`;
  - 锚点分支扩展:`file://` 协议、以及非 http(s) 但形如文件路径(绝对路径或带扩展名的相对路径)的 href → `preventDefault()` + `emit('openFilePath', 解码后的路径)`;http(s) 保持走原 `openLink`。这同时修复了相对路径 href 会触发窗口导航的隐患。
  - emits 声明新增 `(e: 'openFilePath', filePath: string): void`。

### 4. ChatPanelContainer 接线
- `apps/electron/src/renderer/components/chat/panel/ChatPanelContainer.vue`:在 `@open-link`(1610 行)旁为 MessageList 加 `@open-file-path` → 新函数 `openChatDocument(rawPath)`:
  - 解析:绝对路径直接用;相对路径 join 当前会话的 folder workspace root(容器 187 行已导入同一 folder-workspace store 的更新函数,取对应的读取函数);
  - 扩展名属于文档类型(md/markdown/pdf/docx/doc/xlsx/xls/pptx/ppt)→ `openWorkspaceTab('document', { filePath, fileName })`;
  - 否则若解析后位于 folder root 内 → `openWorkspaceTab('folder', { rootPath, activeFilePath: 相对路径 })`(复用现有 folder 分支 + tab 内定位 watcher);
  - 其余(无 folder 工作区的杂文件)不响应。

### 5. 正文提及的已生成文档路径自动可点击
- 仿照 `ContentBlock.vue` 已有的 annotation 后处理 DOM pass(`applyAnnotationMarks`,461-474 行):
  - 从当前会话所有消息的 `file_preview` block 收集已知绝对路径集合,由 MessageList 以 provide(或 prop)传给 ContentBlock;
  - 渲染后遍历文本节点,命中已知路径或其文件名的片段(跳过代码块、已有链接)包成 `<a class="chat-file-link" data-file-path="绝对路径">`,点击由步骤 3 统一处理;
  - 只对本次会话真实写过的文件生效,避免误伤普通文字。

### 6. 验证
- `pnpm -C apps/electron typecheck`(vue-tsc + tsc);跑相关 eslint。
- 手动冒烟:让 AI 写一个 .md 与一个 .json → 卡片出现且可点;md 打开文档 tab 富渲染;json(若在 folder 工作区内)打开 folder tab 定位;重载会话后仍可点击;正文提及路径自动成链接。

## 明确不做
- 不改 harness-rs Rust 侧代码;`doc_draft` 已有独立草稿预览流程,不动;不 linkify 未在会话中写过的路径;csv/json/txt 等不新做代码查看器(走 folder tab 或不响应)。