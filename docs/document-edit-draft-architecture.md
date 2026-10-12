# 文档编辑实时预览与保真架构方案（Draft 2.0）

**版本**: v1（方案定稿，未实施）
**日期**: 2026-10-12
**范围**: Rust harness（`doc_draft` / 文档 artifact 存储）· Electron 主进程（IPC / 文件监听 / OOXML 手术）· 渲染层（文档工作区页）
**关联文档**: `rust-harness-architecture.md`（Rust/宿主边界）、`ai-agent-tools.md`（工具契约）

---

## 目录

1. [背景与问题](#1-背景与问题)
2. [现状梳理与根因](#2-现状梳理与根因)
3. [目标与非目标](#3-目标与非目标)
4. [总体架构](#4-总体架构)
5. [详细设计 A：变更可见性（Diff 展示）](#5-详细设计-a变更可见性diff-展示)
6. [详细设计 B：实时刷新与写入收敛](#6-详细设计-b实时刷新与写入收敛)
7. [详细设计 C：PPT/Word 保真编辑（保留图片与样式）](#7-详细设计-cpptword-保真编辑保留图片与样式)
8. [数据结构与接口变更汇总](#8-数据结构与接口变更汇总)
9. [实施计划与验收标准](#9-实施计划与验收标准)
10. [风险与边界](#10-风险与边界)
11. [测试计划](#11-测试计划)

---

## 1. 背景与问题

用户通过 AI 修改已打开的文档（docx / pptx / xlsx / md 等）时，存在两个已确认的缺陷：

**问题 1：文档页不实时更新，且用户看不到"改了什么"。**
AI 修改文档后，工作区的文档预览页停留在旧内容；即使走草稿流程，页面也只是整篇切换为草稿内容，没有变更点提示，用户无法判断是否值得保存。

**问题 2：PPT 编辑后图片丢失。**
AI 修改 PPT 保存后，原文件中的图片全部消失，只剩文字。

---

## 2. 现状梳理与根因

### 2.1 草稿流水线（现有唯一的通知链路）

```
AI 调用 doc_draft (Rust, harness-rs/crates/tools/src/document.rs:325)
  → stage_document_draft (crates/tools/src/document_artifacts.rs:1215)
      写草稿到 .worldbase/document-drafts/<artifactId>-<ts>.<ext>
      记录 sourceSha256（应用时校验，防覆盖用户后续修改）
  → host request "document.draftStaged" (document.rs:437)
  → Electron services.ts:470 → win.webContents.send('workspace:documentDraft')
  → App.vue:1346 (onWorkspaceDocumentDraft)
  → ChatPanelContainer.vue:938 stageWorkspaceDocumentDraft + 打开/聚焦文档页
  → DocumentFileTab.vue:445 watch(draft) 导入草稿 → 整篇预览草稿文件
  → 用户点击横幅按钮 (DocumentFileTab.vue:671-689)：
      应用到原文件 / 另存为副本 / 丢弃
  → doc.draft.apply / saveAs / discard (protocol/src/method.rs:86-89)
```

用户要求的"操作里决定保存还是另存副本"**已存在**（应用 / 另存副本 / 丢弃三按钮）；真正缺失的是"看到改了什么"与"刷新链路收敛"。

### 2.2 根因 1：刷新链路单点、无 diff

| 缺口 | 位置 | 说明 |
|---|---|---|
| 直写工具绕过草稿 | Rust `local_write_file`（`compat_tools.rs:2333`，office_data 分支 2435/2471/2494 直接 `write_docx/write_xlsx/write_pptx`）、`write_file`/`edit_file`（`fs_tools.rs`） | 直接覆写原文件，不产生任何通知 |
| Electron 端同样存在直写 | `tool-local-file-write.ts:52` → `writeOfficeDocument`（168）→ officegen 全量重建 | 只发 chat 状态行，不通知文档页 |
| 无文件监听 | 全工程无 chokidar/fs.watch；`document-store.ts` 为纯内存 Map，无变更事件 | 磁盘变化（含用户在 WPS/Word 外部修改）对已打开页面不可见 |
| `refreshDocumentFromDisk` 单一调用点 | IPC handler `ipc.ts:1801`，唯一调用方 `DocumentFileTab.vue:493`（应用草稿后） | 只覆盖草稿应用场景 |
| 通知失败静默 | `document.rs:437` `let _ = ...request(...)`；按 `getActiveAiRequestWindow()` 路由 | 多窗口/窗口切换时草稿横幅可能不出现，且无恢复手段 |
| 无 diff 能力 | 草稿预览 = 整篇替换 | 原稿与草稿都有 DocumentNode 树，但从未对比 |

### 2.3 根因 2：PPT 图片丢失（端到端三处叠加）

1. **解析端只抽文字**：Rust `parse::pptx`（`docs/src/parse.rs:355`）与 Electron `document-parser-pptx.ts` 都只遍历 `<a:t>`，图片不进 AI 上下文——模型根本不知道有图。
2. **写入端全文重建**：Rust `write_pptx`（`docs/src/edit.rs:171`，自述 "self-contained … text slides"）与 Electron officegen `writePptxFile`（`office-utils.ts:343`）都从零生成仅含文字的最小包，`ppt/media/*` 与图片关系全部丢弃。docx 同理（`write_docx` / `writeWordFile`）。
3. **应用时原子替换**：`apply_document_draft`（`document_artifacts.rs:1304`，覆盖在 1362-1377）把含图原文件替换为纯文字草稿。sha 保护只防"用户后改"，不防"内容降级"。

**对照组**：Electron `document-edit-service.ts` 已验证正确模式——加载原 zip、只改目标 XML、其余部件原样保留（docx 改段落/插图已实现并带 `exportDocumentCopy` 校验）；预览端 `pptx-html-preview.ts` 本身支持渲染图片。问题不在能力，在于草稿流没有走这条路。

---

## 3. 目标与非目标

### 目标

1. **G1 变更可见**：AI 修改文档后，用户在文档页能立即看到（a）发生了修改、（b）改了哪些位置（结构化变更清单 + 预览内高亮）。
2. **G2 保存决策权在用户**：保持并强化现有"应用到原文件 / 另存为副本 / 丢弃"操作；有数据丢失风险时必须二次确认。
3. **G3 实时性**：任何 AI 写入路径（草稿或直写）和外部程序修改，都能让已打开的文档页感知并提示。
4. **G4 保真编辑**：pptx/docx 修改保留图片、媒体与未触及部分；AI 的编辑语义是"操作"而非"全文重写"。
5. **G5 跨端一致**：核心编辑能力落在 Rust `worldbase_docs`（与 `rust-harness-architecture.md` 的"文档解析与基础编辑 Rust 原生化"原则一致），CLI/移动端可复用。

### 非目标

- 不做在线协同编辑或富文本编辑器（页面仍是预览 + 决策，不是编辑器）。
- 不承诺完整 OOXML 样式保真（母版、SmartArt、图表等复杂部件只保证"不破坏、原样保留"，不支持语义级修改）。
- xlsx 操作式编辑列入 P2，本方案只定义协议占位。
- 不改变 `doc_draft` 的权限模型（`ask`）与 sha 冲突保护语义。

---

## 4. 总体架构

### 4.1 目标态写入路径（收敛为单一入口）

```
                    ┌─────────────────────────────────────────────┐
                    │              AI 写入意图                     │
                    └──────────────┬──────────────────────────────┘
                                   │
                     目标是已导入/已打开的文档？
                                   │ 是
                    ┌──────────────▼─────────────────────┐
                    │  执行层拦截（B1）：直写工具拒写并   │
                    │  返回"必须使用 doc_draft"错误       │
                    └──────────────┬─────────────────────┘
                                   │
                    ┌──────────────▼─────────────────────┐
                    │  doc_draft（唯一写入口）            │
                    │  · P0: 全文内容 + dataLossRisk 检测 │
                    │  · P1: ops 操作列表（保真手术）     │
                    │  · 产出: 草稿文件 + changes 清单    │
                    └───────┬──────────────────┬────────┘
                            │                  │
              draftStaged 通知(加固)      doc.draft.get 兜底恢复
                            │                  │
                    ┌───────▼──────────────────▼────────┐
                    │  文档页: 草稿预览 + 变更高亮(A)     │
                    │  横幅: 应用 / 另存副本 / 丢弃       │
                    └───────────────────────────────────┘

     外部修改（WPS/Word 等直接改磁盘）
                    │
                    ┌───────▼───────────────────────────┐
                    │  文件监听(B1) → "文件已在磁盘被修改" │
                    │  [重新加载] [忽略]                  │
                    └───────────────────────────────────┘
```

### 4.2 三条工作流与模块归属

| 工作流 | Rust harness | Electron 主进程 | 渲染层 |
|---|---|---|---|
| A 变更可见性 | `stage_document_draft` 产出 changes | — | DocumentFileTab 横幅 + 高亮 + 对照视图 |
| B 实时刷新 | 直写工具拦截守卫 | 文件监听服务、通知路由加固 | 过期提示条、focus 恢复草稿 |
| C 保真编辑 | `worldbase_docs::edit` 新增 ops 手术（zip 级） | 迁移/对齐 `document-edit-service.ts` 语义 | 无（预览自动呈现图片） |

---

## 5. 详细设计 A：变更可见性（Diff 展示）

### 5.1 变更清单的来源：以 harness 计算为准

`stage_document_draft` 写完草稿后，立即用 `worldbase_docs::parse_file` 解析草稿，与原 artifact 已有的解析结果做**节点级对比**，生成结构化 changes 并写入草稿记录（`artifact.draft` JSON）。模型自述的修改意图通过可选参数 `summary` 附带，仅作展示文案，**不作为 diff 依据**。

```ts
// 草稿记录新增字段（Rust 生成，跨端协议）
interface DocumentDraftChange {
  kind: 'insert' | 'delete' | 'modify'
  pageIndex?: number          // pdf/pptx 页号；docx/xlsx 为块序
  anchor: string              // 变更处上下文摘要（定位提示），≤60 字符
  before?: string             // 原文（delete/modify）
  after?: string              // 新文（insert/modify）
  nodeIds?: string[]          // 草稿节点树中可高亮的节点 id（复用 selection 机制）
}
```

对比算法：按 `pageIndex` 分桶后做段落级 LCS（Rust 侧实现，两端各自normalize 空白）。docx/xlsx 无页概念时 `pageIndex` 用"第 N 个块/行块"。图片占位节点（见 §7.4）纳入对比，从而能表达"图片：保留/新增/删除"。

### 5.2 UI 层次

1. **横幅摘要**（改造现有 `doc-draft-banner`）：
   `AI 修改草稿 · 共 5 处（+2 新增 / −1 删除 / ~2 修改）· 14:32 [展开]`
2. **变更列表**（横幅展开面板）：每条显示 kind 徽标 + anchor + before/after 摘要（各 ≤2 行）；点击条目滚动定位到预览中对应节点。
3. **预览内高亮**：`DocumentRenderHost` 复用现有 selection 高亮管道（节点已有 `id`/`pageIndex`，`DocumentFileTab.vue` 已有 `resolveSelectionNodeIds` 一类定位逻辑）：insert 绿、delete 红（仅对照视图可见）、modify 黄。
4. **对照视图（A2，P2）**：
   - md/text：行级 + 词级 diff（引入 jsdiff，渲染层计算，不进协议）。
   - docx/pptx/xlsx：原稿/草稿双预览并排或滑块切换；pptx 按页角标"本页 N 处修改"。

### 5.3 原则

- Diff 计算只发生一次（stage 时，Rust），渲染层纯消费；`doc.draft.get` 返回的记录自带 changes，窗口重启后仍可恢复。
- changes 数量上限（如 200 条），超出时折叠为"前 N 条 + 计数"，避免大文档撑爆横幅与协议载荷。

---

## 6. 详细设计 B：实时刷新与写入收敛

### 6.1 执行层拦截：文档直写必须走草稿

"提示词约束"不足以阻止模型直写（现状已证实），在**执行层**加守卫：

| 层 | 位置 | 行为 |
|---|---|---|
| Rust | `LocalWriteFileTool`（compat_tools.rs:2333）office_data 分支；`WriteFileTool`/`EditFileTool`（fs_tools.rs） | 写入前检查目标绝对路径是否命中 `list_documents` 中任一 artifact 的源路径（或其扩展名为 docx/pptx/xlsx 且已被导入）：命中则**拒绝执行**，返回明确错误："该文档已导入工作区，修改必须使用 doc_draft 生成草稿" |
| Electron | `tool-local-file-write.ts` 的 `writeOfficeDocument` | 同上守卫（查询 `document-store` / Rust `list_documents`），拒绝并提示改用 `doc_draft` |

- 拦截范围**只限已导入/已打开的文档**；AI 新建文档（路径不在 artifact 库中）不受限，仍可直接写。
- 工作区外用户文件（未导入）不受限——保持 `local_write_file` 的通用语义。
- `doc_write`（非 Electron 主路径）同样加守卫，与 `doc_draft` 描述里"修改用户文档必须使用本工具"对齐。

### 6.2 文件监听：覆盖一切磁盘变化

** watcher 放 Electron 主进程**（只有桌面端有"已打开文档页"概念；CLI/移动端无需）：

- 渲染层在文档页打开/关闭时通过 IPC `document:watchFile` / `document:unwatchFile` 注册路径（增量引用计数，页面关掉即取消）。
- 主进程用 `fs.watch`（macOS/Windows FSEvents/ReadDirectoryChangesW，原生即可，无需新依赖；轮询 fallback 到 mtime+size 去抖 500ms）。
- 变更事件 → `workspace:documentFileChanged { filePath, kind: 'file' }` → 文档页顶部出现非阻塞提示条：**"文件已在磁盘被修改 [重新加载] [忽略]"**。
  - 重新加载 = 现有 `refreshDocumentFromDisk(filePath)` 逻辑复用。
  - 若该文件同时有未决草稿，提示条附加说明"重新加载后，草稿应用时将以 sha 校验拒绝过期草稿"（与 `apply_document_draft` 的 `draftSourceChanged` 语义闭环）。
- watcher 事件需过滤自身：应用草稿/另存副本由本应用写盘时带上 `expected` 标记（写入方先记 pending-write，事件命中则吞掉）。

### 6.3 通知链加固

1. **失败可见**：`doc_draft` 中 `document.draftStaged` 的 `let _ =` 改为记录结果；通知失败时在工具返回值中带 `notified: false`，并在 chat 流中输出一条可见提示（"草稿已生成，请打开文档页查看"）。
2. **主动恢复**：渲染层在 **window focus** 与**会话切换**时（现仅 tab 激活，`DocumentFileTab.vue` `restorePendingDraft`）调用 `doc.draft.get` 补拉待决草稿——该 JSON-RPC 方法已存在（`method.rs:89` → `get_document_draft`，按 file_path 查询）。
3. **路由到正确窗口**：`services.ts` 的 host 请求处理按 `request.streamId`（sessionId）定位归属窗口，替代 `getActiveAiRequestWindow()` 的"当前激活窗口"猜测。

---

## 7. 详细设计 C：PPT/Word 保真编辑（保留图片与样式）

### 7.1 核心转变：草稿内容从"全文"升级为"操作列表"

`doc_draft` 新增 ops 提交格式（与全文格式并存，见 7.5 过渡策略）：

```jsonc
{
  "artifact_id": "…", "kind": "pptx",
  "ops": [
    { "op": "pptx_replace_text", "slide": 3, "paragraph": 2, "afterText": "新文案" },
    { "op": "pptx_insert_image", "slide": 3, "paragraph": 2, "image_path": "/abs/banner.png", "width_inches": 5.2 },
    { "op": "pptx_insert_slide_after", "index": 3, "title": "总结", "content": ["…"] },
    { "op": "pptx_delete_slide", "index": 7 }
  ]
}
```

docx 复用/扩展现有 `DocumentEditOperation` 语义（`apps/electron/src/shared/document-edit-types.ts`，已在 `document-edit-service.ts` 实现并验证）：

```jsonc
{ "op": "docx_replace_text", "paragraphIndex": 12, "afterText": "…" }
{ "op": "docx_insert_paragraph_after", "paragraphIndex": 12, "text": "…", "style": "paragraph" }
{ "op": "docx_delete_paragraph", "paragraphIndex": 13 }
{ "op": "docx_insert_image", "paragraphIndex": 12, "image_path": "…", "widthInches": 4 }
```

### 7.2 实现位置：Rust `worldbase_docs::edit`（手术式写入）

新增 `apply_pptx_ops(source, draft_output, ops)` / `apply_docx_ops(...)`：

1. 以 zip 读入原文件，**逐条应用 op 只改目标 XML**，其余 member 原样字节复制（media、theme、styles、rels 全保留）。
2. pptx 具体：
   - `pptx_replace_text`：定位 slideN.xml 中第 K 个 `<a:p>`，替换其 `<a:t>` 内容（保持 run 结构，清空多余 run）。
   - `pptx_insert_image`：写入 `ppt/media/edit-image-N.png` + slide rels + `<p:pic>` shape（EMU 尺寸计算复用 docx 已验证逻辑）。
   - `pptx_insert_slide_after`：复用现 `write_pptx` 的最小 slide 模板，同时维护 `presentation.xml` 的 `sldIdLst` 与 `[Content_Types].xml`。
   - `pptx_delete_slide`：从 `sldIdLst`、presentation rels、Content_Types 摘除；media 保留（引用计数清零时才删除，防共享资源误删）。
   - 写完后完整性自检：zip 可重新打开 + presentation.xml 可解析（对齐 `exportDocumentCopy` 的校验习惯）。
3. 逻辑从 Electron `document-edit-service.ts` **移植**（该文件语义已验证），Electron 侧该服务转为遗留兼容（非 Electron-host 路径不再使用）。

> **为什么放 Rust 而不是 host 回调到 Electron**：`rust-harness-architecture.md` v7 已定"文档解析与基础编辑 Rust 原生化"；host 回调会引入异步往返、断连语义和多端不一致。Rust 侧 zip/quick-xml 依赖已具备（`edit.rs` 现用 zip crate）。

### 7.3 前提：解析输出可定位的稳定索引

- `parse::pptx` 输出的 `items[].paragraphs[]` 增加 `paragraph_index`（slide 内 `<a:p>` 文档序）与 `slide`（已有 number），模型据此构造 op。
- `parse::docx` 输出增加 `paragraph_index`（`w:p` 文档序）。已有 selection 的 nodeIds 机制不受影响。
- 索引漂移规则：**ops 按提交顺序应用**，文档中明确"多个 op 时索引基于应用前一个 op 后的状态"，避免歧义。

### 7.4 解析端图片占位（让 AI 看见图片）

`parse::pptx` / `parse::docx` 为每个图片部件输出占位项：

```jsonc
{ "type": "image", "name": "image1.png", "pageIndex": 3, "paragraph": 5,
  "width_emu": 914400, "height_emu": 457200, "desc": "[图片 image1.png 4in×2in]" }
```

- 不送入模型视觉通道（成本与契约都过大），只保证**存在感**：AI 知道第 3 页有图，编辑时会主动保留或明确替换；diff 也能表达图片增删。
- Electron 端 `document-parser-pptx.ts` 同步补齐（预览 selection 定位用）。

### 7.5 dataLossRisk：过渡期兜底与最终收敛

- **P0（ops 未上线）**：`stage_document_draft` 对全文型草稿计算风险——原文件 zip 含 media/图片关系而草稿不含 → 草稿记录标记 `dataLossRisk: { mediaCount: N }`。横幅红字：**"原文件含 N 张图片，按此草稿保存将丢失全部图片"**；"应用到原文件"按钮变为需二次确认（弹层复述后果）。
- **P1（ops 稳定后）**：pptx/docx 的全文型 `blocks`/`slides` 提交**降级为拒绝**（工具 schema 返回明确错误引导改用 ops），只保留 md/text/xlsx 全文模式。属于 Rust 原生工具契约演进，符合 v7"新增 Rust 工具脱离宿主快照独立扩展"的边界。

### 7.6 保存路径保持不变

应用（覆盖原文件，sha 校验 + 备份最近 5 份）、另存副本、丢弃的现有语义（`apply_document_draft` / `save_document_draft_as` / `discard_document_draft`，`document_artifacts.rs:1304/1406/1449`）全部保留；ops 只改变**草稿文件的生成方式**，不动保存协议。

---

## 8. 数据结构与接口变更汇总

### 8.1 `doc_draft` 工具入参（Rust，`tools/src/document.rs`）

| 变更 | 说明 |
|---|---|
| + `ops: DocumentEditOp[]` | 操作列表（与 `content/blocks/slides` 互斥；同时给出时报错） |
| + `summary?: string` | 模型自述修改意图（仅展示用） |
| + `changes: DocumentDraftChange[]`（**输出**，草稿记录内） | harness 计算的节点级 diff |
| + `dataLossRisk?: { mediaCount: number }`（输出） | 全文重建导致媒体丢失时标记 |

### 8.2 JSON-RPC 方法（`protocol/src/method.rs`）

| 方法 | 变更 |
|---|---|
| `doc.draft.apply` / `saveAs` / `discard` | 不变 |
| `doc.draft.get` | 返回记录扩展 `changes`、`dataLossRisk`、`summary` |

### 8.3 Host 请求（Rust → Electron，`services.ts`）

| requestKind | 变更 |
|---|---|
| `document.draftStaged` | payload 扩展上述新字段；按 streamId 路由窗口 |

### 8.4 Electron IPC（`preload.ts` / `ipc.ts`）

| Channel | 方向 | 说明 |
|---|---|---|
| `document:watchFile` / `unwatchFile` | renderer → main | 文档页注册/注销监听路径 |
| `workspace:documentFileChanged` | main → renderer | 磁盘变化通知 `{ filePath }` |

### 8.5 渲染层（`workspace-store.ts` / `DocumentFileTab.vue`）

- `WorkspaceDocumentDraft`（`workspace-store.ts:401`）扩展 `changes?`、`dataLossRisk?`、`summary?`。
- `DocumentFileTab` 新增：变更列表面板、节点高亮注入、磁盘过期提示条、二次确认弹层、window-focus 草稿恢复。

---

## 9. 实施计划与验收标准

### P0（止血，约 1 周粒度）

| 项 | 内容 | 验收 |
|---|---|---|
| P0-1 | 执行层拦截（§6.1，Rust + Electron 双侧） | AI 对已导入文档调用 `local_write_file`/`write_file` 被拒并收到引导文案；新建文档不受影响 |
| P0-2 | dataLossRisk 检测 + 横幅红字 + 二次确认（§7.5） | 含图 pptx 走全文草稿时出现警示；无 ops 情况下用户仍可确认后保存（行为不退化） |
| P0-3 | changes 基础版（§5.1/5.2 的 1-2 层：摘要 + 列表，暂不做预览内高亮） | docx/md 草稿横幅显示"N 处（+x/−y/~z）"，列表可读 |
| P0-4 | 通知失败可见 + focus 恢复草稿（§6.3 的 1-2） | 断链场景（通知期间切走窗口）后，回到应用能通过补拉看到草稿横幅 |

### P1（根治，2-3 周粒度）

| 项 | 内容 | 验收 |
|---|---|---|
| P1-1 | Rust `apply_docx_ops`（§7.2，移植 document-edit-service 语义） | 含图/含表格 docx：改段落、插图、删段落后图片表格与样式保留；PowerPoint/WPS 可正常打开 |
| P1-2 | Rust `apply_pptx_ops`（四种 op + 完整性自检） | 含图 pptx 改文字/插图/增删页后图片全部保留；预览端图片正常渲染 |
| P1-3 | 解析端稳定索引 + 图片占位（§7.3/7.4） | parse 输出含 paragraph_index 与 image 占位；模型可据此构造合法 op |
| P1-4 | 文件监听（§6.2） | 外部 WPS 修改已打开文档 → 提示条出现 → 重新加载后内容更新；应用自身写盘不误报 |
| P1-5 | 预览内变更高亮 + 通知按会话路由（§5.2 的 3、§6.3 的 3） | 点变更条目滚动定位并高亮；多窗口下草稿横幅出现在发起会话的窗口 |

### P2（体验增强）

| 项 | 内容 |
|---|---|
| P2-1 | 对照式 diff：md/text 行内 diff；office 双预览/滑块（§5.2 的 4） |
| P2-2 | xlsx ops（单元格级操作，协议占位已预留） |
| P2-3 | pptx ops 扩展：改版式、图片替换、母级样式操作（视需求） |
| P2-4 | 全文型 pptx/docx 草稿正式拒绝（§7.5 收敛） |

依赖关系：P0 全部独立可先行；P1-1/P1-2 依赖 P1-3 的索引输出；P1-4/P1-5 相互独立。

---

## 10. 风险与边界

| 风险 | 缓解 |
|---|---|
| op 定位错位（模型给错 paragraph_index） | op 应用前校验锚文本（可选 `expectBefore` 字段，不匹配报错回给模型重试）；错误信息带上下文摘要帮助模型自纠 |
| OOXML 手术破坏文件（罕见结构） | 写后完整性自检（zip 重开 + 关键 XML 解析）失败即拒绝生成草稿；应用前已有 5 份备份兜底 |
| ops 与全文两套入口并存的模型混乱 | 工具 description 与错误信息明确分流："修改已有文档用 ops；从零生成用 blocks/slides 写新文件"；P2 收敛后消除 |
| watcher 误报（临时文件、同步盘） | 只监听已打开文档页的精确路径；pending-write 过滤；去抖 |
| diff 大文档性能 | LCS 分桶按页/块进行；changes 上限 200 条 |
| 拦截守卫误伤（用户明确想让 AI 直写文档） | 错误信息给出关闭路径的说明（先从工作区移除该文档再直写）；不做设置项，保持简单 |
| Electron `document-edit-service.ts` 双实现漂移 | P1 移植后 Electron 侧标记 deprecated 并加注释指回 Rust 实现；相关测试迁移 |

---

## 11. 测试计划

**Rust 单测**（`crates/tools` / `crates/docs`）：
- `apply_docx_ops` / `apply_pptx_ops`：含图/含表/含母版样式的样本文件，各 op 前后 member 级对比——media 字节不变、未触及 slide/paragraph XML 不变。
- ops 校验：越界索引、锚文本不匹配、混合格式 op 报错。
- changes 计算：增/删/改/移动组合、空文档、纯图片页。
- dataLossRisk：含图原文 + 纯文本草稿 → 标记；ops 草稿 → 不标记。
- 拦截守卫：已导入路径直写被拒；未导入路径放行。

**Electron 测试**（`apps/electron/tests`，沿用现有 `.test.mjs` 模式）：
- watcher：注册/注销/去抖/pending-write 过滤。
- IPC payload 兼容：`WorkspaceDocumentDraft` 新字段缺省时旧横幅仍渲染。
- 通知路由：按 sessionId 选窗。

**端到端手测清单**：
1. 含图 PPT → AI 改第 3 页文字 → 横幅显示变更 → 应用 → 重开文件图片仍在。
2. 含图 PPT → 全文草稿（过渡期）→ 红字警示 → 二次确认 → 保存后图片丢失但用户已知情。
3. docx 外部 WPS 修改 → 提示条 → 重新加载。
4. 草稿生成瞬间切走窗口 → 回到应用 → 草稿横幅恢复。
5. AI 误用 `local_write_file` 直写已导入文档 → 被拒 → 自动改用 `doc_draft`。
