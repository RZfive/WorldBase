# 在线群组

在线群组把同一局域网内的 WorldBase 实例连接成一个去中心化的协作空间。它复用桌面端群组入口，但和本地 Agent 群组是两套数据：

- 本地 Agent 群组：由 `agentGroup.*` / `group.*` 管理，执行多 Agent 讨论。
- 在线群组：人类成员加群、群聊、文件传输、成员加入自己的 Agent，以及对 Agent 的跨用户委派。

## 分层

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 发现 | `harness-rs/crates/lan` | UDP 组播广播、探测、对端快照、过期清理 |
| 协议 | `harness-rs/crates/protocol` + `crates/core` | `lan.discovery.*` RPC；桌面域能力 |
| 协作服务 | `apps/electron/src/main/online-groups` | 群组持久化、邀请/申请、消息与附件、委派状态机 |
| LAN API | `apps/electron/src/main/lan-server/routes/online-groups.ts` | 对等实例之间的 HTTP 同步接口 |
| 管理弹窗 | `renderer/components/chat/layout/OnlineGroupsDialog.vue` | 发现、建群、邀请、入群申请；不承载聊天 |
| 群聊面板 | `renderer/components/chat/panel/ChatPanelContainer.vue` | 复用主消息流、输入框和附件；本地群与在线群共用 |
| 成员栏 | `renderer/components/chat/layout/GroupMembersPanel.vue` | 常驻群成员列表、添加自己的 Agent、成员下方的独立审批分类 |
| 群聊设置 | `renderer/components/chat/layout/OnlineGroupSettingsDialog.vue` | 群名称/图标/说明、退出或解散群组 |

网络发现只放在 harness。Electron 不自行扫描局域网，而是调用 Rust 的发现 RPC 并消费统一的 peer 快照。

首次使用时需要允许系统防火墙放行 TCP `19527`（群组/文件 HTTP 接口）和 UDP `19528`（发现组播），并确保设备处于同一子网；macOS 还需要允许世界访问“本地网络”。

## 发现协议

- 组播地址：`239.255.76.87:19528`。
- 报文：JSON，当前 `version = 1`，`kind = announce | probe`。
- 节奏：启动时广播 probe + announce，之后每 3 秒 announce；收到 probe 立即回复 announce。
- 过期：12 秒未收到广播的对端从快照移除。
- 广播内容：实例 ID、显示名、头像、身份卡背景、标签、HTTP 基地址、版本、主机名、能力标签和公开群组摘要。
- 广播绝不包含群组访问令牌、邀请令牌、消息、文件或 Agent 私有人设。

对应 RPC：

- `lan.discovery.start`
- `lan.discovery.update`
- `lan.discovery.stop`
- `lan.discovery.status`
- `lan.discovery.refresh`

这组方法属于 `desktop` 域，因为需要绑定 UDP 端口和宿主 LAN 服务。

## 成员模型

在线群组不再要求用户填写“我的群内角色”。成员只分为两类：

- 真人成员（`human`）：每个 WorldBase 实例对应一名真人。
- 真人所属 Agent（`agent`）：Agent 必须挂在某位真人之下，展示为“所属真人 → Agent”。

群内权限只保留内部 `accessRole`（`owner | admin | member | observer`）用于控制邀请、审批和解散，不作为业务角色展示。创建者成为 `owner`，邀请或申请被接受后默认是 `member`。

每位真人使用同一张身份卡展示头像、显示名、背景和最多 6 个标签。身份卡在发现列表、邀请、入群申请、群组列表和成员栏中复用；点击自己的头像或显示名即可编辑，保存后会同步到已有群组成员。

左侧群组列表的每一项会标记“在线群聊”或“本地群组”；在线群聊标题也带有独立标签。成员栏根据 harness 发现快照显示真人成员的在线/离线状态，成员所属 Agent 跟随其真人状态展示。

入群路径：

1. 群主在发现页勾选在线 WorldBase，创建群并发出邀请。
2. 对方在“待处理”中接受邀请，向群主实例确认邀请令牌。
3. 群主把新成员写入群组并返回共享访问令牌。
4. 其他成员通过周期同步或直接消息广播获知新成员。

也可以从发现页对已广播群组发起入群申请；群主批准后才发送邀请。

## 群聊与文件

- 在线群聊复用主聊天面板的消息时间线、输入框和附件选择，不再在管理弹窗里实现第二套聊天窗口。
- 右侧成员栏默认常驻，按“真人 → 所属 Agent”分组。成员标题旁可直接添加自己的 Agent；跨用户 Agent 授权不再插进聊天消息流，而是在成员列表下方作为独立“审批”分类显示。
- 新消息先写入本地群组，再并行 POST 给其他成员的 LAN 地址。
- 离线成员在恢复后通过 `snapshot` 拉取并去重合并；消息上限 2000 条。
- 附件随消息一起分发，各成员本地缓存；缺失时可按来源成员回源读取。
- 限制：单文件 6MB，单条消息附件合计 7MB，每条消息最多 5 个附件。
- 当前不做端到端加密，适用于可信局域网；不应通过公网暴露 LAN 端口。

## Agent 加入与委派

每个成员只能把**自己的**本地 Agent 加入群组。群内 Agent 记录包含所有者实例 ID、名称、图标和说明；不能让其他成员代挂 Agent。入口位于成员栏标题右侧：点击“添加 Agent”，从自己的 Agent 列表中选择并加入。

委派状态机：

```text
pending_owner_approval -> approved -> running -> completed
                       -> rejected
approved/running       -> failed
```

- 目标是自己的 Agent：直接进入 `approved` 并异步执行。
- 目标是其他用户的 Agent：始终进入 `pending_owner_approval`，对端所有者批准后才执行。
- 委派由群聊中的 `@Agent名称` 自动创建，不提供单独的手动发起任务表单；人类消息和 Agent 消息走同一套 @ 解析。
- 待授权请求显示在目标 Agent 所有者的成员栏“审批”分类；成员栏标题会显示红色提醒。
- 远端传入的委派即使声称 `approved` 也会被强制重置为 `pending_owner_approval`。
- 决策接口校验 `decidedByPeerId === toOwnerPeerId`，其他成员不能代批。
- 执行中的 Agent 会拿到最近群聊历史和成员名单；可通过 `delegate_group_agent` 向其他用户的 Agent 发起新的待审批委派，但不能向同一所有者的 Agent 递归调用该工具。
- 获批后由所有者实例用对应本地 Agent 运行；批准同时表示允许该 Agent 按其自身工具权限执行任务。后台运行不开放交互式追问，遇到非阻塞信息缺失时应说明假设继续，真正阻塞时返回具体原因。
- 结果回写为群内 `agent` 消息并广播委派完成状态。

委派任务、结果和状态对群组成员可见。不要把不应让群成员看到的秘密放进委派上下文。

## 群聊设置

在线群聊头部使用设置按钮打开“群聊设置”，不提供成员侧栏开关。群主或管理员可以修改群名称、图标和说明；修改会广播给在线成员，并通过 `settingsUpdatedAt` 在后续同步中合并。退出群组和解散群组也集中在设置弹窗的群组管理区域，不再放在成员列表底部。

## 主要 HTTP 接口

所有接口前缀为 `/api/online-groups`。

| 方法 | 路径 | 鉴权 |
| --- | --- | --- |
| GET | `/profile` | 无；返回公开实例与群组摘要 |
| POST | `/invitations` | 无；用户仍需手动接受 |
| POST | `/join-requests` | 无；群主仍需审批 |
| POST | `/:groupId/accept-invite` | 邀请令牌 |
| GET | `/:groupId/snapshot` | 群组访问令牌 |
| POST | `/:groupId/settings` | 群组访问令牌 + 群主/管理员 peer ID |
| POST | `/:groupId/messages` | 群组访问令牌 |
| POST | `/:groupId/members` | 群组访问令牌 + 发送者 peer ID |
| POST | `/:groupId/members/remove` | 群组访问令牌 + 仅能移除自己的 Agent |
| POST | `/:groupId/delete` | 群组访问令牌 + 仅群主 |
| POST | `/:groupId/delegations` | 群组访问令牌 + 发送者 peer ID |
| POST | `/:groupId/delegations/:id/decision` | 群组访问令牌 + Agent 所有者 peer ID |
| GET | `/:groupId/files/:attachmentId` | 群组访问令牌 |

群组访问令牌只通过接受邀请的响应返回，不出现在发现广播和公开摘要中。

## 验证

```bash
cargo test --manifest-path harness-rs/Cargo.toml -p worldbase-lan
pnpm --dir apps/electron test:online-groups
pnpm --dir apps/electron typecheck
```

`worldbase-lan` 包含真实组播互相发现测试；`online-groups` 测试启动两个临时实例，覆盖邀请、群聊、附件和跨用户 Agent 委派审批。
