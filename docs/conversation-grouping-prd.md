# 会话侧栏智能分组：按时间分栏与按项目聚合

> **状态** Draft v0.1 · **日期** 2026-10-15 · **范围** `apps/electron/src/renderer/components/chat/layout/`（侧栏及 composables）、`apps/electron/src/renderer/components/chat/panel/sidebar-state.ts`、`apps/electron/src/main/settings/chat-history.ts`、`apps/electron/src/shared/conversation-metadata.ts`

## 摘要

会话侧栏目前是「单一时间流 + 手动文件夹」：所有会话按 `updatedAt` 降序平铺，整理全靠手动建夹拖拽。会话积累后，今天的讨论和三周前的调试混在一起，同一代码项目的会话散落各处。本 PRD 定义侧栏分组体系升级——**三种可切换分组模式（时间分组 · 默认 / 项目聚合 / 手动文件夹）**、会话级项目归属字段与自动归属规则、以及与 Launchpad 项目的双向联动。

---

## § 01 现状评估：会话列表现在是怎么跑的

### 数据与存储链路（已验证）

- **数据模型**：`Conversation`（`apps/electron/src/main/settings/chat-history.ts:131-173`）含 `id / title / createdAt / updatedAt / manualTitle / authMode / providerId / selectedModel / reasoningStrength / temperature / targetProjectId / agentId / groupId / channelBindingId / documentWorkspace / folderWorkspace / workspace / fork*` 字段。**没有通用的项目归属字段**——只有 `targetProjectId`，语义是「锁定用于优化/编辑的开发项目」（写入点唯一：`conversation-navigation.ts:212-245` 的 `startOptimizationConversation`）。
- **落盘结构**：`chat-history-storage.ts:54-70`——`<userData>/conversations/catalog.json`（轻量列表行）+ `<id>.json`（全量消息）+ `metadata/<id>.json`（元数据增量 patch）。catalog 与 `list()` 均按 `updatedAt` 降序（L120/L127/L162）。
- **IPC**：`conversations:list/get/save/updateMetadata/rename/delete`（`electron/main-process/ipc.ts:906-929`）。`updateConversationMetadata` 已可承载任意白名单 patch（`shared/conversation-metadata.ts`）。
- **时间字段**：只有 `createdAt / updatedAt`，无 `lastMessageAt`；`updatedAt` 在每次保存时由 main 刷新（`chat-history-storage.ts:186`）。无任何按时间分组的现有逻辑。

### 侧栏 UI 现状（已验证）

- **挂载**：`ChatPanelContainer.vue:1109-1131` 渲染可折叠左侧栏 `ConversationSidebar.vue`，四个分区：Agent / 群组 / 长期目标 / 聊天。
- **已有能力**：搜索（⌘K，匹配 title/subtitle/searchText，`ConversationSidebar.vue:116-126`）、重命名（右键，L187-208）、删除、置顶（`useConversationSidebarFolders.ts:360-397`）、手动文件夹 + 拖拽合并建夹（L399-597）。
- **布局持久化**：置顶、文件夹、顺序键全部存 renderer localStorage key `conversation-sidebar-layout`（L11/L135-152）；分区折叠状态存 `conversation-sidebar-sections`。**会话记录本身不携带任何整理信息。**
- **过滤**：唯一过滤是归属分流（`sidebar-state.ts:286-293`，绑定了 groupId / 非默认 agentId 的会话不进聊天分区）；**没有按项目过滤，没有按时间分组**。
- **项目概念**：Launchpad 的 `Project`（`launchpad/types.ts:6-17`，含 `id / name / kind: 'project' | 'web'`），由 `window.electronAPI.listProjects()` 提供（`env.d.ts:1211`）；Launchpad 自己的文件夹分组存 localStorage，与会话无关。workspace（`workspace-store.ts`）是聊天右侧 tab 面板快照，不是项目分组概念。

### 做得好的部分 · 保留

搜索 ⌘K 与空态、置顶、拖拽合并建夹的交互、乐观更新链路（`conversation-storage.ts:97-110` 二分插入）、Agent/群组/目标的分区折叠记忆——这套骨架全部保留，本 PRD 只在「聊天」分区内部重构分组策略。

---

## § 02 核心问题诊断

### ① 无时间分段：新旧会话不可分
所有会话挤在一条 `updatedAt` 降序流里。会话超过几十条后，「今天正在聊的」和「三周前的废弃尝试」在视觉上没有边界，只能靠看副标题时间戳（`provider-utils.ts:67-87` 的 `M/D HH:mm`）逐条辨认。

### ② 无项目聚合：同一项目的会话散落
围绕一个代码项目的工作（优化会话、关联讨论）无法归拢。`targetProjectId` 理论上是现成的关联锚点，但它只覆盖从项目「优化」入口创建的极少数会话，且语义是「锁定编辑目标」而非「会话归属」——会话进行中打开 project tab、发送 `[[project:id|name]]` 引用这些强项目信号全部没有沉淀。

### ③ 手动整理成本高且随使用衰减
文件夹需要手动创建、手动拖入；而新会话永远落在顶层时间流。用户的整理成果随日常使用不断被冲刷，最终放弃整理。

### ④ 整理信息不入库：不可被其他入口消费
置顶/文件夹只存 localStorage——多窗口不一致、重装即丢；更关键的是会话记录不知道自己属于哪个项目，导致 Launchpad、搜索、导出、统计等任何「按项目看会话」的入口都无从做起。

### ⑤ 打开项目与会话列表零联动
打开一个项目既不过滤侧栏，也不提供「这个项目最近聊了什么 / 继续上次对话」的路径；从会话侧也回不到项目。

---

## § 03 目标与非目标

### 目标

- 会话列表默认**按时间分段**（今天 / 昨天 / 近 7 天 / 近 30 天 / 更早），新旧一眼可分。
- 提供**按项目聚合视图**：同一代码项目的会话自动归拢，未归属会话与项目已删除的会话有明确兜底分组。
- 会话的项目归属**入库**（catalog + metadata patch），自动归属为主、手动调整为辅。
- 保留现有手动文件夹能力，三种分组模式可切换、偏好记忆。
- Launchpad 与侧栏**双向联动**：从项目看会话、从项目组建会话。

### 非目标（本周期不做）

- 不做跨项目归属（一个会话最多归属一个项目）。
- 不动会话存储结构与 IPC 通道（catalog.json 双层结构、既有通道保持，仅新增字段）。
- 不做消息内容全文搜索（现有搜索范围维持标题/副标题）。
- 不把 Rust 侧定时任务会话（harness SQLite `[定时]` 前缀）接入 Electron 侧栏（已有任务报告入口，见开放问题）。
- 不做标签体系和多级嵌套文件夹。

---

## § 04 产品需求

七项需求。P0 构成「时间分段 + 项目聚合」的最小可用集。

### R1 · 时间分组视图（默认模式）`P0`

- **用户故事**：作为用户，我打开侧栏就能区分「今天在聊的」和「更早的」，不必在长列表里逐条看时间戳。
- **验收标准**：
  - 分组桶：**今天 / 昨天 / 近 7 天 / 近 30 天 / 更早**，按 `updatedAt` 以本地时区自然日切分；空桶不渲染。
  - 桶内仍按 `updatedAt` 降序；置顶会话不受分组影响，始终以「置顶」区置于聊天分区最前（现状行为）。
  - 桶头显示组名 + 数量，可折叠；折叠状态持久化（并入现有 `conversation-sidebar-layout` 结构）。
  - 搜索时拍平所有桶按现有过滤逻辑展示（沿用 `isSearching` 行为）。
  - 时间分桶为纯函数，`now` 可注入（便于测试与跨午夜边界用例）。

### R2 · 会话项目归属字段 `P0`

- **用户故事**：作为系统，每条会话应知道自己属于哪个代码项目，项目聚合与后续一切按项目消费才有数据基础。
- **验收标准**：
  - `Conversation` / `ConversationListEntry` / `ConversationSummary` / `ConversationMetadataPatch` 新增 `projectId: string | null`，语义为「会话归属的 Launchpad 项目 id」。
  - **兼容迁移**：存量 `targetProjectId` 会话在读取与列表时映射为 `projectId`；`targetProjectId` 字段保留不删（优化链路继续使用）；新归属写入一律走 `projectId`。
  - **项目删除不级联**：删除 Launchpad 项目不删除其会话；解析不到项目时归入「已删除项目」兜底组，组内会话可手动移出或重新归属（R4）。
  - 无需新增 IPC 通道：`updateConversationMetadata` / `saveConversation` 已承载 metadata patch。

### R3 · 项目聚合视图 `P0`

- **用户故事**：作为用户，我在处理 the-world 项目时，希望侧栏能展开「这个项目的所有会话」，而不是在全局流里回忆和翻找。
- **验收标准**：
  - 聊天分区头部提供分组模式切换器：**时间（默认）/ 项目 / 文件夹** 三态；选择持久化记忆。
  - 项目组按「项目内最近活跃会话的 `updatedAt`」降序排列；组头 = 项目 icon + 名称 + 会话数，可折叠；组内按 `updatedAt` 降序。
  - **自动归属写入时机**（会话当前无归属时，满足其一即写入，走 metadata patch 乐观更新）：
    a. 从项目「优化」入口创建会话（现 `targetProjectId` 写入点，`conversation-navigation.ts:212-245`，同步写 `projectId`）；
    b. 会话进行中用户打开了该项目的 project tab 并发送了新消息；
    c. 消息正文包含该项目的 `[[project:id|name]]` 引用；
    d. 手动指定（R4）。
  - **归属一次定型**：已有归属的会话不被后续弱信号自动改写，仅可手动更改。
  - 无归属会话归入「未分组」组，置于全部项目组之后；已删除项目组置于「未分组」之后。
  - 项目组头 hover 出「新建会话」按钮：新建会话自动携带该项目归属，并关联到当前项目上下文。
  - 项目元信息（名称/icon）运行时经 `listProjects()` 动态解析，不冗余快照——项目改名零成本；`kind: 'web'` 的快捷方式不参与聚合。

### R4 · 手动归属与拖拽 `P1`

- **用户故事**：作为用户，自动归属判断错的会话，我能手动改；项目视图下我能像文件夹模式一样拖拽整理。
- **验收标准**：
  - 会话右键菜单新增「移动到项目…」：弹项目选择器（复用 Launchpad 项目列表 + 搜索框），支持「移出项目」（清除归属）。
  - 项目分组模式下启用拖拽：会话拖入项目组 = 归属该项目；拖至「未分组」= 清除归属。复用 `useConversationSidebarFolders` 现有 HTML5 拖拽事件链，按模式启用/禁用。
  - 手动归属立即写 `updateConversationMetadata` patch，侧栏乐观更新，失败回滚。

### R5 · Launchpad 双向联动 `P1`

- **用户故事**：作为用户，我在 Launchpad 看到项目气泡时，应能直接进入「这个项目的会话」，也能从项目组回到项目本身。
- **验收标准**：
  - Launchpad 项目气泡右键菜单新增「查看会话」：切聊天分区到项目模式、展开并高亮该项目组（其他项目组可折叠）。
  - 项目分组模式下，当前打开会话所属的项目组默认展开。
  - 项目组头提供「打开项目」快捷入口，与现有 `ProjectAppWorkspaceTab` 打开路径一致。
  - （P2 可选）项目气泡显示活跃会话计数角标。

### R6 · 手动文件夹模式保留与共存 `P1`

- **用户故事**：作为已经建好文件夹的老用户，我的整理成果不能因为新功能上线而丢失。
- **验收标准**：
  - 现有文件夹/置顶/拖拽排序能力原样保留为「文件夹」模式，localStorage 布局数据结构不变（仅新增 `groupingMode` 字段，向后兼容读取）。
  - 置顶跨模式共享：任一模式下置顶会话都在最前。
  - 切到时间/项目模式时文件夹数据不渲染但**不删除**；切回文件夹模式完整恢复。

### R7 · 智能归属建议 `P2`

- **用户故事**：作为用户，我希望系统在我聊到某个项目时提醒我「要不要归到它名下」，而不是默默猜。
- **验收标准**：
  - 对无归属会话，基于消息中的文件路径命中项目根目录、或 `@project` 引用，在会话行展示一次性建议 chip「归属到〈项目名〉？」。
  - 点击确认写入归属；忽略则本会话不再提示；不自动写。

---

## § 05 关键交互示意

分组模式切换器位于「聊天」分区头，替换现有「新建文件夹」按钮位（新建文件夹入口移入文件夹模式常驻）：

```
┌ 聊天 ──────────────────── [🕐|📁|🗂] ─┐   ← 模式切换：时间 / 项目 / 文件夹
│ 📌 置顶                                │
│   · 修复登录超时            14:32      │
│ 今天 (5)                        ▾     │
│   · 接入 Rust harness      13:10      │
│   · 讨论分组 PRD           09:47      │
│ 昨天 (3)                        ▸     │   ← 折叠桶
│ 近 7 天 (12)                    ▸     │
│ 更早 (48)                       ▸     │
└───────────────────────────────────────┘

项目模式：
┌ 聊天 ──────────────────── [🕐|📁|🗂] ─┐
│ 📌 置顶 …                              │
│ ▾ the-world  (8)      [＋] [打开项目] │
│   · 接入 Rust harness      13:10      │
│   · 优化会话 …                        │
│ ▾ app-old  (3)                  ▸     │
│ ▸ 已删除项目 (5)                ▸     │   ← 兜底组，可移出/重新归属
│ 未分组 (21)                      ▸     │   ← 无归属会话
└───────────────────────────────────────┘
```

---

## 技术方案要点

- **分组收口**：`panel/sidebar-state.ts` 在 `conversationSidebarItems` 之上新增纯函数 `groupConversationEntries(items, mode, ctx)`，统一返回 entry 树（`pinned / time-bucket / project-group / folder / conversation`）。`useConversationSidebarFolders` 现有逻辑退化为 `mode === 'folders'` 的策略实现；拖拽事件链按模式启用/禁用，组件层（`ConversationSidebar.vue`）只消费 entry 树。
- **乐观更新兼容**：`applySummary` 的二分插入按全局 `updatedAt` 排序（`conversation-storage.ts:97-110`），分组视图下乐观行仍需正确落桶——分组纯函数必须容忍乱序输入，不依赖上游有序。
- **归属写入**：`conversation-storage.ts` 的 `currentMetadata()` / `saveConversationNow` 增加 `projectId` 透传；新增 `assignConversationProject(id, projectId | null)` 与 `setConversationTarget` 并列。列表读取侧（`chat-history.ts` 的 `list()`）做 `targetProjectId → projectId` 映射。
- **项目解析**：侧栏通过 `window.electronAPI.listProjects()` 建立内存索引（Launchpad.vue 目前本地持有 `projects` ref，不共享——侧栏自行拉取即可，IPC 轻量）；解析失败 → 已删除项目组。
- **i18n**（`zh-CN` / `en-US`）：`chatUi.groupToday / groupYesterday / groupLast7Days / groupLast30Days / groupOlder / groupUngrouped / groupDeletedProjects / groupingModeTime / groupingModeProject / groupingModeFolders / moveToProject / removeFromProject / newConversationInProject / openProject` 等。

---

## § 0X i18n

| key | zh-CN | en-US |
|---|---|---|
| `chatUi.groupingModeTime` | 按时间 | By time |
| `chatUi.groupingModeProject` | 按项目 | By project |
| `chatUi.groupingModeFolders` | 文件夹 | Folders |
| `chatUi.groupToday` | 今天 | Today |
| `chatUi.groupYesterday` | 昨天 | Yesterday |
| `chatUi.groupLast7Days` | 近 7 天 | Previous 7 days |
| `chatUi.groupLast30Days` | 近 30 天 | Previous 30 days |
| `chatUi.groupOlder` | 更早 | Earlier |
| `chatUi.groupUngrouped` | 未分组 | Ungrouped |
| `chatUi.groupDeletedProjects` | 已删除项目 | Deleted projects |
| `chatUi.moveToProject` | 移动到项目… | Move to project… |
| `chatUi.removeFromProject` | 移出项目 | Remove from project |
| `chatUi.newConversationInProject` | 在此项目中新建会话 | New conversation in project |
| `chatUi.openProject` | 打开项目 | Open project |
| `chatUi.viewProjectConversations` | 查看会话 | View conversations |

---

## 分阶段路线图

### Phase 1 · P0 —— 时间分段与项目聚合最小集
R1（时间分组）+ R2（归属字段与迁移）+ R3（项目聚合视图与模式切换框架）。含 R6 的数据兼容部分（localStorage 结构向后兼容）。

### Phase 2 · P1 —— 手动整理与联动
R4（手动归属与拖拽）+ R5（Launchpad 联动）+ R6（文件夹模式完整共存）。

### Phase 3 · P2 —— 智能建议与可选增强
R7（归属建议 chip）、Launchpad 会话计数角标、（视开放问题结论）布局持久化升级。

### 需求矩阵

| 需求 | 内容 | 优先级 | Phase |
|---|---|---|---|
| R1 | 时间分组视图（默认） | P0 | 1 |
| R2 | 会话项目归属字段与迁移 | P0 | 1 |
| R3 | 项目聚合视图与自动归属 | P0 | 1 |
| R4 | 手动归属与拖拽 | P1 | 2 |
| R5 | Launchpad 双向联动 | P1 | 2 |
| R6 | 文件夹模式保留与共存 | P1 | 1-2 |
| R7 | 智能归属建议 | P2 | 3 |

---

## 风险与开放问题

### 风险

- **`targetProjectId` 双字段过渡期**：优化入口、`@project` 引用、消息分支（fork）三条链路都触碰项目字段，迁移回归需覆盖「旧会话打开 → 继续对话 → 再保存」路径，避免归属丢失或写回旧字段。
- **乐观更新与分组的一致性**：`pendingSummaries` 机制（`conversation-storage.ts:92-205`）在 catalog 确认前保留未确认行，分组函数必须把 pending 行也算进桶与计数，否则新会话「闪没」。
- **性能**：catalog 全量载入、每次 `updatedAt` 变化触发全列表重排；三重分组重算需 memo（按 items 引用缓存），>1000 会话时避免逐帧重算。虚拟滚动不在本期。
- **localStorage 结构迁移**：`conversation-sidebar-layout` 老数据（folders/pinnedIds/顺序键）必须无损读取；建议新增 `version` 字段。

### 开放问题

- 布局/偏好是否从 localStorage 升级到 main 进程 settings store（多窗口一致、随数据目录备份迁移）？本 PRD 先沿用 localStorage，升级另立 PRD。
- 「未分组」会话大量堆积时，是否需要批量归属工具（多选 → 批量移动到项目）？
- Rust 定时任务会话（harness SQLite，`[定时]` 前缀）是否以只读「定时任务」组接入侧栏？还是继续走任务报告入口？
- 时间分组粒度是否需要用户可配（如「按周」）？默认固定五档。
- 项目组是否需要支持按 Launchpad 文件夹做二级分组（项目很多时）？
