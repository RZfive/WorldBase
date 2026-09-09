# 消息级分支与编辑重发：让每条用户输入都可以「改主意」

> **状态** Draft v0.3 · **日期** 2026-08-15 · **范围** `apps/electron/src/renderer/components/chat/**`、`apps/electron/src/main/settings/chat-history.ts`、`apps/electron/electron/main-process/ipc.ts`（conversations:* IPC）

## 摘要

当前对话是**线性不可变的单轨记录**--用户发出去的消息无法修改、无法从中间某条重开岔路，长对话里也难以快速回看「自己当时问了什么」。本 PRD 定义四个核心能力：**Fork（从任意一条用户消息分叉出新对话，并持久记录谱系）**、**Edit & Resend（编辑任意已发送的用户消息并重新生成后续回复）**、**用户消息小地图（右侧定位导航条）**、以及建立在谱系之上的**对话树脑图（可视化全部分支、从任意节点继续深化）**。数据模型上以**稳定消息 ID** 为地基。

---

## § 01 现状评估：为什么现在做不到

### 数据与链路（已验证）

- **消息没有身份**：`ChatMessage`（`apps/electron/src/renderer/components/chat/types.ts:79` / `apps/electron/src/main/settings/chat-history.ts:78`）只有 `role/content/blocks` 等字段，**没有稳定 id**。渲染层全部用数组下标引用消息--`MessageRow` 接收 `index`，`latestAssistantMessageIndex`、`getLatestVisibleTodoItems(messages, ...)`、lightbox 的 `messageIndex/blockIndex/partIndex` 全是下标寻址。
- **会话整包持久化**：`conversations:save` IPC 把整个 `Conversation`（含全部 messages）序列化写盘（`apps/electron/src/main/settings/chat-history.ts`）。没有消息级增量更新，也没有任何分支概念。
- **每轮全量重发**：`apps/electron/src/renderer/components/chat/panel/message-sender.ts` 发送时把当前 `messages` 数组整体构建为 outgoing messages 传给 `ai:chatStream`。**这实际上意味着「编辑重发」在协议层是天然可行的**--截断 + 替换 + 重发即可，不需要任何服务端配合。
- **用户消息可能带附件**：`pendingImages/pendingFiles` 在发送时注入消息（`attachment` block / `image_url` parts），重发时需要能从历史消息还原这些附件。
- **会话元数据已有继承先例**：`Conversation` 已携带 `providerId/selectedModel/reasoningStrength/temperature/targetProjectId/agentId/groupId` 等上下文，`newConversation` 时逐字段复制--Fork 复用同一套机制。

### 做得好的部分 · 保留

线性数组 + 整包存储简单可靠；全量重发的对话协议让「重来一次」不需要复杂的消息级 API；`Conversation` 元数据模型已经足够表达「新会话继承旧配置」。

---

## § 02 核心问题诊断

### ① 无消息身份 → 一切下标寻址都是脆弱的
插入、删除、截断任何一条消息都会让所有下标引用漂移。要做分支/编辑，第一步必须是给消息稳定 id，否则 fork 点、编辑点都无法可靠定位。

### ② 无分支模型 → 「试另一种问法」的成本是整段重述
用户在长对话里想改第 3 条提问，今天唯一的选择是开新会话并把之前的上下文重新粘贴一遍。分支（fork）是 LLM 对话产品的标准答案（ChatGPT / Claude.ai 均有），缺失它等于缺失「探索式使用」的基本姿势。

### ③ 编辑即破坏 → 没有「可后悔」的重发
即使做了截断重发，若直接在当前会话上销毁后续消息，用户的原路径就丢了。需要明确「原地重发（破坏性）」与「分叉重发（保全性）」两种语义，且默认值必须是安全的。

### ④ 流式与异步状态会打架
`streamingConversationIds`、`activeStreamSessionIds`、后台群组会话（`activeGroupSessionIds`）、pending auth/sudo/ask-user 请求都挂在 conversationId 上。fork 出的新会话绝不能继承这些**运行时态**，只继承**内容态**。

### ⑤ 附属内容的重发语义不明确
附件 block、图片 parts、auth_request 块、群组转写块--哪些跟随 fork 复制、哪些重发时重建、哪些必须作废，需要逐类定义。

---

## § 03 目标与非目标

### 目标

1. 每条**用户消息**提供 hover 操作：**编辑**、**从此分叉（Fork）**、复制原文。
2. 编辑后可选择**原地重发**（截断后续）或**分叉重发**（保留原对话，新开会话重跑）。
3. Fork 生成的新会话完整继承上下文与全部配置（模型、agent、项目绑定、工作区状态），并在 UI 上标明谱系。
4. 消息获得稳定 id，为后续消息级功能（单条重生成、引用回复、消息搜索定位）打地基。

### 非目标（本周期不做）

- **不做同屏树状分支切换**（单会话内多分支来回切、分支对比视图）。谱系树以「会话为单位」在脑图视图（R8）中呈现，不在单会话视图内做树 UI。
- **不做 assistant 消息的编辑与重生成**（「重新生成」按钮是另一个需求，可复用本 PRD 的地基但不在本期范围）。
- **不支持群组对话（groupId）的编辑重发**--群组会话由 `group-session` 运行时驱动，多 agent 状态无法简单截断重放；Fork（只读复制前缀）群组会话支持，编辑重发不支持。
- 不做服务端/agent 侧的分支感知--agent 记忆、长期目标记录不回滚。

---

## § 04 数据模型改造 `P0`（前置）

### R1 · 消息稳定 ID

`ChatMessage` 增加 `id?: string`（renderer 与 `chat-history.ts` 双侧同步）：

- 生成时机：用户消息在 `sendMessage` 构建时生成（`msg_` + uuid）；assistant 消息在流开始占位时生成。
- **可选渐进**：旧会话无 id 不迁移、不报错；所有新写入路径带 id。分支/编辑功能只对「有 id 的用户消息」开放，旧消息降级为仅「复制」可用。
- 写入侧唯一改动点：`message-sender.ts`（用户消息 + assistant 占位）。
- 读取侧不强制依赖 id 渲染（渲染继续用下标），但**分支/编辑的锚点必须用 id 解析下标**，杜绝截断后漂移。

### R2 · 会话谱系元数据（完整链路，非单点指针） `P0`

分叉必须**持久记录原有对话的完整谱系**，这是后续脑图视图与「从任意分支继续深化」的数据前提。`Conversation` 增加：

```ts
/** 直接父会话 id（fork / 编辑分叉时写入；自然新建的会话无此字段） */
forkedFromConversationId?: string
/** 分叉锚点：父会话中被复制前缀的最后一条消息 id */
forkedFromMessageId?: string
/** 谱系树根会话 id（首个分叉点写入并一路透传，同一棵树的会话共享） */
rootConversationId?: string
/** 树深度：根为 0，每分叉一层 +1（用于脑图层级布局与排序） */
forkDepth?: number
/** 分叉时间，用于同层级排序 */
forkedAt?: string
```

**设计要点**：

- **只存边，不存树**：`forkChildrenIds` 之类的子节点列表**不落盘**--子会话列表在加载会话列表时按 `forkedFromConversationId` 一次性扫描构建（内存索引）。避免「删父会话/删子会话」时的双向写维护。
- **删父不塌树**：删除被引用的父会话时，其子会话的 `forkedFromConversationId` 保留（指向已不存在的 id），谱系图渲染时该边断为「祖先已删除」占位节点，`rootConversationId` 保证树不散架。
- 侧栏列表在分叉会话标题旁显示 `⑂` 徽标（hover 显示「分叉自：{源会话标题}」，源会话侧显示 `{n} 条分支」），点徽标可直接跳转谱系图（R8）并高亮该节点。

---

## § 05 产品需求

### R3 · 从任意用户消息 Fork 新对话 `P0`

**交互**：用户消息 hover 工具条（与现有 assistant 消息操作位对齐）出现「⑂ 从此分叉」；点击即创建新会话。

**语义**：

1. 复制**该用户消息（含）之前**的全部消息到新会话；该条用户消息本身**作为新会话最后一条消息**，不自动触发发送（用户可以立刻输入新内容，也可以直接改这条）。
2. 新会话继承源会话全部 `Conversation` 元数据（provider/model/reasoning/temperature/authMode/targetProjectId/agentId/channelBinding/文档与文件夹工作区状态），写入 R2 谱系字段。
3. **不继承**任何运行时态：流式状态、pending auth/sudo/ask-user、群组 session、unread 标记。
4. 标题规则：`{源标题} · 分叉`，`manualTitle` 置 true 防止自动改题覆盖。
5. 源会话不动一个字节（真正的 copy-on-write：只有用户在新会话里继续操作才写新文件）。

**限制**：流式进行中（`isLoading` / 属于 `streamingConversationIds`）禁用 fork 按钮；群组会话允许 fork（只读复制）。

### R4 · 编辑已发送的用户消息并重发 `P0`

**交互**：

1. 用户消息 hover 工具条出现「✎ 编辑」；点击进入**行内编辑态**（原消息位置展开 textarea，预填原文，附件以 chip 形式展示可增删）。
2. 保存时弹出二选一（或设置里固定默认值）：
   - **分叉重发（默认，安全）**：等价于「fork 到此消息 + 应用编辑 + 立即发送」，源会话完整保留。
   - **原地重发（破坏性，需二次确认）**：当前会话截断掉该消息（含）之后的所有内容，替换为编辑后内容，立即重新发送。
3. 编辑态支持 Esc 取消；原地重发的确认弹窗明示「将删除此后 N 条消息（含 M 次工具运行结果），不可恢复」。

**语义细节**：

- **附件还原**：编辑时从原消息的 `attachment` blocks / `image_url` parts 还原 `pendingImages/pendingFiles` 等价物，重发走与首 send 完全相同的构建管线（复用 `createChatAttachmentState`），不另造旁路。
- **截断原子性**：原地重发 = 一次 `conversations:save`（截断后数组），先持久化再触发流，失败恢复原数组（内存快照回滚）。
- **锚点解析**：以消息 id 查找下标后校验 `role === 'user'`，找不到（理论不该发生）则禁用操作并静默降级。

### R5 · 复制消息原文 `P2`

用户与 assistant 消息 hover 均提供「复制」，纯文本取 `getContentText`。作为工具条的伴随能力在此一并定义。

### R6 · 分支内容过滤规则 `P0`

Fork / 截断复制时对 block 逐类处理：

| Block 类型 | 复制到新会话 | 说明 |
|---|---|---|
| content / thinking / todo / tool / attachment / web_search / web_fetch / file_preview | ✅ 原样 | 构成上下文 |
| error | ✅ 原样 | 历史事实 |
| auth_request / sudo_password_request | ❌ 丢弃 | 一次性交互态，跨会话无效 |
| group_* 全族 / agent_sidechat | 仅群组会话 fork 保留 | 单聊会话本就不含；群组 fork 原样保留供回看 |
| `image_url` parts（多模态 content 内） | ✅ 原样（data URL 自包含） | 远程 URL 同样透传 |

### R7 · 运行时护栏 `P0`

- 任何 fork/编辑入口在 `streamingConversationIds.has(currentConversationId)` 时禁用（含群组）。
- fork 目标若为群组会话：新会话是**普通会话**（不再挂 groupId），群组内容作为历史只读存在；侧栏正常展示。首版可在 fork 群组时弹提示说明「分叉后为普通对话」。
- 后台会话（`backgroundStreamMessages` 里的非当前会话）不受影响--fork 永远从**已持久化的消息快照**复制，不读共享 live 数组。

### R8 · 对话树脑图与继续深化 `P1`

谱系记录的目的地：把「一棵对话树」显性化，让用户看到自己探索过的所有岔路，并**从任意节点继续深化**。

**数据与视图**：

1. **谱系图入口**：侧栏会话的 `⑂` 徽标、会话详情菜单、以及顶部「对话树」按钮。每次打开基于当前会话列表实时构建（无缓存失效问题）。
2. **节点与边**：节点 = 会话（根节点 = `rootConversationId` 指向的会话或无谱系的独立会话），边 = `forkedFromConversationId`。节点显示标题、模型/agent 图标、最后活动时间、消息数；边上标注**分叉锚点的用户消息摘要**（取 `forkedFromMessageId` 对应消息的前 ~30 字符），让用户记得「当时是从哪个问题岔出去的」。
3. **布局**：默认树形（根在上，按 `forkDepth` 分层，同层按 `forkedAt`/`updatedAt` 排序）；支持折叠子树、缩放与拖拽平移。多棵独立的树（各自 root）并排为森林。
4. **多根归一**：无谱系的普通会话各自是一棵单节点树；提供「按 rootConversationId 聚合」与「仅显示当前树」两种过滤。

**节点操作（= 继续深化）**：

- **打开**：进入该会话正常对话。
- **从此深化**：在该节点上直接发起一次 fork（复用 R3 管线，锚点默认为该会话最后一条用户消息），新分支立即出现在树上--脑图本身就是一个持续分叉的工作台。
- **重命名 / 删除**：删除节点按现有删除会话语义执行；子树保留（谱系边按 R2 规则断为占位）。
- **高亮定位**：从侧栏徽标跳入时，目标节点高亮并自动展开其祖先链。

**技术要点**：纯渲染层功能--数据全部来自已加载的 `conversations` 列表 + 按需 `conversations:get`（取分叉锚点消息摘要）。建议自绘 SVG 树（现有 mermaid 预览已有 SVG 基础设施可参考），不引入图库依赖。

**与 Phase 划分的关系**：R8 依赖 R2 的完整链路字段，排在 P1；但 R2 的字段结构在本期（P0）就按 R8 的需要定死，避免二次迁移。

### R9 · 用户消息小地图（左侧定位导航条） `P1`

长对话里「用户当时问了什么、问到哪了」是最高频的定位诉求。在消息列表右侧加一条**细长的小地图（minimap）**：用户消息是刻度点，整条对话的纵向全貌一屏可见，点击即跳。

**视觉与位置**：

1. 一条 ~70px 宽的**内容剪影式小地图**，贴住消息列表**最右缘**（`MessageList` 外壳内绝对定位）；小地图出现时**隐藏原生滚动条**并由小地图接管滚动交互，消息内容区右移留出空间；窄屏 < 860px 隐藏。
2. **剪影 = 按真实比例缩小的消息形状**：每条消息一个元素，高度按 `messageExtent / totalContentHeight` 映射，内部用重复渐变画出「文本行」纹理；用户消息用强调色、右对齐窄条（对应气泡位置），assistant 消息灰色、占更宽--整段对话的形状一眼可读，长回复后的问题自然下沉。
3. **整条表面即可点可拖**：按下任意位置立即跳到该处，按住拖动即**连续浏览（scrub）**；快速点按（无位移）则跳到最近的用户消息。视口窗口以毛玻璃胶囊叠加显示当前位置，随滚动实时移动。
4. **分叉锚点着色**：作为谱系功能的交叉点--被 fork 过的用户消息（存在子会话的 `forkedFromMessageId` 指向它）用强调色描边，hover 提示「已分叉 n 次」，点开即可看到谱系（R8 就绪后跳转脑图）。
5. **流式态**：正在生成时最后一个刻度点呈呼吸动画；新用户消息追加时轨道自然增长。

**交互**：

- **hover 刻度点** -> 浮层显示该消息摘要（前 ~60 字符，复用 `getMessageTextContent`）+ 相对时间（「第 3 / 12 问」序号），浮层出现在轨道右侧。
- **点击刻度点** -> 滚动到该消息并短暂高亮：复用现有虚拟列表机制 `setContainerScrollTop(container, getOffsetBefore(index) - 24)` + `markProgrammaticScroll()`（避免触发自动吸底），目标消息行加一次性的高亮描边动画（~1.2s 淡出）。
- **拖动滑块** -> 按百分比反查 `findStartIndex` 二分定位，实时滚动预览。
- **当前正在编辑的消息**（R4 的 `editingMessageId`）在轨道上以编辑图标标记，一眼找回编辑现场。

**出现条件**：用户消息 ≥ 5 条且 `totalContentHeight > 3 × viewportHeight` 时才显示--短对话不占视觉空间。

**密度与规模**：剪影每条消息一个 DOM 元素（内部纹理用 CSS 重复渐变，非逐行渲染），千级消息规模仍轻量。布局完全由已有的 `messageOffsets`/`totalContentHeight` 计算属性派生，**零额外测量、零新增 observer**。

**技术落点**：新组件 `MessageMinimap.vue`，作为 `MessageList.vue` 的子组件，props 传入 `messages / scrollTop / viewportHeight / forkAnchorCountById`，emit `jumpTo(index)`；不需要穿过 `useChatPanel`（定位是列表内部关注点）。分叉锚点计数由 R2 的谱系索引（`conversation-lineage.ts`）提供，R8 未实现前传空映射即可先行上线。

---

## § 06 技术方案要点

1. **新增 `message-branching.ts`**（`apps/electron/src/renderer/components/chat/panel/`）：`forkConversationFromMessage(messageId, edit?)`、`truncateFromMessage(messageId)`、`resolveMessageIndexById(id)`、block 过滤器（R6 表）。纯函数 + 调用现有 `saveConversation`/`newConversation`，不新增 IPC。
2. **无新 IPC**：Fork = `conversations:save`（新 id 整包写）+ 本地 `conversations` 列表刷新；原地编辑 = 一次覆盖 save。主进程零改动（仅 `ChatMessage/Conversation` 类型放宽字段）。
3. **UI 落点**：`MessageRow.vue` 增加用户消息 hover 工具条（仅 `msg.role === 'user'`），emit 到 `MessageList` → `ChatPanelContainer` → `useChatPanel` 暴露 `editUserMessage/forkFromMessage`；编辑态组件放 `blocks/` 或独立 `MessageEditBox.vue`。
4. **不迁移旧数据**：旧消息无 id → 功能按钮仅对有 id 消息渲染，避免一次性数据迁移风险。
5. **谱系索引（R8 用）**：`conversation-lineage.ts` 的 `buildLineageForest(conversations)` 在会话列表加载后构建内存树索引（父 -> 子映射、根 -> 节点集合），侧栏徽标计数与脑图共用；脑图组件 `ConversationTreeView.vue` 自绘 SVG，分叉锚点消息摘要按需经 `conversations:get` 拉取并 LRU 缓存，避免全量读会话文件。
6. **小地图（R9 用）**：`MessageMinimap.vue` 挂在 `MessageList.vue` 内，位置/滑块全部由既有 `messageOffsets`、`totalContentHeight`、`scrollTop/viewportHeight` 计算属性派生；跳转复用 `setContainerScrollTop` + `markProgrammaticScroll`，并临时关闭自动吸底（`nearBottom` 判定）以免被拉回底部。

---

## § 07 分阶段路线图

### Phase 1 · P0 -- 地基与 Fork
1. `ChatMessage.id` 双侧类型 + `message-sender` 写入（R1）
2. `Conversation` 谱系字段 + 侧栏分叉徽标（R2）
3. `message-branching.ts` + 「从此分叉」按钮 + block 过滤（R3 / R6 / R7）

### Phase 2 · P0 -- 编辑重发
4. 行内编辑态 + 附件还原（R4 前半）
5. 分叉重发（默认路径）
6. 原地重发 + 确认弹窗 + 失败回滚

### Phase 3 · P1/P2 -- 定位导航、脑图与伴随体验
7. 用户消息小地图：轨道渲染、视口滑块、点击跳转与高亮、摘要浮层（R9 前半；不依赖 R8 可先行）
8. 谱系图视图：树构建、节点/边渲染、锚点摘要、跳转高亮（R8 前半）；随后接入 R9 的分叉锚点着色与跳转
9. 脑图节点操作：打开 / 从此深化 / 重命名 / 删除（R8 后半）
10. 复制原文（R5）
11. 「重新生成最后一条回复」（复用 id 锚点与截断管线，后续 PRD 展开）

### 需求矩阵

| 需求 | 优先级 | 依赖 |
|---|---|---|
| R1 消息稳定 ID | P0 | -- |
| R2 会话谱系元数据（完整链路） | P0 | R1 |
| R3 消息级 Fork | P0 | R1, R6 |
| R4 编辑重发（分叉/原地） | P0 | R1, R3 |
| R5 复制原文 | P2 | -- |
| R6 分支内容过滤 | P0 | R1 |
| R7 运行时护栏 | P0 | R3 |
| R8 对话树脑图与继续深化 | P1 | R2, R3 |
| R9 用户消息小地图 | P1 | --（锚点着色依赖 R2 数据） |

---

## § 08 风险与开放问题

1. **下标引用面有多大**：lightbox、todo 提取、群组进度等均按下标寻址。本方案刻意**不改渲染寻址**（只新增 id 锚点解析），把改动面压到最小；但若 Phase 3 引入「删除单条消息」类功能，必须先完成渲染层 id 化。
2. **附件重发的边界**：上传类附件（office/pdf 解析结果）在 `attachment` block 里只有摘要文本，重发是否需要重新解析原文件？首版按「摘要文本即上下文」处理（模型看到的就是这些），不重新上传。
3. **长期目标 / agent 记忆的谱系错位**：fork 会话与源会话共享 agentId，agent 记忆会把两条线的行为都记下来。是否需要「分叉会话记忆隔离」开关？--开放，首版不做。
4. **原地重发对 targetProjectId 的副作用**：若截断掉的轮次里 agent 已对项目做了写操作，重发不会回滚文件系统。确认弹窗文案需明示「已执行的文件/命令操作不会撤销」。
5. **默认值之争**：编辑保存默认「分叉」还是「原地」？本 PRD 取分叉（安全优先、与主流产品一致），设置项 `chat.defaultEditAction` 留待用户反馈。
6. **谱系树的规模**：重度用户可能分叉几十层、一棵树上百节点。脑图需要折叠子树 + 「仅显示当前树」过滤兜底（R8 已含）；锚点消息摘要按需 `conversations:get` 加载，避免列表页全量读会话文件。
7. **原地重发与谱系的语义冲突**：原地重发会销毁该消息之后的分支锚点来源--若后续有人从「将被截断的消息」fork 出过子会话，截断后子会话的 `forkedFromMessageId` 在父会话中查不到了。规则：锚点摘要显示「（原文已在编辑中移除）」，子会话与树结构不受影响（边指向会话，不指向消息）。
8. **小地图的偏移精度**：未渲染区域的消息高度靠估算（`estimatedMessageHeights`），刻度点位置可能与真实位置有少量漂移。点击跳转后视口落在目标附近即算成功（目标消息行做高亮动画确认）；跳转触发的渲染测量会回填真实高度，同一会话内越用越准--不追求像素级精确。
