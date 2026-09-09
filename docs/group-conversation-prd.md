# 多 Agent 群组对话：从「协调者传话」到「Agent 互相对话」

> **状态** Draft v0.1 · **日期** 2026-08-11 · **范围** `apps/electron/electron/main-process/ai/group-deliberation.ts` 及相关工具/UI

## 摘要

当前群组对话是一套**以 coordinator 为中枢的并行笔记制**——成员间不直接通信、讨论时不许用工具、没有共享状态、轮次是硬同步屏障。本 PRD 定义把它演进为**真正的多 Agent 对话**所需的产品需求：点对点消息、共享黑板、讨论中工具调用、事件驱动轮次与人在环中。

---

## § 01 现状评估：它现在到底是怎么跑的

群组对话的运行时已经相当完整——配置、路由、多轮、进度 UI、转写 block 都在。问题不在「有没有」，而在**对话拓扑**：它是单向的、批量的、经协调者中转的。

### 运行时链路（已验证）

- **配置层**：`apps/electron/src/main/settings/agent-group-store.ts` 持久化群组定义——协调者 agent、成员列表、`maxRounds`(1–5)、`maxParallelWorkers`(1–5)、`sharedMemoryScopes`、`visibility`。设置 UI 在 `apps/electron/src/renderer/components/settings/AgentWorkspacePanel.vue`。
- **选择**：侧栏 `openGroup` → `selectedGroupId` → 作为第 10 个参数传给 `chatStream` → `apps/electron/electron/main-process/ipc.ts` 的 `ai:chatStream` 处理器 → `buildGroupDeliberationSection()`。
- **运行时**：`apps/electron/electron/main-process/ai/group-deliberation.ts`（1232 行）的 `runGroupDeliberation()`。`parseGroupRouting()` 按 `@提及` 选模式：`coordinator_only` / `targeted` / `discussion` / `coordinator_decides` / `mentioned_agent_decides`。
- **子 agent 工具**：`spawn_subagents` → `apps/electron/src/main/ai-engine/agent/subagent-service.ts` 的 `SubagentService.runParallel()`，各自独立 AgentCore、互不可见、阻塞到全部完成。

### discussion 模式的执行结构

```
        User
         ↕
    Coordinator  ← planner + synthesizer
      ↘ ↓ ↙         ↖ ↑ ↗  (笔记批量回传)
    Member A   Member B   Member C
       ─ ─         ─ ─        (成员间无链路)
```

每轮：coordinator 用 LLM 决定邀请哪些成员 + focus（调用时禁用全部工具）→ 被选成员**并行**跑（按 `maxParallelWorkers` 分批），各自产出内部「笔记」→ 笔记收集 → 下一轮把最近 6 条笔记（≤3000 字符）作为 prior notes 注入。所有轮结束后，笔记汇总成 `promptSection` 注入 coordinator 的系统提示，由 coordinator 给用户最终答复。

**做得好的部分 · 保留**：`@提及` 路由、多轮迭代、并行加速、角色隔离 prompt、`group_progress`/`agent_sidechat` 实时 UI、转写可见性分级——这套骨架值得保留并在此基础上演进。

---

## § 02 核心问题诊断：为什么「不能让多个 Agent 对话」

把现象归到六个根因。每条都已在代码中定位。

### ① 通信拓扑：纯 hub-and-spoke，无点对点
所有交互必须经 coordinator。Member A 无法直接对 Member B 说话，没有消息总线，没有 `message_agent` 工具。唯一的跨 agent 原语 `spawn_subagents` 是 fire-and-forget 的隔离并行——子 agent 互相看不见、阻塞到全部完成。

### ② 能力：讨论模式下成员被禁用全部工具
`group-deliberation.ts:1048`：`deniedToolNames: isDiscussionMode ? allToolNames : ...`。discussion 模式下成员被剥夺所有工具，只能凭空生成文本笔记——不能读文件、不能搜索、不能跑命令。讨论成了「空对空」。

### ③ 共享状态：SharedBoard 是死代码
`SharedBoard` 类型（目标 / 假设 / 任务认领 / 决策 / 证据 / 待解问题）在 `agent-workspace-types.ts` 定义，但全仓库从未实例化。协作状态是隐式的「笔记流」，不是显式可查的共享黑板。

### ④ 节奏：同步轮次屏障，无事件驱动
轮次是硬 barrier——一轮内成员并行跑完、收齐笔记，才进下一轮。成员不能中途插话、不能对同轮他人的发现即时回应、不能越序。coordinator 也只能按轮决策，无法基于流式事件动态调度。

### ⑤ 可见性：成员互不可见
同轮内成员互相是盲的。下一轮只能拿到前序笔记的截断批次。没有「谁正在说什么」的实时流，导致回应常常重复或脱节。

### ⑥ 人机协作：无中途注入
deliberation 一旦开始，用户无法插入澄清、纠正方向或叫停某成员，只能等整轮结束。群组记忆 `sharedMemoryScopes` 也未在协作期间读写。

---

## § 03 目标与非目标

### 目标
- 让群组内任意两个 agent 能**直接、按需**通信（同步问答 + 异步广播）。
- 让协作状态有一块**显式共享黑板**，从「笔记流」升级为「可查状态」。
- 让讨论中的成员能**用工具支撑论点**，并受成本护栏约束。
- 把节奏从「硬轮次屏障」放宽为**事件驱动 + 可插话**。
- 让用户能在**讨论进行中插话/纠偏**。

### 非目标（本周期不做）
- 不引入投票/多数共识等群体决策原语（先打通双向通信）。
- 不重写现有 `spawn_subagents` 的并行 fan-out 语义（它和群组对话是两种正交模式，并存）。
- 不做跨进程/跨机器的多 agent 分布式编排（本期单进程内）。

---

## § 04 产品需求

八项需求，按优先级标注。P0 是解锁「真对话」的最小集。

### R1 · Agent 间点对点消息原语 `P0`
- **用户故事**：作为任意成员，我执行任务时发现需要另一个 agent 的专长，应能直接向它发消息并等待回复，而不必回到用户或绕道 coordinator。
- **验收标准**：
  - 新增 `message_agent` 工具：参数 `target_agent_id` / `message` / `timeout`。
  - 目标 agent 在自身上下文收到请求并产出回复；调用方拿到回复后继续。
  - 支持超时与拒绝；复用 `loop-detector.ts` 防递归过深。
  - 死锁检测：A 等 B、B 等 A 时主动报错放行。
  - UI 复用 `agent_sidechat` block 呈现这次双向会话。
- **技术要点**：引入 per-group-session 的 `GroupMessageBus`（in-memory）；目标 agent 用 `chatStream` 起一个 sub-run；递归深度上限默认 2 层。

### R2 · 共享黑板（SharedBoard）落地 `P0`
- **用户故事**：作为组内成员，我应能读写一块共享「任务板」——目标、假设、任务认领、决策、证据、待解问题——让协作状态显式可查。
- **验收标准**：
  - 激活已有的 `SharedBoard` 类型；新增 `read_board` / `update_board` 工具（字段级结构化写入）。
  - board 状态作为 system prompt section 注入每个成员（diff 注入，避免膨胀）。
  - 并发写采用字段级合并 + 审计日志（谁、何时、改了哪格）。
  - UI：扩展 `group_progress` 或新增 block 呈现板子快照。
- **技术要点**：board 存于 `GroupSession` 状态；仅注入「自上次读取后的 diff」；保留全量审计 log 供转写回看。

### R3 · 讨论模式解锁工具调用 `P0`
- **用户故事**：作为讨论中的成员，我应能读文件 / 搜索 / 跑命令来支撑论点，而不是只能凭空生成文本。
- **验收标准**：
  - 移除 `group-deliberation.ts:1048` 的 `deniedToolNames = allToolNames`；改用成员自身 `allowedTools/deniedTools`，叠加群组级覆盖。
  - 工具进度实时进 `agent_sidechat` block。
  - 成本护栏：每成员每轮工具调用上限 + 群组总 token 预算；超额自动收敛。
- **技术要点**：与 R1 配合防递归过深；护栏参数进群组配置；超额时 coordinator 强制进入综合阶段。

### R4 · 事件驱动轮次与流式互见 `P1`
- **用户故事**：作为成员，当同轮另一成员产出了与我相关的发现，我应能即时看到并回应，而不是等到下一轮屏障。
- **验收标准**：
  - 引入「发言事件流」：成员的 token / 工具 / 结论事件可被同组其他成员订阅（默认选择性可见）。
  - 支持「追加发言」——成员可在轮次内对他人发现二次回应。
  - coordinator 可基于流式事件提前结束、追加成员或聚焦。
- **技术要点**：pub/sub over `GroupMessageBus`；可见性策略（按 @提及 / 按主题相关性）防噪声；背压处理。

### R5 · 人在环中（HITL）注入 `P1`
- **用户故事**：作为用户，讨论进行中我应能插入澄清、纠正方向或叫停某成员，而不必等整轮结束。
- **验收标准**：
  - deliberation 间隙暴露「用户插话」入口；插话作为高优先级消息注入相关成员。
  - 支持「暂停 / 恢复」整组；插话点在 UI 上可见。
  - 插话内容持久化进 `chat-history`。
- **技术要点**：与 R4 事件流衔接；定义中断语义（当前 sub-run 优雅停止 vs 强制）；恢复时重放上下文。

### R6 · 成员直答用户 `P1`
- **用户故事**：作为被 `@` 的成员，在讨论模式下我应能直接对用户回复，而不必总由 coordinator 转述。
- **验收标准**：
  - 支持 `direct_reply` 标记的成员发言直接进入主对话流。
  - coordinator 仍可补充/综合；UI 明确区分「成员直答」与「coordinator 综合」。
  - 路由决策避免双答（同一问题不产生两个用户可见回复）。
- **技术要点**：扩展 `parseGroupRouting` 的 `targeted` 语义到 discussion；用 `AgentSidechatSession.mode` 标记直答。

### R7 · 群组级持久记忆 `P2`
- **用户故事**：作为组，我们应在跨会话间记住「如何协作、各自专长、过往决策」。
- **验收标准**：
  - 落地 `sharedMemoryScopes: ['group']`；deliberation 开始时注入、结束时由 coordinator 写回。
  - 与现有 `memoryEngine` 集成；写权限策略可配。
- **技术要点**：memoryEngine 已支持 scope，主要是接线；注意群组记忆 vs 项目记忆的边界与冲突合并。

### R8 · 可观测性与转写体验 `P2`
- **用户故事**：作为用户，我应能回看一次群组讨论的完整脉络：谁说了什么、基于什么工具结果、如何收敛。
- **验收标准**：
  - `group_transcript` 在 expandable 模式展示工具调用与证据引用。
  - 支持按成员 / 按轮次过滤；可导出；可折叠噪声。
  - 与 `chat-history` 集成，跨会话可回放。
- **技术要点**：事件全量持久化；渲染性能（虚拟滚动）；引用链可视化。

---

## § 05 分阶段路线图

P0 三项合起来才让「边做边商量」成立——任意一项单独上都不够。P1 让对话「活」起来。P2 沉淀与体验。

### Phase 1 · P0 —— 解锁「真对话」最小集
让 agent 间能直接通信、共享状态、边讨论边用工具。完成后群组从「并行笔记」变成「协作干活」。
- R1 点对点消息 · R2 共享黑板 · R3 工具解锁

### Phase 2 · P1 —— 让对话「活」起来
从硬轮次屏障到事件驱动；成员可直答用户；用户可中途插话。
- R4 事件驱动 · R6 成员直答 · R5 HITL

### Phase 3 · P2 —— 沉淀与体验
跨会话群组记忆；完整可回放转写。
- R7 群组记忆 · R8 转写体验

### 需求矩阵

| 需求 | 优先级 | 阶段 | 大致工作量 | 主要风险 |
|---|---|---|---|---|
| R1 点对点消息 | P0 | 1 | M–L | 死锁/活锁 |
| R2 共享黑板 | P0 | 1 | M | 并发一致性 |
| R3 工具解锁 | P0 | 1 | S–M | 成本爆炸 |
| R4 事件驱动 | P1 | 2 | L | 上下文膨胀 |
| R5 HITL 注入 | P1 | 2 | M | 中断语义 |
| R6 成员直答 | P1 | 2 | S | 双答 |
| R7 群组记忆 | P2 | 3 | M | 边界混淆 |
| R8 转写体验 | P2 | 3 | M | 渲染性能 |

---

## § 06 风险与开放问题

### 风险
- **成本 / 延迟**：多 agent × 多轮 × 工具易爆炸。必须配预算护栏、并发上限、早停策略。
- **死锁 / 活锁**：P2P 消息 + 共享板引入环依赖。复用 `loop-detector`，加全局等待图（wait-for graph）。
- **一致性**：共享板并发写——字段级合并 + 审计，避免 last-writer-wins 丢信息。
- **上下文膨胀**：互见事件 + prior notes 叠加。需摘要 / 裁剪 / 选择性可见。
- **权限**：成员工具权限需群组级 allow/deny 覆盖，防越权。

### 开放问题
- **Q** · P2P 是完全对等，还是保留 coordinator 仲裁（成员可互发，但最终综合仍由 coordinator）？
- **Q** · 群组记忆与项目记忆的边界——同一群组跨不同项目时，记忆该绑定到哪一层？
- **Q** · 事件可见性的默认粒度——默认全互见（噪声大）还是按 @提及 / 主题相关性过滤？
- **Q** · 是否在 P0 就引入「任务认领」语义（成员从 board 拿走任务后其他人不可重复认领），还是延后？

---

*本 PRD 基于对 `apps/electron/electron/main-process/ai/group-deliberation.ts`、`apps/electron/src/main/ai-engine/agent/subagent-service.ts`、`apps/electron/src/main/ai-engine/agent/tools/tool-spawn-subagent.ts`、`apps/electron/src/shared/agent-workspace-types.ts` 及相关 UI block 的代码审阅。所有文件 / 行号引用截至 2026-08-11。*
