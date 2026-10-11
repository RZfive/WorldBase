# Excel / PPT 预览复原方案（通用：支持任意软件产出的 xlsx / pptx）

## 根因（为什么 Word/PDF 能复原而 Excel/PPT 不能）

1. **预览策略不对称**（`apps/electron/src/main/document-preview/document-render-service.ts:95-147`）：pdf 的预览资产就是原文件；docx 由 mammoth 生成 HTML 并落盘缓存到 `document-render-cache/<sha1(path:size:mtime)>/`，重启后缓存命中秒开；**xlsx/pptx 只返回 `structured`（纯内存节点），没有任何落盘资产**，重启后无可复原之物。
2. **xlsx/pptx 本来就没有真正的渲染器**：即使当场打开，xlsx 只是丢样式的朴素表格（丢填充色/合并单元格/边框等），pptx 只有文本大纲（`document-parser-pptx.ts` 只抽 `<a:t>` 文本），完全不像幻灯片——用户感知即"不复原"。
3. **恢复是懒加载**：新 `WorkspacePanel.vue` 只挂载激活的 tab，`DocumentFileTab.vue` 仅在 `onActivated` 时才 re-import（被删掉的旧 `DocumentWorkspace.vue` 是对全部文档 eager 重导入）；非激活 tab 一直停在占位/报错卡片。
4. **Rust 侧同样卡死**：`harness-rs/crates/core/src/dispatcher.rs` 的 `doc_preview_ensure` 只为 docx 向 Electron 宿主要 HTML 渲染，xlsx/pptx 永远落到本地 `structured` 分支（`document_artifacts.rs` 矩阵）。而宿主处理器 `electron/main-process/services.ts:466-477` 本身是通用的，改 TS 侧即可自动受益。

## 方案（4 部分）

### 1. Excel 通用 HTML 预览生成器（主进程）

新增 `src/main/document-preview/excel-html-preview.ts`，ExcelJS（现有依赖）读取，**完全仿 docx 模式**：

- 还原范围（覆盖各软件产出的标准 xlsx）：多 sheet + CSS-only 切换页签（radio+label，无需 JS，可穿过渲染端 sanitizer）；合并单元格（rowspan/colspan，来自 `worksheet.model.merges`）；列宽/行高；字体（粗体/斜体/下划线/删除线/颜色/字号/字体名，含 richText 分段）；填充色（argb + theme 色解析为 RGB）；对齐/自动换行；边框；数字格式与公式显示缓存结果（用 `cell.text`）。HTML 转义全部单元格文本。
- 降级：图表/图片/切片器/条件格式不渲染（数据完整）；行列上限（如 10000×256）截断并提示。
- 输出自包含 HTML（body 内嵌 `<style>`，所有规则收拢在唯一前缀根类下防止污染全局），落盘缓存复用 `buildCacheKey`/`getRenderCacheRoot`，命中即返回。
- `buildDocumentRenderPreview` 的 xlsx 分支改为：try → `{kind:'html', mimeType:'text/html; charset=utf-8', assetPath}`，catch → 现有 structured fallback（与 docx 完全同构）。渲染端零改动（`DocumentRenderHost` 已支持 kind=html）。

### 2. PPT 通用幻灯片渲染器（主进程，自研纯 JS，按 OOXML 规范解析）

新增 `src/main/document-preview/pptx-html-preview.ts`（可拆解析/渲染子模块），JSZip + @xmldom/xmldom（均为现有依赖）。**为任意软件（Office/WPS/LibreOffice/Keynote 导出）产出的 pptx 设计**，含真实世界幻灯片必需的构造：

- 画布与顺序：`presentation.xml` 的 `p:sldSz` 实际比例（16:9、4:3…）；幻灯片按 `p:sldIdLst` + rels 排序（非文件名排序）。
- **占位符继承链**（普适还原的关键，真实 PPT 的定位/字号大多在母版里）：slide → slideLayout → slideMaster 逐级解析占位符几何与默认样式。
- **主题色**：解析 `theme1.xml` clrScheme，`schemeClr`（含 lumMod/lumOff/tint/shade 计算）→ 实际 RGB。
- 形状与文本：`p:sp`（preset geometry 填充/边框）、`p:grpSp` 组合形状递归（chOff/chExt 组变换）、文本 run 的字号/粗斜/下划线/颜色/字体/行距/对齐/项目符号。
- 图片：slide rels → `ppt/media/*` → base64 data URL 内联（自包含、离线可复原）。
- 表格：`a:tbl` → HTML 表格（合并/样式）。
- 降级阶梯：图表/SmartArt/OLE/视频 → 带标题文字的占位框；未知元素跳过。
- 布局：每页一个等比幻灯片画布，用 CSS container query 单位（cqw）做**纯 CSS 等比缩放**（无 JS；sanitizer 只删 script/iframe 等，body 内 `<style>` 保留，`data:` 图片保留）；纵向滚动 + 页码标注。
- 同样落盘缓存 + structured fallback。

### 3. 恢复链路加固（直接解决"换会话/重启后不复原"）

- `workspace/workspace-store.ts`：`applyWorkspaceState` 之后新增 `prefetchWorkspaceDocumentTabs()`——对全部文档 tab 按规范化路径去重，依次 `importDocument`（store 缺失时）+ `ensureRenderPreview`，失败静默（tab 激活时再展示错误）。恢复旧 `DocumentWorkspace` 的 eager 行为；有了落盘 HTML 缓存后，二次复原为缓存秒开，且不再依赖当场重新解析成功。
- 小优化：`DocumentHtmlPreview.vue` 对生成的根节点 `data-preview-kind="slides"` 放宽 860px 页面内边距，让幻灯片铺得更宽（其余不动）。

### 4. Rust 侧对齐

- `dispatcher.rs` `doc_preview_ensure`：宿主路由条件由 `docx|doc` 扩为 `docx|doc|xlsx|xls|pptx|ppt`；"ready 短路"条件改为「ready 且 kind 非 structured 且资产可读」（旧 structured 记录能被升级为 HTML）。宿主返回 structured 时 `persist_host_render_preview` 已优雅回退本地矩阵，无需改动。
- `services.ts:470` 的类型归一化补 `xls→xlsx`、`ppt→pptx`（与 TS 侧一致）。
- `electron-tool-contracts.json` 不涉及（无工具契约变更）。

## 兜底

任何解析失败 → structured 节点视图（现状）+ 明确错误文案；旧二进制 `.xls/.ppt` 依旧不支持预览（给出"请另存为新格式"提示），后续版本可评估 LibreOffice 桥接作为可选增强档。

## 测试

- 新增 `apps/electron/tests/document-html-preview.test.mjs`（node --test + register-ts-hooks，同现有模式）：
  - ExcelJS/officegen 生成基础文件断言（kind=html、缓存命中二次不重写、合并单元格/填充色 `4472C4`/粗体/数字格式）；
  - **仓库内置真实软件产出的 fixture**（小体积：含主题色、母版占位符、组合形状、图片、表格、图表），断言主题色解析为具体 RGB、占位符几何来自母版、图片为 data URL、图表降级为占位框。
- 跑 `pnpm typecheck`；`test:harness-tool-contracts` 应保持通过。

## 实施顺序

1. Excel HTML 生成器 + 分支接入 + 单测（先见效）
2. PPT 渲染器（解析器 → 继承链/主题色 → 渲染/缩放 → 缓存）+ fixture 单测
3. 恢复预取 `prefetchWorkspaceDocumentTabs`
4. Rust dispatcher 对齐 + services.ts 归一化 + zh-CN/en-US 文案
5. 手动验证：本应用生成的文件 + 外部软件文件 ×（重启 / 换会话 / 非激活 tab）三场景

## 涉及文件

- 新增：`src/main/document-preview/excel-html-preview.ts`、`pptx-html-preview.ts`（+可能的 pptx 解析子模块）、`tests/document-html-preview.test.mjs`、fixture 文件
- 修改：`document-render-service.ts`、`workspace/workspace-store.ts`、`chat/blocks/DocumentHtmlPreview.vue`（小）、`electron/main-process/services.ts`、`harness-rs/crates/core/src/dispatcher.rs`、`src/locales/{zh-CN,en-US}/index.ts`