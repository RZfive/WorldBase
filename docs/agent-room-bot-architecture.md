# Agent Room 与持续 Bot 架构

> 状态：设计提案 v0.5 · 日期：2026-11-18
>
> 范围：群聊升级为扁平人机协作空间；长期目标升级为可从平台/IM 使用、持续运行并接管本机 Agent 的 SuperAgent 式电脑管家 Bot。Bot 只借鉴 SuperAgent 的持久控制面与运行时生命周期；Room 可借鉴“放羊了”的协作方法，但不复用 herdr 或固定分级结构。

## 本次交付

WorldBase 桌面群聊可以直接编排平台 Agent 和本机 CLI。从群聊输入栏点「邀请本机 Agent」，选择已安装的 Codex、Claude Code 或 OpenCode，填写 Worker 的角色和可选职责。同一 CLI 可邀请多次，例如分别担任前端实现和测试回归；每个 Worker 拥有群内唯一的 `@` 名称和独立会话，不会成为全局 Agent。弹窗可连续邀请、查看和移出 Worker。勾选自动退群时，Worker 在汇报结果且没有待处理交接后退出，历史回复保留；失败、被拒绝授权或中途停止则保留成员。平台 Agent 也可按角色邀请 Worker 并交接具体任务。

Worker 按群设置的并发上限运行，使用当前群的任务目录（其次是绑定的项目目录，最后是群专属的 `room-workspaces` 子目录）。独立会话不等于隔离文件，安排多个写入任务时应划分文件范围。在 Agent 工作区仍可将已有 CLI 会话加入群聊；会话发现要求安装版本支持列表接口，并提供可核对的工作目录。

`@all`（也可用 `@全员`）直接唤起群内所有成员，按群设置的并发上限运行，每位成员用自己的姓名和头像分别回复。`@成员` 只投递给点名的成员；未点名时由群设置里的默认回复 Agent 回答。桌面和绑定群聊的 IM 不再经过协调人筛选、排程或生成汇总。单成员回复在姓名旁显示等待、执行、完成、失败或停止状态，不额外创建空回复。需要协作时，成员仍可通过具体任务交接给其他成员；回复正文里的普通提及不会派工。交接受「最大轮次」限制；执行中可停止或发送补充说明。群聊不展示协作计划、黑板或协作摘要卡。

本机 CLI 在实际运行前，通过输入框上方的授权条请求本次任务的工作目录权限。授权条显示目录绝对路径；拒绝则不启动该 CLI，不改变会话的授权设置。CLI 仍执行其自身的权限策略。接入已有会话需要用户选择，平台只恢复这个会话，不注入或接管用户另开终端里正在运行的进程。

群消息保存在 Rust 管理的独立 SQLite 会话。平台和本机成员各自保留会话；CLI 除当前任务外，也能读取临时文件中的群消息快照。清空或删除群聊时，一并删除群消息、成员会话及其摘要，以及群专属或可追溯到本群的长期记忆，包括成员写入共享记忆库的记录。清空保留群成员、Worker 角色和工作目录，并创建新的群上下文；删除同时移除群定义。两者都解除本群的 CLI 会话绑定，但不删除 CLI 应用自行保存的历史、工作区文件或其他群聊和私聊的记忆。正在执行时应先停止本轮；正常重启仍会延续当前上下文。

回归验证：在 `apps/electron` 执行 `pnpm test:local-agents`。设置 `WORLDBASE_RUST_HARNESS` 为编译出的 `worldbase-app-server` 后，同一测试会运行真实 Rust 桥与模拟 CLI 的完整邀请、交接和续跑用例。

ACP 接入、持久工作流和带 IM 入口的常驻 Bot 属于后续阶段。Bot 复用本机 Agent 目录和执行驱动，用持久身份、任务日志和事件唤醒管理长期工作，也可以发起群聊协作。

## 1. 产品定义

这次建设一套 **Agent Control Plane**，其中 Room 与 Bot 是两种独立运行域，共用身份、连接、事件与权限协议，但不共享执行模型。平台内对话和外部 IM 是同一 Bot/Room 的平等入口，用户从任一端都能直接对话、派工、查看与审批：

| 产品面 | 核心职责 | 运行方式 | 用户角色与视图 |
|---|---|---|---|
| Agent Room（人机群聊） | Agent 自主邀请、分工、协作、交接和验收，类似人类团队群 | 用户或 Agent 发起；成员持续推进；用户可观察、随时插话、@Agent 派工 | 用户是管理者/查看者：目标、群消息、任务、进度、证据与验收 |
| Agent Bot（SuperAgent 电脑管家） | 持久身份与记忆、全局能力治理、Agent/Runtime 生命周期、目标监督与恢复 | 平台内直接使用，或绑定 IM；控制面常驻、推理/执行按需唤醒 | 当前意图、Agent/Runtime 状态、能力授权、监督事件、记忆与待决策事项 |

入口统一为：

```text
平台内直接对话 ─┐
                ├→ Conversation Gateway → 同一 Bot / Room / Workflow / Task
IM 对话/操作 ───┘
```

- 平台内对话不是 IM 的控制台副本，IM 也不是平台对话的附属通知；两者通过相同命令、事件和权限模型操作同一对象。
- 平台内可与 Bot 单聊，也可直接进入 Room 与所有 Agent 对话；外部 IM 可绑定 Bot 单聊或某个 Room。
- 同一用户在平台与 IM 的身份可关联，任务和群消息跨入口同步；每个入口可配置摘要密度，但不能生成互相矛盾的状态。

需要明确八个边界：

1. **群聊不是共享一个巨大 prompt。** 群消息是独立存储、按需读取的信息层；每个成员保留独立的会话和压缩检查点，群协作信息全群共享。
2. **Agent 定义、Agent 成员身份和 Agent 执行实例分离。** 一个平台 Agent 可以同时参加多个工作流，但同一时刻对同一执行实例只运行一个 turn。
3. **Room 是共享协作空间；Bot 是持久控制面。** Room 可以有 Workflow/Task，Bot 不依赖这套模型运行，而是维护 Agent Identity、Session、Memory、Task Journal、Policy 和 Runtime Instance。
4. **Bot 长期运行不等于永久调用模型。** Gateway/状态存储常驻，Supervisor/Agent Runtime 按需唤醒；所有状态与恢复边界必须持久化。
5. **平台直聊与 IM 都是 Bot 的双向入口。** 外部 IM 消息先持久化、快速 ACK，再异步执行；两个入口都能对话、查看进度、审批、接收结果和管理同一任务。
6. **Room 默认是扁平共享工作区，不预设分级。** 一个群主 Agent 负责分派和验收，其他成员可动态认领、交接、邀请协作者；所有群成员和用户都可以读取群内进度。
7. **Bot 是电脑级 SuperAgent 管家，不是群主或 Workflow 执行器。** 它管理本机 Agent Registry、连接配置、会话、运行资源和意图，可按需调用 Room 协作，也能直接完成简单任务。
8. **用户拥有目标与授权，Agent 拥有协作推进职责。** 用户不必逐步盯着过程，可以只提出目标与验收标准；Agent 们持续协作直到完成、需要决策或触及约束。

不建议继续沿用“协调者先跑若干轮，再把摘要塞回普通聊天”的主路径。现有能力可以复用，但产品主模型需要升级为：

```text
平台内对话       飞书 / 企微 / Slack / Telegram     定时/Agent 事件
     │                         │                            │
     ▼                         ▼                            │
┌────────────┐         ┌───────────────┐                   │
│ App Gateway│         │ IM Gateway    │ 验签、身份、去重、ACK
│ 直接对话   │         │ + Outbox      │ 异步发送、回执、重试
└─────┬──────┘         └──────┬────────┘                   │
      └───────────┬───────────┘                            │
                  ▼                                        ▼
       ┌────────────────────────────────────────┐
       │ Conversation / Intent Router           │
       │ 平台/IM 入口、持久消息与幂等           │
       └───────────────────┬────────────────────┘
                ┌───────────┴────────────┐
                ▼                        ▼
       ┌──────────────────┐    ┌──────────────────────┐
       │ SuperAgent Bot   │    │ Agent Room           │
       │ Identity/Memory  │    │ Shared Messages      │
       │ Policy/Journal   │    │ Workflow/Handoff     │
       │ Wake/Sleep/Recover│   │ 用户+Agent 协作      │
       └─────────┬────────┘    └──────────┬───────────┘
                 │       可按需创建/加入   │
                 └───────────┬────────────┘
                             ▼
       ┌──────────────────────────────────────┐
       │ Agent Runtime + ACP/CLI Drivers      │
       │ 会话、权限、并发、恢复、事件路由     │
       └──────────────────────────────────────┘
```

## 2. 现状与保留资产

当前实现不是从零开始：

- Rust 已有群成员独立会话标识：`run_native_group_member()` 使用 `group-{groupId}-{memberKey}`，见 `harness-rs/crates/core/src/dispatcher.rs:3199`。
- 已有 `message_agent`、`read_board`、`update_board`、`reply_to_user`，以及递归深度、超时和祖先链死锁检查，见 `harness-rs/crates/tools/src/group_tools.rs:12`、`harness-rs/crates/core/src/dispatcher.rs:2916`。
- 已有共享黑板、任务 owner、HITL 注入和分批并发，见 `harness-rs/crates/group/src/lib.rs:219`。
- 子 Agent 已创建独立 conversation，并继承受限工具集合，见 `harness-rs/crates/core/src/subagents.rs:77`。
- 长期目标已有定时、复盘、记忆、干预和 schedule 同步；这些可以作为 Bot 的策略与展示资产保留，见 `apps/electron/src/main/long-term-goals/long-term-goal-service.ts:1467`。
- 已有飞书、微信、企微、Slack、Discord、Telegram、自定义 Webhook 的标准化事件、验签和出站发送能力，见 `apps/electron/src/main/im/channel-binding-store.ts:11`、`harness-rs/crates/im-gateway/src/model.rs:242`。ChannelBinding 已有会话、群组、默认 Agent 和项目绑定，可增加 Bot 绑定而不用另建一套 IM 配置。

需要改变的主要是：

- 每轮提示仍拼接最近 6 条全员发言和整张黑板，见 `harness-rs/crates/group/src/lib.rs:643`。这只能叫“独立 conversation”，还没有清晰的“独立执行上下文 + 全群共享消息读取游标”。
- 桌面和绑定群聊的 IM 复用 `apps/electron/electron/main-process/ai/native-rust-room.ts` 的点名投递；后续轮次只由明确的交接和补充说明触发，不另跑协调人汇总。
- `Hub.group_sessions` 主要是内存状态，不能作为长期 Bot 和跨平台工作流的唯一事实来源，见 `harness-rs/crates/core/src/hub.rs:69`。
- 现有长目标是定时任务的解释器，不是拥有任务图、租约、事件循环和验收状态机的控制器。
- 当前 provider 配置不等于外部 Agent Runtime。模型兼容不代表具备进程管理、原生子 Agent、工具事件和会话续接能力。
- 当前 IM 主路径在一个 Webhook 请求里等待 `generateReply()` 完成，再返回回复，见 `apps/electron/src/main/im/im-gateway-service.ts:278`、`apps/electron/electron/main-process/ai/im-replies.ts:14`。持续 Bot 不能沿用这个阻塞边界：长任务会超时、重试产生重复任务，也不能主动推送进度和审批。

## 3. 统一领域模型

### 3.1 身份和动态职责

```text
AgentDefinition          平台内人设、默认 provider/model、工具与记忆策略
AgentConnectionProfile   本机 ACP/CLI 连接配置、可执行文件与默认权限
AgentRegistryEntry       电脑内已发现/已接入 Agent、能力、状态与授权范围
AgentMember              加入 Room 的稳定身份，绑定 profile 和平台 sessionId
AgentExecution           一次工作运行，绑定进程、事件游标、lease 和 generation

SuperAgent Bot（持久控制面）
 ├── Identity / Intent / Journal / Policy / Memory
 ├── RuntimeInstance / Generation / CapabilityBroker
 └── AgentRegistry / RoomRunRef / Recovery

Room
 └── Workflow（leadAgentMemberId）
      └── Task（assignee / reviewer / handoff）
           └── AgentExecution
```

- `AgentDefinition` 是“谁”；`AgentConnectionProfile` 是“通过哪个 ACP/CLI 运行”；`AgentMember` 是“在这个群里负责什么、延续哪个平台会话”；`AgentExecution` 是“这一次怎么跑”。
- `Bot` 是独立 SuperAgent 身份，不等同于 `AgentMember`；若需要进入 Room，可为其创建一个普通成员投影，但其控制面状态仍独立。
- `AgentRegistryEntry` 是电脑管家的资源视图：包括平台内 Agent、已安装 ACP/CLI、可恢复平台会话、当前 execution、健康状态和授权策略；`AgentMember` 是某个 Room 中的协作身份，二者不混用。
- 群内没有固定 Controller/Manager/Worker 层级。`lead` 是当前 Workflow 的协调职责，`assignee` 是任务执行职责，`reviewer` 是验收职责；同一 Agent 可在不同任务承担不同职责。
- 群主 Agent 可以邀请新成员、分派任务、请求交接和组织验收。普通成员可发布进度、建议分工、认领可认领任务或申请邀请其他 Agent；涉及权限、预算和新增本机执行的动作由 Control Plane 校验。
- `TaskDependency` 只表达工作先后与数据依赖，不表达管理上下级。`Handoff` 把任务上下文、当前状态、证据和下一步公开写入群内，由新 assignee 接续。
- 同一个成员身份可跨轮续聊；支持 resume/sessionLoad 的驱动在新 `AgentExecution` 中恢复其平台会话，不每轮重建身份。进程退出只终止 execution，不删除 member。

### 3.2 独立执行上下文与全群共享信息

| 数据 | 存储位置 | 进入模型上下文的方式 |
|---|---|---|
| 群消息 `RoomMessage` | 独立 room stream，带 seq、作者、可见范围、关联任务 | 注入当前触发消息；其余通过 `room_read_messages` 按游标/过滤读取 |
| 成员执行上下文 | 每个 `AgentMember` 独立 conversation + checkpoint | 该成员后续 turn 自动续接；群信息单独共享，不合并各成员的模型上下文 |
| 协作事实 | Task、Decision、Artifact、Evidence、Acceptance | 只注入当前任务和必要摘要；完整内容通过工具读取 |

具体规则：

1. 平台内成员保留现有独立 conversation；外部成员由原平台保存其 native session，WorldBase 只保存引用和必要的审计镜像。
2. 群消息不直接 append 到每个成员的执行上下文。否则读取游标、撤回、压缩和跨平台同步都会失去边界。
3. **群内用户消息、Agent 发言、进度、交接、决策和验收结果默认对所有成员可见。** 每个 Agent 都能通过 `room_read_messages` 读取这些共享信息；IM 只展示用户需要的摘要。
4. 用户可随时发言。消息立即持久化并通知群主 Agent，正在执行的任务在下一个安全检查点获得更新；紧急停止走确定性控制命令，不等待模型读完消息。
5. “所有人可见”不等于“所有消息都同步唤醒所有人”。群主 Agent 接收用户消息和关键状态；普通 Agent 遇到 @提及、任务分派、交接、依赖完成或显式响应请求时才被唤醒，其余消息通过游标按需读取。
6. 新 turn 只注入任务书、触发消息、未读 @提及、最新任务状态和相关交接摘要。Agent 可继续读取完整群消息；不默认把整段群历史反复塞入每次 prompt。
7. 每个成员保存 `roomReadCursor`。调用 `room_read_messages(afterSeq, taskId, senderId, mentionsMe, limit)` 后推进游标，支持分页和增量读取。
8. 独立上下文不等于信息隔离：成员的公开结论、进度、交接、证据、工具/命令摘要和验收结果必须发布到群内，所有 Agent 均可读取；只折叠无协作价值的逐 token 推理和重复输出。用户可在成员现场查看完整受权审计记录。
9. 长期记忆与上下文分开：Task/Evidence 是工作事实，Memory 是跨任务经验；不得把旧记忆当作当前用户指令。

### 3.3 消息与任务分离

`RoomMessage.kind` 至少包括：

```text
user | agent | mention | task_assignment | task_update | handoff | question
approval_request | evidence | decision | acceptance | system
```

任务不能只是一段聊天文本。统一结构建议：

```ts
interface WorkTask {
  id: string
  roomId?: string
  workflowId: string
  title: string
  specRef: string
  assigneeMemberId?: string
  reviewerMemberId?: string
  createdByMemberId: string
  status: 'draft' | 'blocked' | 'ready' | 'leased' | 'running'
        | 'submitted' | 'verifying' | 'changes_requested'
        | 'awaiting_user' | 'done' | 'failed' | 'cancelled'
  dependencyIds: string[]
  readScopes: string[]
  writeScopes: string[]
  acceptance: AcceptanceCheck[]
  canRequestHelp: boolean
  budget: { maxTokens?: number; maxCost?: number; deadlineAt?: string }
  attempt: number
  lease?: { executionId: string; expiresAt: string; generation: number }
  resultArtifactIds: string[]
  latestHandoffId?: string
}
```

- 使用 DAG 表达依赖，不以“群聊第几轮”表达执行顺序。
- `ready/running/submitted/done` 是机器状态；聊天只是这些状态的可读投影。
- assignee、write scope 和 lease 都由服务端校验，不能只依赖 prompt 中的“不要越界”。
- 同一时刻只有一个 execution 持有任务写 lease。心跳过期后可重派，`generation` 防止旧实例迟到提交覆盖新实例。
- 交接采用显式 `Handoff`：包含 taskId、from/to、状态、做了什么、证据、未完成项、建议和群消息引用。原 assignee 释放 lease 后，新 assignee 才可继续执行。

## 4. Room：从讨论器到管理与验收场所

### 4.1 像人类团队一样协作

- 用户提出目标、限制条件和验收标准后，可以持续查看，也可以离开等待结果；不是必须由用户逐轮点名推动。
- 群主 Agent 负责把目标拆成任务、邀请合适 Agent、维护优先级和节奏；普通 Agent 可提出建议、认领任务、请求帮助、邀请协作者、公开交接和互相检查。
- 用户 `@Agent` 是显式高优先级任务请求：生成定向消息和任务/子目标，由被点名 Agent 确认接单、报告计划并推进；其他 Agent 仍可读取和提供协助。
- Agent 之间可直接 `@` 对方请求评审、补充信息或接管任务；被点名者可以接受、说明冲突或请求重新分派。不能无限互相委派，所有承诺都落到 Task/Handoff。
- 完成不是“最后一个人发言结束”，而是目标对应任务全部通过验收、证据齐全、没有未解决的阻塞；否则群主 Agent 持续安排下一步或请求用户决策。
- 用户始终可以插话、改变优先级、补充约束、重新指派、暂停或停止；新的用户意图优先于群内旧计划，但已发生的副作用必须如实保留并纳入后续计划。

### 4.2 群主 Agent 是协调者，不是上级运行时

Room 主控拥有以下确定性工具：

```text
room_read_messages / room_post_message
room_invite_agent / room_update_member / room_list_members
workflow_create / workflow_get / workflow_cancel
task_create / task_assign / task_claim / task_handoff / task_accept / task_request_changes
agent_invite / agent_send / agent_wait / agent_read / agent_stop
artifact_list / evidence_attach / acceptance_run
```

这些工具调用 Control Plane，不直接拼字符串操作终端。

一次典型工作流：

1. 用户从平台内对话或 IM 给出目标和约束，也可直接 `@Agent` 指派；群主 Agent 生成 `SPEC`、验收项和预算，必要时请求用户确认。
2. 群主 Agent 建立任务 DAG，标记 read/write scope、依赖和 assignee。
3. 群主 Agent 或其他获授权成员可从本机 Agent Registry 拉 Agent 入群；成员可以在群里建议调整分工、认领任务、申请协作或请求交接。
4. Runtime 给各 Agent 发送任务书。平台内 Agent 使用自己的会话；ACP/CLI Agent 使用 WorldBase 创建并登记的原平台会话。
5. 每个成员把开始、阶段进度、阻塞、交接和提交发布到群里；所有成员和用户都能读取。用户随时发言，由群主 Agent 结合当前任务判断如何调整。
6. 成员提交后任务进入 `submitted`，并不直接变成 `done`。
7. 群主 Agent 或任务 reviewer 执行验收；失败则创建只含缺口的返工任务，成功才进入 `done`。
8. 若目标未达成，继续生成下一步、补充 Agent、交接或返工；只有完成、用户暂停或遇到必须决策的阻塞才停止主动推进。
9. Room 展示验收报告、实际改动、证据和未完成项。执行现场默认保留，归档后才回收资源。

### 4.3 管理方法与群内交接

| “放羊了”纪律 | 产品化实现 |
|---|---|
| 每项工作有任务文件 | 不可变 `TaskSpec` + `specRef`，版本化保存 |
| write scope、热文件单负责人 | 任务 lease + 路径声明 + 写工具运行时校验/冲突告警 |
| 可并行分工 | 扁平任务 DAG、任务 assignee、显式依赖与群内交接 |
| 统一验收 | `submitted → verifying → done/changes_requested` |
| 不达标只返工缺口 | 新 attempt 引用验收失败证据，不重发整个项目 |
| 保留执行现场 | execution/session 默认保留，显式归档后才停止 |
| agent 不 commit/push | 工具策略和 endpoint capability 双重限制 |
| 权限与跨 workspace 隔离 | 授权 scope、workspaceId、项目根目录绑定 |

群主 Agent 可以随工作流变化把 lead 职责交给另一成员；交接记录公开入群。这里只有任务责任和交接，没有 Manager 下级圈、递归层级或独立管理层。

第一期不建议在共享工作区强造“文件锁即绝对安全”。声明与检测可以先落地；真正并行写同一仓库时，后续用每 execution 独立 worktree/分支隔离，再由群主 Agent 集成。禁止自动提交、推送或擅自清理用户改动。

### 4.4 群 UI 分为四个视图

1. **消息**：用户和 Agent 的公开交流、进度、@提及、问题、交接和决策；工具噪声折叠。
2. **任务**：DAG、assignee、状态、依赖、预算、返工次数；这是主管理视图。
3. **成员现场**：平台、模型、在线/等待/执行/阻塞、当前任务和最近进度；进度、工具/命令摘要与证据公开入群，完整执行审计可供用户查看。
4. **验收**：SPEC 版本、产物、命令与结果、证据、差距、用户批准和审计记录。

成员卡片应明确“平台 Agent”和“WorldBase Agent”，并显示当前 assignee/reviewer/lead 职责，避免把 provider 名称误当成独立 Agent。

## 5. 本机与跨平台 Agent 接入

### 5.1 自有编排边界

**编排、成员管理、任务 DAG、审批、消息路由、预算和验收全部发生在 WorldBase。herdr 不是依赖、不是执行后端、不是适配器，也不参与会话发现。**

WorldBase 只把外部平台当作 Agent 执行器：

- **ACP 优先**：由 Electron 启动受管子进程，通过 stdio JSON-RPC 协商协议，创建/加载 session、发送 prompt，接收 session update 和权限请求。ACP 提供传输与会话原语，不提供我们的 Workflow/Room/Bot 编排。
- **CLI 兜底**：通过明确版本的 argv、环境、工作目录和输出协议运行各平台 CLI；优先使用结构化 JSON/JSONL、session ID、resume 和 machine-readable approval。仅支持一次性文本输出的平台降级为单次 Worker，不能伪装成持久会话。
- **不允许间接控制**：不读取 herdr 数据库、不调用 herdr API/CLI、不依赖其 workspace/tab/pane，也不通过屏幕 OCR 和终端按键模拟 Agent 编排。
- **平台差异隔离在 Driver 内**：Room、Bot、任务图和验收只依赖统一 AgentRuntime 接口，不出现平台专用分支。

### 5.2 统一 Agent Driver 协议

```ts
interface AgentDriver {
  probe(profile: AgentConnectionProfile): Promise<DriverCapabilities>
  create(spec: ExecutionSpec): Promise<AgentExecution>
  resume(spec: ResumeExecutionSpec): Promise<AgentExecution>
  send(executionId: string, input: AgentInput): Promise<void>
  events(executionId: string, afterSeq?: number): AsyncIterable<AgentEvent>
  snapshot(executionId: string): Promise<AgentSnapshot>
  wait(executionId: string, until: WaitCondition[]): Promise<AgentStatus>
  respondToApproval(executionId: string, requestId: string, decision: ApprovalDecision): Promise<void>
  stop(executionId: string, graceful: boolean): Promise<void>
  close(executionId: string): Promise<void>
}

interface DriverCapabilities {
  persistentSession: boolean
  resume: boolean
  transport: 'acp' | 'cli_jsonl' | 'cli_text'
  sessionLoad: boolean
  structuredEvents: boolean
  cancellation: boolean
  toolApproval: boolean
  fileChangeEvidence: boolean
}
```

`AgentConnectionProfile` 保存用户显式配置的可执行文件绝对路径、参数模板、工作目录、环境变量引用和平台类型；不接受群消息或 IM 用户直接提供任意命令行。`AgentExecution` 保存 WorldBase execution ID、memberId、driver、PID/child handle、平台 session ID、cwd、generation 和事件游标。持久化记录不保存 PID 对应的直接控制权，恢复时必须重新校验 session 与进程身份。

标准化 `AgentEvent` 包括 `started/delta/tool_started/tool_finished/message/status_changed/approval_requested/artifact/completed/failed/heartbeat`。原平台事件可保留在 raw payload 中，但控制面只依赖标准事件。

### 5.3 首批接入顺序

1. **WorldBase Adapter**：直接复用 Rust Agent Loop、conversation、tools 和权限；支持原生 `spawn_subagents`。
2. **ACP Runtime**：基于官方 ACP 协议/SDK 实现通用连接、initialize、session new/load、prompt、update、permission、cancel；接入一个平台并跑通后，再按实际协议测试结果扩展其他平台。协议参考：[agentclientprotocol.com](https://agentclientprotocol.com/) 与 [agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol)。
3. **CLI Drivers**：按平台配置独立的非交互命令模板和输出解析器。支持 session/resume 的 CLI 可续聊；不支持者每次任务新建 execution，并由 WorldBase 注入有界上下文。

群成员需要其他 Agent 协助时，不直接自行创建不可见的本机执行树，而是返回结构化 `InviteRequest`：

```text
群成员 → InviteRequest(workflowId, capability, taskSpec, scopes, budget)
       → WorldBase 校验 Room 权限、并发和预算
       → 群主 Agent 确认分工；高风险邀请请求用户确认
       → WorldBase 选择 ACP/CLI Driver 创建 AgentMember 和会话
       → 新成员加入同一 Room，任务、进度、交接和结果对全群可见
```

不支持工具回调的 CLI 可在最终结果中输出带 schema 的 `InviteRequest`，由 Runtime 验证后执行；不能将文本请求等同于已邀请。新成员通过群消息游标读取当前目标、任务、进度和交接，不复制邀请者的整份模型上下文。平台内部若私自创建未登记进程，WorldBase 不把它算作受管成员，也不对其声明“可控/已验收”。

### 5.4 配置、接入与安全

- 本机接入页提供平台预设和用户自定义连接配置；`probe` 检测可执行文件、版本、认证状态和协议能力。任意 CLI 的存在只代表“可能可运行”，不代表已支持。
- 拉取本机 Agent 进群指 **从已配置的 ACP/CLI profile 创建或恢复一个受管 session**，不是枚举、attach 或接管其他应用的终端进程。已有平台 session 只有在协议明确支持 load/resume、用户显式选择后才恢复。
- `AgentExecution` 绑定 WorldBase workspaceId、cwd、平台 session ID 和进程身份；跨 workspace、跨用户和跨项目访问必须由 Control Plane 拒绝。
- 邀请时可选择平台、模型、角色、工作目录和权限；每个平台显示 `probe` 返回的实际 capability，不支持的能力在 UI 禁用。
- 执行进程由 Electron Host Runtime 管理，包括本机 subprocess、ACP transport、CLI stdout/stderr、进程组取消与权限转发；Rust 通过带 run-scoped capability token 的 versioned host tool/bridge 发出标准命令，不在 `worldbase-core` 里硬编码 macOS 进程逻辑。Host Runtime 校验该 token 对应的 profile、任务和权限，不能仅凭调用方声称的 taskId 启动任意可执行文件。
- API key、平台 token 不进入群消息、任务书或日志。事件镜像过滤命令行 secrets 和本机绝对路径。
- 外部 Agent 的权限由“WorldBase 任务策略 ∩ 原平台权限”决定，WorldBase 不能借 Driver 扩大原平台权限。ACP/CLI 审批由 Runtime 归一化为 ApprovalRequest，并路由到正确的 execution，不能由主控静默代替用户放行。
- 对无结构化权限事件的平台，WorldBase 只能施加进程、目录和任务策略等外层约束，不能声称能拦截 Agent 内部的每次工具调用；continuous 模式默认不启用这类平台。

## 6. Bot：长期目标的下一代运行模型

### 6.1 SuperAgent 电脑管家，而非任务派发器

Bot 管理的是**整台电脑内已接入的 Agent 身份、能力和运行时**。Room 的 Task DAG 不是 Bot 的基础数据模型，Bot 也不承担群主职责：

```text
Platform / IM Gateway（常驻）
   → Durable Identity：user binding、persona、session、memory、workspace
   → Intent & Policy：意图、权限档案、策略版本、预算、approval
   → Task Journal：持久意图、执行记录、幂等键、决策与通知引用
   → Lifecycle Manager：ABSENT/WAKING/READY/BUSY/SLEEPING/FAILED
   → Host Capability Broker：按当前能力与策略授予受控工具/运行时
   → Agent Registry & Runtime Supervisor：发现、选择、健康、恢复
   → Supervisor Turn（按需）：理解、直接处理或调用能力/Room
```

- 用户一次授权 Bot 成为默认电脑 Agent 管家后，自动发现支持的平台安装、版本、认证状态和可恢复会话，纳入 Registry；可在统一界面选择平台、查看状态、授权范围和停用。
- Bot 是持久逻辑身份，不是进程或模型会话；其 persona、记忆、授权与 Journal 在进程退出、模型切换、ACP/CLI 重启后保持连续。
- Bot 可直接回答、调用本机 Agent，或把需要多人协作的意图委派给一个 Room；Room 返回可观察执行句柄和事件流，不是 Bot 的内部任务模型。
- Bot 始终负责用户绑定、策略、能力准入、代次隔离、恢复和最终通知；Room 内部的 lead、分工、交接和验收由 Room 自主管理。
- 用户后续消息先与持久身份和当前意图对账，再决定续聊、打断、等待或新建意图；不需要用户不断发送“继续”。
- 启动电脑或应用后恢复持久身份和 Journal；需要无人值守时提供显式“登录后启动”选项，之后可增加受限后台服务。第一版不承诺关机/系统休眠时继续执行。

“接管所有 Agent”的准确边界是：**发现所有支持的平台，统一注册所有可用 Agent，并管理已授权/已接入的 Agent、session 和执行实例。** 不注入或劫持用户正在使用的其他应用进程；无法通过 ACP/CLI 安全恢复的已有终端只显示为未接管资源，不宣称可管理。

### 6.2 参考 DeepSeek SuperAgent：持久身份与可替换运行时

这里采用 DeepSeek SuperAgent 参考设计的核心，而不是照搬其微虚拟机实现：**平台/IM Gateway 与 Control Plane 常驻，Agent 身份、会话、任务日志与记忆持久化；Bot 管家和各 Agent Runtime 按需唤醒、可重建。**

当前核对到的参考实现：[super-agent-bot-plantform](https://github.com/LeonQin-ai/super-agent-bot-plantform)，其[架构](https://github.com/LeonQin-ai/super-agent-bot-plantform/blob/main/docs/architecture.md)明确分离 Agent identity 与 disposable runtime，并采用飞书长连接、按需 Worker 和 cold sleep；其[持久执行](https://github.com/LeonQin-ai/super-agent-bot-plantform/blob/main/docs/durable-execution.md)采用先入队、幂等、取消和恢复语义。本项目参考这些边界，不声称已具备其沙箱能力，也不将该第三方实现当作 DeepSeek 官方规范。

对应到 WorldBase，SuperAgent 的必要组成是：

| SuperAgent 模式 | WorldBase 落地 |
|---|---|
| 常驻 Gateway/Control Plane | Electron Host + Rust Orchestrator；平台/IM 接入与事件入库常驻 |
| 持久 Agent identity | Bot/Member/Session/Task Journal/Memory/Workspace/Policy 独立保存 |
| 按需 Supervisor | 有消息、任务完成或定时事件时唤醒 Bot controller turn |
| Disposable Worker | 平台内 Agent Run、ACP/CLI 子进程，可按需启动和回收 |
| Cold sleep | 无执行、回调、上传和未提交事务时休眠，仅保留身份与任务日志 |
| Runtime generation | Bot/execution generation fencing，迟到事件和旧实例不能覆盖新状态 |
| Host capability broker | Electron 管理本机 ACP/CLI 进程、权限与 IM 网络，不交给 Agent 任意主机能力 |

**明确不借鉴“放羊了”的部分**：不是预拆任务、多只 Agent 并行、主控收割的循环；不要求 Bot 建 Room；不将 Workflow DAG、write scope 或群内验收当作 Bot 运行前提。它们仅是 Room 域的可选协作机制。

#### 生命周期与代次

```text
Identity:  ACTIVE ───────────────→ SUSPENDED / ARCHIVED
                │
Runtime: ABSENT → WAKING → READY → BUSY → SLEEP_PENDING → SLEEPING
                   │         │       │           │
                   └─────────┴───────┴───────────┴→ FAILED → ABSENT
```

- Identity 与 Runtime 状态分开存储。`SLEEPING` 只表示没有活跃执行运行时，Bot 仍可接收消息和持久化意图。
- `BeginWake` 在单事务中分配单调递增 generation；并发唤醒复用同一 WAKING/READY 实例。迟到 Ready、旧 runtime 事件和旧审批不得修改新代次。
- 收到消息时先持久化 Inbox/Journal，再确保 runtime ready；不能直接创建第二个 supervisor 处理相同身份。
- Cold sleep 前确认无运行中 execution、tool callback、上传、未提交事务或未持久化记忆；先写 session/memory/journal，再销毁运行时。

#### 能力与信任边界

- `CapabilityBroker` 在每次执行前读取当前策略和实时 ACP/CLI capability，而不是使用永久授权或历史探测结果。
- Bot 仅获得受限的编排/管理能力，不自动获得任意主机 shell。文件、进程、IM、审批等能力分别授权、分别审计。
- 主模型上下文不包含平台密钥、credential 或管理 socket；Driver/Host Runtime 使用短期 capability handle 调用。
- 执行后端不可信或 capability 不满足时拒绝/降级，不为了完成意图自动放宽隔离和权限。

本地单机第一版只保证 **single-owner SQLite**：同一个数据库只有一个活动 Control Plane writer。多设备/多实例 owner 后续再加，不把内存锁误当成分布式锁。

### 6.3 平台与 IM 的会话绑定

扩展现有 `ChannelBinding`：

```ts
interface BotChannelBinding extends ChannelBinding {
  boundBotId?: string
  boundRoomId?: string
  conversationMode: 'per_user' | 'per_channel' | 'per_thread'
  activation: 'always' | 'mention' | 'command'
  allowedSenderIds: string[]
  allowedChannelIds: string[]
  requirePairing: boolean
  progressPolicy: 'milestones' | 'completion_only' | 'verbose'
  replyTarget: 'origin_thread' | 'fixed_thread'
  interactiveApprovals: boolean
  deliveryMode: 'legacy_sync' | 'bot_async'
}
```

- 平台内 `AppConversation` 可直接绑定 `botId` 或 `roomId`，无需 ChannelBinding；平台与 IM 通过统一 `ConversationBinding` 指向同一对象。
- IM 首选 `boundBotId`；`boundConversationId/boundGroupId/defaultAgentId` 保留为旧自动回复模式，迁移时不重复消费同一消息。
- `externalIdentityKey = connectorType + applicationId + channelId + senderId`，`conversationKey` 再按 conversationMode 加 threadId。**同一个外部会话始终复用同一 Bot identity/session，不因每条消息新建 Agent。**
- Bot 维护一个稳定的 supervisor conversation；不同外部会话用独立 `BotConversation` 保存最近对话和上下文摘要。跨会话共享仅来自显式目标和记忆，不混入其他用户私聊。
- 飞书第一期优先 **WebSocket 长连接**，不要求用户把桌面端口直接暴露到公网；Webhook 作为兼容入口。Slack 可选 Socket Mode，其他平台按 connector 能力逐个小步接入。
- 群聊默认 mention/command 才唤醒，私聊可 always；未经授权的 sender 只收到配对提示或忽略，不能通过 prompt 获得本机管理能力。
- 平台与 IM 原消息都可映射成 RoomMessage，或直接作为 Bot supervisor 消息。不是所有内部 Agent 消息都转发到 IM；平台可查看完整群进展，IM 默认发送用户需要的摘要。

### 6.4 入站快速 ACK，出站可靠投递

```text
平台对话或 IM message/action
  → connector 验签、解析、sender/channel 授权
  → INSERT inbox（sourceId + externalMessageId 唯一；平台本地事件同理）
  → 平台流式展示任务受理；Webhook 返回 ACK/challenge/success；长连接确认接收
  → 各入口都不阻塞等待完整长任务完成
  → 匹配 BotConversation，创建或追加 Workflow
  → Bot 处理并发布 BotNotification / ApprovalRequest
  → Bot 继续调度，不等待实际 IM 发送完成
  → Outbox 持久化待发送内容
  → 平台 UI 订阅事件，或 IM Connector 发送并保存 externalReplyId
  → 成功后标记 delivered；失败指数退避；重启继续投递
```

- `Inbox` 在收到有效消息后先落库，重复平台事件返回已有任务/处理结果，不重复创建 Workflow。
- ACK 不等于任务完成。可在 ACK 后异步发送“已接收，任务 #123”，最终结果和关键里程碑通过 Outbox 主动推送。
- 微信/企微同步 XML 只用于即时短回复；长任务必须在平台限制内立即 `success` 或短 ACK，并使用合规的客服/应用消息通道异步发送。未配置主动发送能力时明确降级为“下次消息拉取结果/桌面查看”，不能假装已送达。
- 飞书、Telegram 走应用 API 回复或发送；Slack/Discord 可回 thread。回复目标绑定到原始 channel/thread，不随意跨频道广播。
- `Outbox` 按 `dedupeKey` 去重，记录 attempts、nextAttemptAt、lastError、providerMessageId。发送成功但回执丢失可能产生平台重复消息，因此不宣称端到端 exactly-once；关键状态消息优先支持平台 edit/update，而非不停追加。
- 消息按长度、Markdown、附件、按钮/卡片能力做 connector-specific rendering。模型产生统一 `BotNotification`，不直接拼接平台 API。
- `ApprovalRequest` 用一次性 action token 绑定 `approvalId + actorId + generation + expiresAt`；平台按钮和 IM 按钮共用相同校验，点击只提交决策事件，执行前再次校验当前任务状态，不能拿旧按钮重复批准。

### 6.5 平台与 IM 中的 Bot 交互

自然语言任务为主，斜杠命令只提供确定性控制入口：

| 命令 | 作用 |
|---|---|
| `/new <goal>` | 新建目标/工作流，不复用旧任务上下文 |
| `/status [id]` | 查看当前任务、运行成员、预算、下一步 |
| `/tasks` | 查看该外部会话可管理的任务 |
| `/approve <id>`、`/deny <id>` | 处理权限、计划或验收审批 |
| `/pause`、`/resume` | 暂停/恢复 Bot 的新任务准入；运行中停止另有明确语义 |
| `/stop <taskId>` | 请求取消指定任务及其子执行树 |
| `/agents` | 查看该用户获授权的本机 Agent，不泄露其他用户/终端 |
| `/accept <taskId>`、`/rework <taskId> <gap>` | 用户验收或提出返工差距 |

典型交互：

```text
用户（飞书）：继续优化这个项目，完成后帮我验收
Bot：已创建任务 #123，将调用 2 个本机 Agent；当前预算/权限为……
Bot：后端已完成，前端执行中；[查看摘要]
Bot：需要授权安装依赖 [批准] [拒绝]   ← 原会话内审批
Bot：验收未通过，已返工：缺 2 项错误处理测试
Bot：任务 #123 已完成；测试 42 项通过，产物/报告见……
```

IM 不转发所有 token 和工具调用；默认 `milestones` 只报告任务创建、重要状态变化、阻塞、审批、验收和最终交付。每个通知带可追踪 `workflowId/taskId/eventSeq`，桌面端打开同一工作流继续管理。

### 6.6 SuperAgent 事件循环：常驻身份、有限 Supervisor turn

Bot 不是一次永不结束的 `chat.send`，也不是 Room 的任务 DAG loop：

```text
启动/恢复
  → 校验 single-owner、恢复 Identity/Journal/Outbox
  → reconcile RuntimeInstance：代次、进程、session、未完成清理
  → Gateway 接收消息/定时/Runtime 事件，持久化 Inbox 与 Journal
  → LifecycleManager.ensureReady(identityId, generation)
  → CapabilityBroker 获取当前策略、能力快照与授权
  → 运行一次有界 Supervisor turn
       ├─ 可直接回答：写回复和记忆候选
       ├─ 需本机 Agent：创建受管 runtime/session，订阅事件
       ├─ 需协作：调用 Room capability，保存 roomRunRef
       ├─ 需用户：登记 approval/question，保持身份可唤醒
       └─ 需等待：保存 intent/continuation，不空转推理
  → 追加 Journal、持久化 session/memory、发送通知到 Outbox
  → 无活跃运行时则 cold sleep；否则等待下一事件
```

- **持久的是 Identity、Journal、Policy、Session/Memory 引用、Runtime 记录和事件游标，不是一个永不压缩的 LLM 请求。**
- Supervisor turn 必须有 step/token/cost/deadline 上限；长生命周期由多个按需 turn 组成。
- Runtime 事件驱动 continuation：进程退出、会话更新、Room 通知、审批结果和 schedule 都追加事件，再唤醒相应身份。
- Bot 不重复实现 Room 的任务分派、验收和返工；它只观察 Room capability 的状态与最终通知，并处理资源、授权和恢复。
- Cold sleep 前必须完成 Inbox 持久化、session checkpoint、Journal、记忆写入和通知入 Outbox；无执行、工具回调、上传和未提交事务。休眠的是 Runtime，Gateway/Outbox 继续工作。
- 若电脑关机/休眠，离线消息由平台或 connector 恢复后拉取/去重；桌面运行时不承诺服务器级在线 SLA，UI 明确显示“离线，恢复后继续”。

### 6.7 Bot 策略

```ts
interface BotPolicy {
  identityId: string
  defaultIntent?: string
  targetProjectIds: string[]
  allowedRoomIds: string[]
  managedConnectionProfileIds: string[] | 'all_registered'
  autoDiscoverLocalAgents: boolean
  defaultRoomId?: string
  channelBindingIds: string[]
  autonomy: 'suggest' | 'managed' | 'continuous'
  maxConcurrentExecutions: number
  idleSleepAfterSeconds: number
  budgets: { perSupervisorTurn?: Budget; perIntent?: Budget; perDay?: Budget }
  schedule?: Schedule
  approvalPolicy: ApprovalPolicy
  memoryPolicy: MemoryPolicy
  runtimePolicy: RuntimePolicy
}
```

- `suggest`：只规划，不自动执行。
- `managed`：可执行已授权工作，创建新 Agent、扩大 scope、超过预算等需要确认。
- `continuous`：可在既定策略内持续维护身份、响应事件、调用能力和恢复运行时；破坏性命令、发布、付款、提交/推送仍需显式授权。
- 启用电脑管家时默认 `all_registered + autoDiscoverLocalAgents`，新发现的 Agent 进入只读/待授权状态；依据用户的默认策略可自动允许受控会话。高风险平台、工作目录或权限提升仍需用户授权。
- IM 用户身份与本机 OS 用户身份分开。一个有效 IM 用户只获得 binding 明确授予的 Bot、项目、Agent 和审批权限，不能借 `/agents`、附件路径或任务内容扩大范围。

### 6.8 Intent、记忆和 Room capability 的关系

- `Intent` 是用户与持久 Bot 的交互目标及 continuation；`Task Journal` 记录实际动作和状态，不强制转换成 DAG。
- Room 通过 `room.create / room.join / room.send / room.events / room.stop` capability 被调用；`roomRunRef`、事件游标和摘要进入 Journal，Room 自己保存 Workflow/Task。
- Scheduler 只是唤醒源，负责用户指定计划、健康检查和记忆整合；不是 Bot 的主执行模型。
- 现有 `long_term_goal_update_schedule` 可迁移为 `bot_update_intent/schedule`，保留现有日报、记忆、干预和确认 UI，由 Bot Identity/Journal 承接。
- Memory 区分 profile、会话摘要、决策、用户偏好、能力经验和执行事实；写入有来源和时间，旧记忆不能覆盖当前用户意图。
- 失败分类后再行动：能力不可用、运行时中断、权限阻塞、用户意图变化和预算耗尽分别进入不同 continuation，不能一律自动重试。

### 6.9 可靠性与恢复

- 所有控制命令采用 `commandId + identityId + expectedGeneration` 幂等；超时后先查询 Journal/Runtime，不盲目重复启动 Agent。
- Event Store 持久化后再推进 supervisor cursor。重启时从最后已提交事件恢复，而非重放整个模型上下文。
- Runtime `READY/BUSY` 不是永久事实。重启后 reconcile：仍在则按协议恢复，已退出则保存输出，无法确认副作用则标记 `interrupted`，不自动重放。
- Runtime generation 与 execution lease 双重 fencing；旧 Ready、旧事件和旧提交不能覆盖新状态。
- 同一 Identity 串行处理 supervisor mailbox；不同 Runtime 可并行，但受全局并发、能力与预算限制。
- Bot 暂停分“暂停主动唤醒”和“取消运行中 Runtime”；Gateway 持久化、Outbox 通知、审批回执和恢复记录仍需处理。

## 7. 存储、事件与模块边界

### 7.1 Rust 负责

建议在 `harness-rs` 新增独立 `orchestration` crate，并在其中分开 Room 与 SuperAgent Bot 两个模块，避免继续膨胀 `dispatcher.rs`：

```text
orchestration/
  model           共享身份、连接、事件、权限与引用类型
  store           SQLite 持久化、迁移、幂等和游标
  gateway_bridge  平台/IM Inbox/Outbox、会话绑定、事件与通知模型
  room/           消息路由、Workflow DAG、Handoff 与验收状态机
  bot/            SuperAgent 持久身份、Journal、Policy、Memory、Intent
  bot/lifecycle   Wake/Ready/Busy/Sleep、single-flight 与 generation fencing
  bot/supervisor  有界 Supervisor turn、continuation 与事件订阅
  runtime/        Agent Registry、ACP/CLI 标准事件、能力与恢复
```

- `worldbase-core` 持有 Orchestrator，提供 RPC 和 run-scoped 工具绑定。Bot Supervisor 与 Room Engine 独立运行，通过 capability/事件引用协作，不共享内部状态机。
- `worldbase-group` 的 board/routing 可以迁移为 Room 的兼容视图；旧 `GroupEngine.run_round` 不再承担新工作流。
- `worldbase-tools` 只定义工具 schema 和 runtime trait，具体状态由 Orchestrator 提供。
- `worldbase-protocol` 定义版本化 DTO、标准事件和 adapter capabilities。
- `worldbase-im-gateway` 继续复用 connector 解析、签名与出站计划；Electron 生产入口仍负责网络与生命周期。不要把 Electron 现有同步 `generateReply` 同时保留为 Bot 的第二执行路径。

### 7.2 Electron 负责

- `apps/electron/src/main/agent-runtime/`：ACP transport、各平台 CLI drivers、本机 Agent Registry/发现/会话管理、connection profiles、审批路由。
- `apps/electron/src/main/agent-runtime/capability-broker`：实时能力快照、短期 capability handle、主机进程/文件/IM 权限和运行时清理。
- `apps/electron/src/main/agent-orchestration/`：Rust client、事件投影、历史兼容和旧目标迁移。
- `apps/electron/src/main/im/`：connector transport、飞书长连接、Inbox 接入、Outbox sender、消息渲染与回执；将现有同步 generate-reply 适配为持久 Bot 事件。
- `apps/electron/electron/main-process/ai/`：平台直聊不再走独立目标执行器，而是经 Conversation Gateway 投递到同一 Bot/Room Runtime。
- Renderer：Room 四视图、Agent 邀请/平台选择、Bot/IM 绑定、在线状态、外部会话、验收与预算。
- 继续由宿主提供页面自动化、项目运行时、权限 UI 等 host tools，不把这些能力塞进通用 adapter。

### 7.3 建议表

```text
rooms / room_members / room_messages / room_read_cursors
workflows / workflow_tasks / task_dependencies / task_attempts
artifacts / evidence / acceptance_runs
bot_identities / bot_policies / bot_intents / bot_task_journal / bot_cursors
bot_runtime_instances / bot_wake_generations / bot_memory_refs
agent_registry / agent_connection_profiles / agent_executions / agent_execution_events
app_conversations / bot_conversations / conversation_bindings
channel_bindings / gateway_inbox / gateway_outbox / im_delivery_receipts
commands / leases / approvals / decisions
```

`GroupSessionMeta.board` 可继续作为 Room 读取投影，新写入落到 Room 任务与事件模型。Bot 只保存 Identity/Journal/Runtime/Memory 和 Room 引用，不复制 Room 的 DAG。单一 SQLite writer/事务负责状态迁移，UI 使用只读快照和订阅事件，不直接修改运行状态。现有 ChannelBinding JSON 保存 credential，迁移时只把引用和元数据写入 Rust；第一期 secrets 继续由 Electron 保管，Rust 只接收短期 credential handle，发送时由宿主解析，后续再迁移到系统 Keychain/安全存储。

## 8. 兼容与迁移

1. 保留旧 Group API，新增 `conversation.* / room.* / workflow.* / agent.* / bot.*`，由 Electron 做一段适配，不在旧群聊上同时维护两套写入路径。
2. 普通 WorldBase 群先切换到 Room Runtime，验证独立执行上下文、全群共享消息游标和任务状态机。
3. 再开放 ACP/CLI connection profiles，跨平台消息统一进入同一事件协议。
4. 旧 IM binding 增加 `deliveryMode = legacy_sync | bot_async`。默认 legacy_sync 保持兼容，选择 Bot 后整条消息只进入 Inbox；不能同一条消息同时执行旧回复和新 Bot。
5. 旧长期目标先以只读方式映射为 Bot Identity/Intent/Journal；确认迁移后由 Bot 接管 schedule，禁用重复的旧执行入口，不能把它直接映射成 Room DAG。
6. 现有 TS Agent Loop 仍保持冻结，新能力只进入 Rust 与 Electron 宿主适配层。

## 9. 分阶段实施

### Phase 0：收敛协议与现状（1 个迭代）

- 定义上述 DTO、事件、状态机、权限矩阵、adapter capabilities。
- 建立旧 group/long-goal 到新模型的兼容映射和迁移测试。
- 定义 IM Inbox/Outbox、binding migration、身份/权限和连接器 capability。
- 用假 Agent 验证任务 DAG、串行 mailbox、取消和恢复，不先接所有平台。

**出口**：协议评审通过；模拟平台/IM 入口、群主 Agent 分派、Agent 自主邀请、成员进度、用户插话、任务交接与验收全流程可重放。

### Phase 1：Room 内核与独立上下文（1–2 个迭代）

- Room/Message/Task/Event SQLite 持久化。
- 平台内成员使用稳定 conversation；群消息独立存储和游标读取。
- 群主 Agent 可通过结构化工具建任务、邀请 WorldBase Agent、分派、交接、验收和返工。
- 用户消息和 Agent 进度对全群可见；用户随时插话；消息可见性与唤醒策略分离。
- 去掉新主路径的固定轮次与“最近 6 条笔记”依赖；旧模式暂时保留兼容。

**出口**：两个独立成员在同一 Room 内完成有依赖的任务并公开交接；用户中途补充后双方可读；重启后继续；独立执行上下文不串线；广播不造成全员空调用。

### Phase 2：ACP/CLI 与人机群协作（1–2 个迭代）

- 实现 ACP probe/create/resume/send/events/snapshot/wait/stop/permission，再按平台实现 CLI JSONL/text driver。
- 支持平台选择、用户或 Agent 拉本机 Agent 入群、InviteRequest、任务认领/交接和审批路由。
- 建立 write scope/lease、统一证据、验收和缺口返工；保留现场。

**出口**：用户能通过 ACP/CLI 把不同平台的受管 Agent 拉入 Room，也可让群主 Agent 自主邀请；Agent 能互相请求协助、公开交接、验证和返工；进度全群共享，用户可随时发言或 @Agent 指派；重启可恢复或明确标记中断。全程不调用 herdr。

### Phase 3：Bot 接管长期目标（1–2 个迭代）

- 持久 Bot Identity、Intent/Journal、Memory 引用、Policy/CapabilityBroker、Agent Registry 与自动发现授权。
- 实现 Runtime 生命周期、single-flight BeginWake、generation fencing、cold sleep、continuation 和恢复。
- 平台内直接对话绑定同一 Bot/Room，支持直接派工、观察、审批与恢复。
- 复用现有目标/日报/记忆/干预 UI；旧 schedule 迁移为 Bot 唤醒源。
- Bot 直接调用 Agent Runtime；需要协作时通过 Room capability 创建/进入 Room，不把 Room Workflow 内嵌为 Bot 引擎。

**出口**：同一 Bot 在平台内持续保持身份与记忆；简单意图可直接完成，复杂意图可调用 Agent/Room。并发消息只唤醒一个 Supervisor runtime；冷休眠后恢复；旧代次不能回写；能力失效会拒绝执行；应用重启后不重复副作用。用户可随时查看、插话或暂停。

### Phase 4：IM Bot 垂直切片（1–2 个迭代）

- **先接飞书长连接**：验签/白名单 → Inbox 去重 → 快速接收 → 同一 Bot 会话续聊 → 任务进度和最终结果由 Outbox 主动发回。
- 加入远程 `/status /pause /resume /stop /approve /deny`，通知去重、回执、重试、离线补投和 Bot/Runtime 休眠。
- 完成外部身份权限、消息渲染、过期审批防护和桌面/IM 同一工作流联动。
- 企微、Slack、Telegram 复用同一 Inbox/Outbox，按 connector 能力逐个验收，不以飞书成功代替全平台完成。

**出口**：用户通过飞书创建一个长任务，在同一对话内补充信息和批准权限；Bot 持续调度本机 Agent，结果主动发回飞书，平台内可打开同一工作流继续管理。应用重启、重复事件和发送失败后不重复执行；用户可随时暂停。

### Phase 5：强化与扩展

- worktree 隔离、自动集成、更多 ACP/CLI 平台、跨端只读监控。
- 模板化工作流、质量门策略、成本优化和更完整回放。
- 只有在单机事件与恢复稳定后，才考虑远端/跨机器调度。

## 10. 必测场景

- **上下文**：A/B 各有独立执行上下文；A/B 都能读用户消息、群进度、工具/命令摘要、证据和交接；压缩后任务事实不丢。
- **路由**：所有群消息全群可读；普通广播不唤醒全员；@提及、交接和任务分派只唤醒相关成员；用户插话优先通知群主 Agent；同一成员多条消息按序处理。
- **动态职责**：群主 Agent 可分派、邀请和交接；普通成员可申请协助；同一 Agent 可成为不同任务的 assignee/reviewer，没有固定管理层级。
- **人类式协作**：用户只提出目标后，Agent 能自主认领、邀请、交接和继续下一步；用户 @Agent 后目标 Agent 接单并报告；未达标不会自行停止推进。
- **双入口一致性**：平台与 IM 对同一 Bot/Room 的消息、任务、审批和状态一致，不会重复派工；身份关联前不混用用户权限。
- **电脑管家**：自动发现受支持平台，注册所有已接入 Agent；跨 Room 并发与预算生效；未授权进程不可被接管。
- **SuperAgent 生命周期**：Identity 与 Runtime 解耦；并发 BeginWake single-flight；SLEEPING 可唤醒；旧 generation 无法提交；cold sleep 不丢 Memory/Journal。
- **能力治理**：实时 capability 不满足时拒绝/降级；权限与凭证不进入模型上下文；能力撤回后不再执行。
- **任务**：依赖未完成不可运行；重复分派幂等；旧 lease 不可提交；失败返工只携带缺口。
- **验收**：自报完成不通过；验收命令失败进入 `changes_requested`；证据与结果可回放。
- **外部 Agent**：ACP 握手失败、CLI 缺失、进程退出、idle/done/blocked、权限等待、输出截断和协议版本不兼容都能正确映射。
- **IM 入站**：签名错误、非白名单用户、重复事件、乱序事件、@提及、长连接重连和自消息回环均正确处理。
- **IM 出站**：快速 ACK 不等待长任务；网络超时、回执丢失、限流、超长消息和重启恢复不会丢失 Outbox；不能跨用户/频道误发。
- **IM 控制**：状态查询只显示授权范围；过期/重复审批按钮无效；暂停与取消语义不同；不同外部会话上下文隔离。
- **恢复**：controller、Worker、Electron、ACP/CLI 子进程分别中断后的 reconcile；不会重复创建执行实例。
- **IM 恢复**：Electron/connector 断线后恢复 Inbox、会话与 Outbox；平台离线期间的消息去重补收，无主动发送能力的平台明确降级。
- **安全**：未授权 connection profile 不可创建/恢复会话；scope 不扩大；secrets 不进群流；停止/暂停能传播到整棵执行树。
- **预算**：token、费用、时长、并发任一达到上限后停止扩张并请求决策。

## 11. 推荐的第一步

先做平台内端到端切片，再接 IM；ACP/CLI Driver 按 Phase 2 接入。首个完整产品目标是：

```text
用户在平台内或 IM 提出目标与验收标准
  → Bot 从电脑 Agent Registry 选择本机 ACP/CLI Agent
  → 创建 Room、拉 Agent 入群并公开分工
  → Agent 们通过群消息协作、互相 @、邀请协作者和交接任务
  → 每个 Agent 发布进度、工具/命令摘要与 Artifact/Evidence
  → 用户只观察，或随时插话、@Agent 重新指派
  → 未达标就继续分派和返工，需要权限/方向时才请用户决策
  → 全部验收通过后向用户交付，平台与 IM 看到同一结果
  → 重启后 Bot、Room、任务和 Agent 会话可恢复
```

这一步验证的是完整人机合作闭环，而非“多 Agent 各写一段笔记”。**Bot 按 SuperAgent 管 Identity、Policy、Journal、生命周期与恢复；Room 独立管共享信息、协作、Workflow 和验收；ACP/CLI Driver 管本机执行。** 三者通过事件与 capability 协作，不把 Bot 简化成任务派发循环。
