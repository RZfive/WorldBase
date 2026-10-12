# AI 改写文档闭环（Rust 主导版）：doc_draft 工具 + 草稿状态全部在 Rust，Electron 仅做 UI 转发与预览

## 架构分工

**Rust（harness-rs）拥有全部编辑工具与草稿状态**：草稿生成、草稿文件、草稿元数据（记录在 artifact JSON）、sha256 锁、备份、覆盖/另存为/放弃的文件操作。**Electron 只保留薄管道**：宿主通知转发到渲染层、3 个 IPC→RPC 代理、预览刷新辅助、草稿横幅 UI。

## 1. Rust：草稿域实现（harness-rs/crates/tools/src/document_artifacts.rs）

新增函数（workspace 布局沿用现有 `.worldbase/` 约定）：
- `stage_document_draft(workspace, artifact_id|file_path, content)`：按 id 查 Rust store，miss 则按路径自动 import（复用现有 parse_file+write_artifact）；类型限 md/docx/xlsx/pptx（pdf 明确报错）；内容写入 `.worldbase/document-drafts/<artifactId>-<时间戳>.<ext>`（md/text 直写 `content`；docx/xlsx/pptx 用 `worldbase_docs::edit::write_docx/write_xlsx/write_pptx`，参数风格与 `doc_write` 一致：blocks/rows+sheet/slides）；清理同 artifact 旧草稿；计算原文件 sha256；在 **artifact JSON 上记录 `draft: {path, sourceSha256, createdAt, fileType}` 字段**（serde 可选字段，向后兼容）；返回草稿信息。
- `apply_document_draft(workspace, artifact_id, expected_source_sha256)`：sha 校验（不符报 `draftSourceChanged`）→ **原文件备份到 `.worldbase/document-backups/<artifactId>/`（保留最近 5 份）** → 草稿原子覆盖原文件 → 清 draft 字段 → 重解析 artifact（parse_file）并更新记录 + ensure_render_preview → 返回新 artifact + 备份路径。
- `save_document_draft_as(workspace, artifact_id, target_path)`：草稿写入目标路径 → 导入为新 artifact → 清 draft 字段（原文件不动）。
- `discard_document_draft(workspace, artifact_id)`：删草稿文件 + 清字段。
- `get_document_draft(workspace, file_path)`：按路径查草稿状态（用于 UI 重启后恢复横幅）。

## 2. Rust：AI 工具 `doc_draft`（纯 Rust 原生，同 doc_write 家族）

`document.rs` 新增 `DocDraftTool`：参数 `{artifact_id? | file_path?, kind: markdown|text|docx|xlsx|pptx, content?/blocks?/rows?/sheets?/slides?}`；无 ask 授权（只写 `.worldbase` 内部草稿区，真正的用户决定权在保存环节）；execute 调 stage_document_draft，然后 `services.host.request("document.draftStaged", payload)` 通知 UI。注册进 lib.rs 工具列表。**不改 TS 工具注册、不改契约 JSON（69 不变，已核实 Rust 原生工具不在快照内）。**

## 3. Rust：RPC 方法（dispatcher.rs + protocol/method.rs）

新增 `doc.draft.apply` / `doc.draft.saveAs` / `doc.draft.discard` / `doc.draft.get`，分派到上述函数（沿用 DOC_EDIT_SOURCE 命名风格）。

## 4. Electron 薄管道

- `services.ts` 宿主请求新增 `document.draftStaged` 分支：校验后 `webContents.send('workspace:documentDraft', payload)`（纯转发）。
- `ipc.ts` 新增：`document:applyDraft` / `document:saveDraftAs`（含原生保存对话框，默认名 `原名-modified.ext`）/ `document:discardDraft` / `document:getDraft` —— 经 `mainState.rustHarness` client.call 对应 RPC；另加 `document:refreshFromDisk`（Electron store 修剪同路径旧 artifact + 重导入 + ensureRenderPreview，解决覆盖后 Electron 侧缓存陈旧）。
- `preload.ts` + `env.d.ts`：推送通道 `onWorkspaceDocumentDraft` + 上述 IPC。

## 5. 渲染端：草稿实时预览 + 决策 UI

- `workspace-store.ts`：UI 态 `documentDrafts`（路径→{draftPath, updatedAt}）+ `stageWorkspaceDocumentDraft()`（确保该文件页签存在/激活、记录草稿；面板可见）；`buildDocumentWorkspaceContextPrompt` 增加指引：改写文档必须用 `doc_draft` 提交完整修改稿，由用户预览决定保存/另存为，禁止直接覆写。
- `App.vue`：注册 draft 监听 → `stageWorkspaceDocumentDraft`。
- `DocumentFileTab.vue`：路径有草稿时——`importDocument(draftPath)` 导入草稿，经现有 DocumentRenderHost 渲染（xlsx/pptx/md/docx 的 HTML 渲染器直接适用；**每次新草稿事件即重导入重渲染 = 实时预览**）；顶部横幅「AI 修改稿预览 · 时间」+ [保存到原文件] [另存为…] [放弃]；保存→refreshFromDisk→重解析（预览立即切到已保存文件，提示含备份位置）；另存为→新开文档页签指向新文件；放弃→恢复原文预览。tab 解析时调 `document:getDraft` 恢复未决草稿横幅。

## 6. 添加上下文（保持原设计，属提示管道不属编辑工具）

- 文档页签动作菜单加「引用到对话」：插 `[[docfile:<artifactId>|<文件名>]]` 到输入框（走现有 insertSelectionTag 通道）。
- 新增纯函数模块 `chat/panel/docfile-tag.ts`（模式 + 提示块构建）+ `message-sender.ts` 接入：发送时经 `document:buildFileContextPrompt`（读 Electron store plainText，截断 ~24000 字）注入 `【文档全文：…】`。
- Electron `DocumentStore` 加 `buildFileContextPrompt(ids)`。

## 7. i18n

zh-CN/en-US：草稿横幅、三按钮、放弃确认、保存成功（含备份位置）、sha 冲突、pdf 不支持改写、工具描述。

## 范围

- 改写支持 md/docx/xlsx/pptx（office 为整体重生成、AI 提供全量内容，与 doc_write 同水位）；pdf 本期不支持（报错引导转 md），仍可作上下文读取。
- 覆盖保存自动备份原文件（Rust 侧 `.worldbase/document-backups/`，保留 5 份）。

## 测试

- Rust：document_artifacts.rs `#[cfg(test)]` 新增 stage/apply（含 sha 冲突、备份产生）/saveAs/discard/get 用例；`cargo test -p worldbase-tools` + `cargo check`。
- Electron：`docfile-tag.ts` 小单测；`pnpm typecheck`；`test:harness-tool-contracts` 保持 69 通过。
- 手动：md/xlsx 打开 → 引用到对话 → 让 AI 改写 → 页签即时切草稿预览 → 保存/另存为/放弃三路径 → 重启后会话复原 + 未决草稿横幅恢复。

## 实施顺序

1. Rust document_artifacts 草稿函数 + 单测（cargo test 绿）
2. doc_draft 工具 + lib.rs 注册 + method.rs/dispatcher RPC + host 通知
3. Electron 管道（services 转发、IPC/preload/env.d.ts、refreshFromDisk）
4. 渲染端（workspace-store 草稿态、App 接线、DocumentFileTab 横幅/预览/按钮）
5. docfile 上下文标签 + 上下文提示指引
6. i18n + 全量验证（cargo test/typecheck/契约/手动）