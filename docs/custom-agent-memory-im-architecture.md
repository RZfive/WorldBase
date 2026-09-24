# WorldBase — 自定义 Agent、长期记忆、群协作与 IM 接入升级方案

> 记忆、Embedding、跨 conversation 召回和供应商模型配置的现行设计基线见 [`shared-memory-embedding-architecture.md`](./shared-memory-embedding-architecture.md)。本文保留 Agent、群协作和 IM 接入的产品方案；其中早期“先做 FTS5、后做 embeddings”的表述是历史分阶段建议，不覆盖新的记忆向量架构。

## 1. 目标

本次升级要解决四个连续问题，而不是四个彼此独立的功能点。

1. 用户可以创建自定义 Agent，而不是只有一个固定主 Agent。
2. Agent 可以按组协作，围绕同一个任务互相交流、迭代、分工和汇总。
3. 单个 Agent 可以持续对话，但长期记忆必须“少而精”，不能把整段聊天都当记忆。
4. 整个链路要为未来接入 IM 做准备，使外部消息、群聊线程和本地会话可以统一编排。

本方案基于当前代码做增量演进，不推翻现有聊天、技能、权限和会话存档能力。

---

## 2. 现状与缺口

当前基础已经足够支撑升级，但缺少中间层抽象。

| 维度 | 当前基础 | 缺口 |
|------|----------|------|
| 会话 UI | `apps/electron/src/renderer/components/chat/ChatPanel.vue` 已支持会话、项目上下文、技能选择、流式执行 | 没有 Agent 配置、群协作、记忆查看入口 |
| 会话存档 | `apps/electron/src/main/settings/ai-log-store.ts` 已保存 conversation/session/provider/tool 日志 | 没有“长期记忆蒸馏”和结构化召回 |
| Agent 内核 | `apps/electron/src/main/ai-engine/agent/agent-core.ts` 已支持上下文压缩、计划模式、技能注入、成本追踪 | 没有 Agent Profile、多 Agent 编排、共享任务板 |
| Skills | `apps/electron/src/main/ai-engine/agent/skill-engine.ts` 已支持技能解析、注册、执行 | 技能还没有成为 Agent 的长期能力画像 |
| 权限 | `apps/electron/src/main/ai-engine/agent/permissions/permission-engine.ts` 已有多层权限链 | 没有针对 IM 来源和群组代理身份的额外策略 |

结论很明确：

- 现有系统已经有“单 Agent 聊天引擎”。
- 本次升级的关键不是重写聊天，而是补齐四层能力：`Agent 定义层`、`记忆层`、`协作编排层`、`IM 适配层`。

---

## 3. 设计原则

### 3.1 Agent 不是一段对话

Agent 应该是稳定对象，至少包含这些内容：

- 角色定义
- 默认模型和推理强度
- 激活技能集合
- 允许使用的工具范围
- 记忆读写策略
- 可加入的群组角色

会话只是 Agent 在某个上下文中的一次执行实例。

### 3.2 原始聊天记录不等于长期记忆

长期记忆只保留四类内容：

1. 用户特性
2. Agent 技能
3. 重要步骤
4. 关键知识点

整段原始聊天、重复工具输出、临时情绪和噪音消息不应该进入长期记忆。

### 3.3 群协作不做“全自由群聊”

工程上不建议让多个 Agent 无限自由对话。那样会快速产生三个问题：

- 上下文膨胀
- 责任不清
- 结果难以收敛

可行方案是 `Coordinator + Worker + Shared Board`：

- Coordinator 负责拆解任务、分配角色、合并结果。
- Worker 在各自侧链会话里执行。
- Agent 之间的交流通过结构化消息和共享任务板完成，而不是无约束互刷消息。

### 3.4 IM 只是消息入口，不应该侵入核心 Agent 设计

未来接入企业微信、飞书、Slack、Discord 或 Telegram 时，都应该先归一化成统一的 `ChannelEvent`，再进入同一套会话和权限链路。

### 3.5 记忆检索采用 SQLite FTS5 + 向量索引

当前应用本地存储已经依赖 SQLite。记忆事实和关键词索引继续使用 SQLite/FTS5；跨 Agent、跨 conversation 的模糊语义召回在配置供应商 embedding 模型后使用 sqlite-vec 向量索引。完整的数据模型、模型生命周期、容量估算、供应商模型和 Rust/Electron 边界见 [`shared-memory-embedding-architecture.md`](./shared-memory-embedding-architecture.md)。

---

## 4. 目标架构总览

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Renderer                                                           │
│                                                                     │
│  ChatPanel                                                         │
│  ├─ Agent Switcher                                                 │
│  ├─ Group Workspace                                                │
│  ├─ Memory Inspector                                               │
│  ├─ Skill Picker                                                   │
│  └─ IM Binding / Approval UI                                       │
│                                                                     │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ IPC
┌───────────────────────────────▼─────────────────────────────────────┐
│ Main Process                                                        │
│                                                                     │
│  Agent Registry                                                     │
│  ├─ AgentStore                                                      │
│  ├─ AgentProfileResolver                                            │
│  └─ GroupTemplateStore                                              │
│                                                                     │
│  Memory Engine                                                      │
│  ├─ MemoryStore (SQLite + FTS5)                                     │
│  ├─ MemoryExtractor                                                 │
│  ├─ MemoryDeduper                                                   │
│  ├─ MemoryRetriever                                                 │
│  └─ MemoryDecay / Pin / Forget                                      │
│                                                                     │
│  Collaboration Engine                                               │
│  ├─ GroupCoordinator                                                │
│  ├─ WorkerSessionRunner                                             │
│  ├─ SharedBoard                                                     │
│  └─ SidechainTranscriptStore                                        │
│                                                                     │
│  IM Gateway                                                         │
│  ├─ Connector Registry                                              │
│  ├─ ChannelBindingStore                                             │
│  ├─ EventNormalizer                                                 │
│  └─ Approval Bridge                                                 │
│                                                                     │
│  Existing Core                                                      │
│  ├─ AgentCore                                                       │
│  ├─ SkillEngine                                                     │
│  ├─ PermissionEngine                                                │
│  ├─ Tool Registry                                                   │
│  └─ AILogStore                                                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 5. 核心对象模型

### 5.1 AgentDefinition

```ts
interface AgentDefinition {
  id: string
  name: string
  description: string
  systemPrompt: string
  modelId?: string
  providerId?: string
  reasoningStrength?: 'low' | 'medium' | 'high'
  skillIds: string[]
  allowedTools?: string[]
  deniedTools?: string[]
  memoryScopes: Array<'user' | 'agent' | 'project' | 'group' | 'channel'>
  memoryWritePolicy: {
    allowUserTraits: boolean
    allowAgentSkills: boolean
    allowSteps: boolean
    allowKnowledge: boolean
  }
  autoReplyPolicy?: {
    enabled: boolean
    requireMention: boolean
  }
  createdAt: string
  updatedAt: string
}
```

### 5.2 AgentGroupDefinition

```ts
interface AgentGroupDefinition {
  id: string
  name: string
  description?: string
  coordinatorAgentId: string
  memberAgentIds: string[]
  maxRounds: number
  maxParallelWorkers: number
  sharedMemoryScopes: Array<'group' | 'project' | 'channel'>
  visibility: 'summary_only' | 'expandable_internal_transcript'
  createdAt: string
  updatedAt: string
}
```

### 5.3 MemoryEntry

```ts
type MemoryType = 'user_trait' | 'agent_skill' | 'step' | 'knowledge'

interface MemoryEntry {
  id: string
  scopeType: 'user' | 'agent' | 'project' | 'group' | 'channel'
  scopeId: string
  memoryType: MemoryType
  title: string
  summary: string
  details?: string
  tags: string[]
  sourceConversationId?: string
  sourceSessionId?: string
  sourceMessageIds?: string[]
  importance: number
  confidence: number
  pinned: boolean
  lastUsedAt?: string
  createdAt: string
  updatedAt: string
}
```

### 5.4 ChannelBinding

```ts
interface ChannelBinding {
  id: string
  connectorType: 'feishu' | 'wecom' | 'slack' | 'discord' | 'telegram' | 'custom'
  externalChannelId: string
  externalThreadId?: string
  boundConversationId?: string
  boundGroupId?: string
  defaultAgentId?: string
  targetProjectId?: string | null
  autoReply: boolean
  requireApprovalForRiskyTools: boolean
  createdAt: string
  updatedAt: string
}
```

---

## 6. 长期记忆系统设计

## 6.1 记忆分层

### L0. 原始会话层

沿用现有 `AILogStore`，作为执行日志和调试来源。

定位：

- 这是审计和恢复数据，不是长期记忆。
- 不直接注入后续 prompt。
- 可设置 TTL、压缩和清理策略。

### L1. 用户特性记忆

只保留与协作有关的稳定偏好，不保留泛化个人隐私。

保留示例：

- 用户偏好中文回答
- 用户偏好先出方案再动代码
- 用户习惯使用某个 provider/model
- 用户对权限确认的偏好

不保留示例：

- 无关闲聊
- 情绪化表达
- 没有复用价值的临时指令

### L2. Agent 技能记忆

它描述的是“这个 Agent 擅长什么、用什么技能包、默认如何行动”。

保留内容：

- 绑定的 skill ids
- 使用过且效果稳定的技能组合
- 常用工具偏好
- 在特定任务类型中的有效工作流

### L3. 重要步骤记忆

这是任务执行中的“可复用步骤”。

保留示例：

- 某类项目初始化的关键步骤
- 解决某类错误的固定排查顺序
- 某项上线流程中的必做检查点

### L4. 知识点记忆

这是可复用事实，而不是聊天原文。

保留示例：

- 某模块的约束
- 某工具的稳定使用方式
- 某项目的运行时陷阱
- 经过验证的最佳实践

这类记忆最能让 Agent “越用越聪明”。

## 6.2 明确保留与不保留

| 类别 | 是否进入长期记忆 | 说明 |
|------|------------------|------|
| 用户特性 | 是 | 仅保留和协作、偏好、约束相关的稳定信息 |
| Agent 技能 | 是 | Skill 组合、擅长任务、工具偏好 |
| 重要步骤 | 是 | 已验证有效的执行流程和关键里程碑 |
| 知识点 | 是 | 事实、约束、坑点、模式 |
| 原始整段聊天 | 否 | 只保留在会话日志层，不进入长期记忆 |
| 重复工具输出 | 否 | 容易污染上下文 |
| 临时寒暄 | 否 | 无复用价值 |
| 未确认结论 | 默认否 | 低置信度候选进入待审核队列 |

## 6.3 写回链路

每次会话结束或达到阶段里程碑时，执行一次结构化蒸馏。

```text
Raw session
  -> Candidate extraction
  -> Type classification (trait / skill / step / knowledge)
  -> Summarization
  -> Deduplication
  -> Confidence scoring
  -> Store or review queue
```

建议的写回规则：

1. 只有被明确完成、验证通过、或多次重复出现的信息才允许自动写入。
2. 单轮临时猜测不写入。
3. 工具执行失败但暴露出稳定坑点时，可写成知识点记忆。
4. 用户显式说“记住这个偏好/规则”时，直接提升为高置信度记忆。

## 6.4 检索链路

会话开始或轮次切换前，根据当前上下文拉取有限数量的结构化记忆。

检索输入：

- 当前 Agent
- 当前群组
- 当前项目
- 当前外部频道或线程
- 当前用户消息

检索输出：

- `user_trait` 最多 5 条
- `agent_skill` 最多 5 条
- `step` 最多 6 条
- `knowledge` 最多 8 条

这些记忆被渲染成独立 prompt section，而不是混入原始聊天消息。

## 6.5 评分与遗忘

每条记忆维护至少四个信号：

- `importance`
- `confidence`
- `lastUsedAt`
- `pinned`

遗忘策略：

- 低重要度且长时间未命中的记忆降权
- 与高置信度记忆重复的条目合并
- 用户可手动 Pin、Forget、Merge

## 6.6 为什么这套设计可行

因为它不依赖一开始就上独立向量数据库服务。

MVP 阶段直接使用：

- SQLite 主表存结构化记忆
- FTS5 建索引
- tags + scope 做过滤
- importance/confidence 做排序

当用户在供应商配置中设置 embedding 模型后，再启用 sqlite-vec 相似度召回；没有设置模型时继续使用 SQLite/FTS5，不创建向量存储。

---

## 7. 自定义 Agent 设计

## 7.1 产品定义

自定义 Agent 不是“系统 prompt 文本框”，而是一个可复用工作体。

一个 Agent 至少要让用户配置：

- 名称、描述、头像颜色
- 角色系统提示词
- 默认模型和推理强度
- 默认技能集合
- 可用工具范围
- 默认目标项目
- 记忆读写范围
- 是否允许被 IM 自动唤起

## 7.2 UI 方案

在当前 `ChatPanel` 基础上增加四个入口。

1. Agent Switcher
   - 当前对话绑定哪个 Agent
   - 快速切换到单 Agent 或群组

2. Agent Studio
   - 新建、复制、编辑 Agent
   - 配置技能、模型、工具策略、记忆策略

3. Skill Mapping 面板
   - 把现有 SkillStore 的技能和 Agent 绑定
   - 显示每个 Agent 的默认技能包

4. Agent Profile Preview
   - 发送前展示本轮实际注入的 Agent 配置、技能和记忆摘要

## 7.3 后端实现

新增：

- `apps/electron/src/main/settings/agent-store.ts`
- `apps/electron/src/main/ai-engine/agent-registry/`

职责：

- 存 AgentDefinition
- 根据会话 ID 解析当前 Agent
- 把 Agent skill ids 转换成实际 skill contents
- 组装 Agent prompt overlay

---

## 8. Agent 群协作设计

## 8.1 群协作模式

用户选中一个 Agent Group 后，不是把同一条消息同时喂给所有 Agent，而是走统一编排。

```text
User task
  -> Coordinator plans
  -> Shared board creates sub tasks
  -> Workers execute in isolated sidechains
  -> Workers post structured updates
  -> Coordinator merges / asks next round / concludes
```

## 8.2 为什么使用侧链

每个 Worker 都应拥有独立 sidechain transcript。

优点：

- 不污染主对话上下文
- 不同 Agent 的推理互不覆盖
- 失败 worker 可以单独重试
- 可以单独回看某个 Agent 的内部执行过程

## 8.3 Shared Board 结构

群协作不要靠“聊天历史滚动区”承载状态，要有共享任务板。

建议字段：

```ts
interface SharedBoard {
  goal: string
  assumptions: string[]
  tasks: Array<{
    id: string
    title: string
    ownerAgentId?: string
    status: 'todo' | 'running' | 'blocked' | 'done'
    summary?: string
  }>
  decisions: string[]
  evidenceRefs: string[]
  openQuestions: string[]
}
```

## 8.4 群内交流规则

Agent 之间的交流应结构化，不建议直接传整段自然语言长消息。

建议消息类型：

- `task_assigned`
- `progress_update`
- `decision_proposal`
- `need_clarification`
- `result_summary`

## 8.5 资源和风控

群协作必须有限制，不然成本和上下文都会失控。

默认限制建议：

- 群组 Agent 数量上限：5
- 并发 Worker 上限：3
- 协作轮次上限：3
- 每个 Worker 单轮工具调用上限：按现有 AgentCore 限制继承
- 危险工具权限：仍走现有 PermissionEngine

---

## 9. 为未来 IM 接入预留的统一桥接层

## 9.1 不直接绑定具体 IM 厂商

不要在 AgentCore 里写飞书、企业微信或 Slack 逻辑。应该先抽象：

```ts
interface ChannelEvent {
  connectorType: string
  channelId: string
  threadId?: string
  messageId: string
  senderId: string
  senderName?: string
  text: string
  attachments?: Array<{ name: string; mimeType: string; localPath?: string }>
  mentions?: string[]
  createdAt: string
}
```

所有外部消息先进 `IM Gateway`，转换成内部统一事件，再路由到：

- 单 Agent 会话
- Agent Group 会话
- 人工待审批队列

## 9.2 Channel Binding

每个外部群、频道或线程都可以绑定到一个内部上下文。

绑定维度：

- 绑定到单 Agent
- 绑定到 Agent Group
- 绑定到默认项目上下文
- 绑定到默认权限模式

## 9.3 IM 中的权限审批

风险操作不能因为来自 IM 就自动放开。

建议规则：

1. 只读工具可自动执行。
2. 写工具和命令工具继续走确认流程。
3. 如果桌面端在线，优先桌面审批。
4. 如果仅 IM 在线，则发回审批卡片或待办消息。

## 9.4 IM 接入后的记忆范围

IM 线程会引入新的上下文范围：`channel scope`。

它适合保留：

- 某个群固定协作偏好
- 某个频道长期关注的项目
- 某个线程里的阶段性结论

它不应该越权覆盖用户级偏好和 Agent 级技能记忆。

---

## 10. UI 规划

## 10.1 在现有 ChatPanel 上增量扩展

当前聊天面板已经具备对话列表、技能选择、项目上下文和流式消息渲染，适合继续扩展，而不是重做。

建议新增以下 UI 区块。

### A. Chat Header

- 当前 Agent 标签
- 当前群组标签
- Memory 命中计数
- 当前权限模式
- 当前目标项目

### B. 左侧 Sidebar 新分组

- 对话
- Agents
- Groups
- Memory

### C. Agent Studio

- Agent 列表
- 新建/复制/删除
- 技能绑定器
- 工具权限配置
- 模型和推理配置
- 记忆策略配置

### D. Group Workspace

- 成员列表
- Shared Board
- 每个 Agent 的状态和最近摘要
- 是否展开内部 sidechain transcript

### E. Memory Inspector

- 用户特性
- Agent 技能
- 重要步骤
- 知识点
- Pin / Forget / Merge / Edit

### F. IM Connector Settings

- 连接器配置
- channel 绑定
- 自动回复策略
- 审批策略

---

## 11. 落到现有代码结构的建议目录

### 11.1 Main Process

建议新增目录：

```text
apps/electron/src/main/
  ai-engine/
    agent-registry/
      agent-registry.ts
      agent-profile-resolver.ts
      group-template-registry.ts
    memory/
      memory-engine.ts
      memory-store.ts
      memory-extractor.ts
      memory-retriever.ts
      memory-deduper.ts
    coordinator/
      group-coordinator.ts
      shared-board.ts
      worker-session-runner.ts
      sidechain-store.ts
  im/
    connector-registry.ts
    channel-gateway.ts
    channel-binding-store.ts
    connectors/
      slack-connector.ts
      feishu-connector.ts
      wecom-connector.ts
  settings/
    agent-store.ts
    memory-policy-store.ts
```

### 11.2 Renderer

建议新增目录：

```text
apps/electron/src/renderer/components/chat/
  agent-studio/
  group-workspace/
  memory-inspector/
  im-settings/
```

### 11.3 复用现有实现

下面这些现有模块应直接复用，而不是重写：

- `apps/electron/src/main/settings/ai-log-store.ts` 作为原始会话层
- `apps/electron/src/main/ai-engine/agent/agent-core.ts` 作为单 Agent 执行核心
- `apps/electron/src/main/ai-engine/agent/skill-engine.ts` 作为技能能力内核
- `apps/electron/src/main/ai-engine/agent/permissions/permission-engine.ts` 作为权限基线
- `apps/electron/src/renderer/components/chat/ChatPanel.vue` 作为总容器

---

## 12. 端到端链路

## 12.1 单个自定义 Agent 持续对话

1. 用户在 Agent Studio 里创建或选择 Agent。
2. ChatPanel 绑定当前 Agent 和项目上下文。
3. 会话发送前，MemoryRetriever 按 scope 拉取用户特性、Agent 技能、步骤和知识点。
4. AgentCore 执行本轮对话和工具调用。
5. 会话结束后，MemoryExtractor 从原始日志中提炼候选记忆。
6. 通过去重、打分和分类后写入 MemoryStore。
7. 下次继续对话时，Agent 带着精炼记忆进入新会话。

## 12.2 群组协作任务

1. 用户选择一个 Agent Group。
2. Coordinator 读取任务并生成 Shared Board。
3. Worker Agents 分别在 sidechain 中执行子任务。
4. 各 Worker 只回传结构化摘要和证据引用。
5. Coordinator 决定是否进入下一轮。
6. 最终输出给用户的是收敛后的结果，内部 transcript 默认折叠。
7. 有复用价值的步骤和知识点写入 group/project 级记忆。

## 12.3 来自 IM 的消息

1. IM Connector 接收外部消息。
2. EventNormalizer 转换成统一 ChannelEvent。
3. ChannelBinding 查出目标 Agent 或 Agent Group。
4. 系统按频道 scope + agent scope 拉取记忆。
5. Agent 执行并返回结果。
6. 如果涉及高风险工具，进入桌面或 IM 审批桥。
7. 输出回写到外部 IM，同时把可复用内容蒸馏进长期记忆。

---

## 13. 分阶段落地计划

## Phase 1：自定义 Agent + 记忆基础层

目标：先让单 Agent 可持续成长。

范围：

- AgentStore + Agent Registry
- Agent Studio 基础 UI
- MemoryStore + FTS5
- 从 AILogStore 提炼四类记忆
- ChatPanel 注入 Agent 和记忆
- Memory Inspector 基础 UI

交付标准：

- 用户能创建多个 Agent
- 每个 Agent 能绑定技能和记忆策略
- 系统只把四类内容写入长期记忆

## Phase 2：群协作编排

目标：让 Agent 组可控地协作。

范围：

- GroupDefinition / GroupTemplateStore
- GroupCoordinator
- Worker sidechain
- Shared Board
- Group Workspace UI

交付标准：

- 一个复杂任务可以被拆给多个 Agent
- 用户能看到组内进度和最终收敛结果
- 内部讨论默认折叠，避免刷屏

## Phase 3：IM Bridge

目标：把外部消息入口接入统一链路。

范围：

- Connector Registry
- Channel Binding
- Approval Bridge
- IM Settings UI

交付标准：

- 外部频道可绑定单 Agent 或 Agent Group
- 高风险操作仍需要确认
- 频道级记忆可独立检索

## Phase 4：学习质量增强

目标：提高“越用越聪明”的效果，而不是只增加存储量。

范围：

- 记忆去重优化
- 记忆使用反馈回路
- 记忆质量评分
- 供应商 embedding 模型与向量检索

交付标准：

- 相同知识点不重复膨胀
- 高价值记忆命中率逐步提升
- 低价值记忆自动衰减

---

## 14. 风险与控制点

| 风险 | 表现 | 控制方式 |
|------|------|----------|
| 记忆污染 | 什么都写入，后续 prompt 失真 | 仅允许四类记忆进入长期层，增加去重和低置信度审核 |
| 群聊失控 | 多 Agent 无限互聊，成本暴涨 | 强制 Coordinator/Worker 架构，限制轮次和并发 |
| IM 越权 | 外部消息触发危险操作 | 继续走 PermissionEngine，并增加 Approval Bridge |
| 上下文膨胀 | 群组内部 transcript 直接进入主上下文 | sidechain 隔离，只回传摘要 |
| 学习无效 | 记忆越来越多但命中质量不升 | importance/confidence/rank/decay 四信号管理 |

---

## 15. 验收标准

满足以下条件即可认为方案可落地。

1. 用户可以创建多个自定义 Agent，并能在会话中切换。
2. Agent 可以绑定现有 Skills，并把技能作为长期能力画像的一部分。
3. 长期记忆只保留用户特性、Agent 技能、重要步骤、关键知识点。
4. 单 Agent 连续对话时，记忆按 scope 精准召回，而不是回灌整段聊天。
5. Agent Group 可以在有限轮次内协作，并通过 Shared Board 收敛任务。
6. IM 消息可以通过统一 ChannelEvent 进入同一链路，不破坏权限模型。

---

## 16. 最终建议

这次升级不要先从 IM 开始，也不要先做多 Agent 自由群聊。

正确顺序应该是：

1. 先把 `Agent Profile` 做出来，让“谁在执行”成为一等对象。
2. 再把 `Memory Distillation` 做出来，让长期记忆只保留高价值内容。
3. 然后上 `Coordinator + Worker + Shared Board`，让多 Agent 可控协作。
4. 最后再接 `IM Gateway`，把外部消息无缝导入这套链路。

这样做的原因很直接：

- 没有 Agent Profile，群协作只是多个匿名 prompt。
- 没有记忆蒸馏，所谓“越用越聪明”只会变成“越用越臃肿”。
- 没有协作编排，Agent 群聊很难稳定收敛。
- 没有统一消息桥，未来每接一个 IM 都会重复造轮子。

这套方案和当前仓库的匹配度高，属于可分阶段交付的增量改造，而不是高风险重构。
