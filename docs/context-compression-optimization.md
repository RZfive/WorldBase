# 上下文压缩优化方案

> 调研对象：Codex、OpenCode、ZCode
> 目标系统：WorldBase Rust Harness
> 调研日期：2026-11-13

## 1. 摘要

长任务中的上下文压缩不应被理解为“把聊天记录总结短一点”。真正稳定的压缩系统需要同时解决四个问题：

1. 哪些信息必须原样保留；
2. 哪些信息可以摘要；
3. 被压缩掉的信息如何重新取回；
4. 如何避免模型在压缩后重新走已经确认的死路。

当前 Codex、OpenCode、ZCode 的共同方向已经明确：

- **摘要不是唯一状态载体**；
- **最近工具结果和用户消息要保留原文**；
- **系统提示词、工具定义、项目状态等稳定上下文应重新生成，而不是参与摘要**；
- **完整历史必须持久化，摘要只作为导航层**；
- **压缩应在上下文接近上限前预计算，而不是等到溢出后临时处理**。

推荐 WorldBase 采用五层上下文架构：

```text
静态上下文（每轮重新生成）
    +
确定性 RunStateLedger（代码维护，不经模型自由总结）
    +
结构化 Checkpoint（模型生成、Schema 校验）
    +
最近原始窗口（按模型窗口动态分配，通常 12k–16k tokens）
    +
完整 Transcript Store（可检索、可回读）
```

> 阅读约定：第 2 节保留为 **改造前基线**，用于解释为什么需要本次重构；第 5 节以后是目标架构与完成后的状态。2026-11-13 的最终实现、验证结果和剩余限制见 [`context-compression-implementation.md`](context-compression-implementation.md)。
>
> 实施状态：本文 P0/P1/P2 主路径已落地，`scripts/verify-context-compression.sh` 全阶段通过。

---

## 2. 改造前基线与问题复盘

> 核对基线：`harness-rs/crates/core/src/agent.rs`、`harness-rs/crates/memory/src/lib.rs`、`harness-rs/crates/providers/src/anthropic.rs` 及当前工作区未提交改动。第 2 节只描述实际行为，不代表推荐方案。

### 2.1 改造前调用链

改造前主路径位于 `harness-rs/crates/core/src/agent.rs`：

1. 用户消息先写入 SQLite；
2. `run_chat_inner` 通过 `Store::list_messages(conversation_id, 400)` 读取最近 400 条历史（返回时保持时间正序）；
3. `to_llm_messages` 将 `ChatMessage` 转为 provider 消息；
4. 每次 run 创建一次 `ContextCompressionState`；
5. 每轮刷新 run tool catalog 和 active skills；
6. 每 16 个 segment iteration 无条件执行一次同步压缩；
7. 其他轮次只有估算输入超过 `context_warning_threshold` 时才压缩；
8. 压缩时调用当前 provider 生成摘要，失败则使用 deterministic summary；
9. summary 与 original/latest user anchor 被拼接到 system prompt 末尾；
10. 活动消息按 `6/4/2/0` 条尝试保留最近消息，并检查估算是否低于输入阈值。

改造前核心符号：

- `ContextCompressionState`
- `compress_context_if_needed`（测试路径）
- `compress_context_with_provider`（生产路径）
- `deterministic_context_summary`
- `provider_context_summary`

### 2.2 改造前关键参数

| 参数 | 改造前值 | 实际含义 |
|---|---:|---|
| `CONTEXT_SUMMARY_MAX_CHARS` | 3,000 | 摘要最终截断上限，按字符计 |
| `CONTEXT_SUMMARY_SOURCE_MAX_CHARS` | 2,500 | 每个文本块 / tool result 块的头部保留上限，不是整条消息上限 |
| `CONTEXT_SUMMARY_MAX_SOURCE_MESSAGES` | 48 | 超限时取第一条用户消息 + 最后 47 条消息 |
| `RECENT_MESSAGE_KEEP_OPTIONS` | `6/4/2/0` | 压缩后按“消息条数”尝试保留，不是 token 预算 |
| `CONTEXT_GOAL_ANCHOR_MAX_CHARS` | 2,000 | original/latest user request 各自的截断上限 |
| `CONTEXT_HEADROOM_RATIO` | 15% | 输入阈值按窗口比例预留，但受上下限约束 |
| `CONTEXT_MIN_HEADROOM_TOKENS` | 2,048 | 最小预留 |
| `CONTEXT_MAX_HEADROOM_TOKENS` | 8,192 | 最大预留；大窗口下实际阈值会接近窗口上限 |
| `ESTIMATED_CHARS_PER_TOKEN` | 4 | 当前仅用 `chars / 4 + message overhead` 估算 |
| `DEFAULT_CONTEXT_WINDOW_TOKENS` | 32,000 | 非 Anthropic 未知模型 fallback |
| `DEFAULT_ANTHROPIC_CONTEXT_WINDOW_TOKENS` | 200,000 | Anthropic 未知模型 fallback |
| `MAX_TOKENS` | 8,192 | 每次正常模型请求的最大输出预算 |
| `PROACTIVE_COMPRESSION_INTERVAL` | 16 | 每 16 个 segment iteration 强制压缩一次 |
| `CONTEXT_SUMMARY_TIMEOUT` | 5 分钟 | provider summary 超时 |
| provider summary `max_tokens` | 2,048 | 摘要请求的输出上限 |
| 历史读取上限 | 最近 400 条 | 子查询 `ORDER BY id DESC LIMIT 400`，外层再 `ORDER BY id ASC` |
| 工具结果 inline 阈值 | 30,000 chars | 超过后 head/tail 截断 |
| 工具结果落文件阈值 | 100,000 chars | 超过后完整内容写文件，消息只保留路径、大小和 500 chars preview |

### 2.3 改造前实际行为与重要限制

| 主题 | 改造前行为 | 影响 |
|---|---|---|
| 压缩触发 | 估算输入超过 `window - clamp(15%, 2048, 8192)`，或每 16 轮强制触发 | 大窗口阈值可达约 92%–96%；32k fallback 下阈值加 8k 输出预算可能直接超过窗口 |
| overflow 处理 | 没有识别 context overflow 的专用路径；provider 错误按普通流错误重试后终止 | 无法执行“一次 emergency compaction 后重建同一 logical step” |
| 摘要源 | 消息不超过 48 条时全部进入投影；超过时取第一条用户消息 + 最后 47 条 | 中间决定性证据可能直接消失 |
| 精确内容 | 每个文本块 / tool result 只保留头部 2,500 chars | 位于输出中后段的错误、堆栈、manifest 校验信息可能丢失 |
| 摘要生成 | 生产路径同步调用当前 provider；失败回退 deterministic summary | 无独立 summary model、无后台候选、无 schema 校验或 nudge |
| 多次压缩 | 旧 summary 会再次进入新 summary；最终被 3,000 chars 头尾截断 | 存在递归语义损失 |
| `ContextCompressionState` | 只保存 `summary`、`original_user_request`、`latest_user_request`，且仅存在于当前 run | 没有 confirmed facts、attempts、critical errors、dead ends、next actions，也没有持久化 checkpoint |
| goal anchor | 扫描所有 `LlmRole::User` 消息，只排除 continuation 和 finish_task nudge | runtime synthetic message、coding nudge、带图片的 tool result 都可能覆盖 latest user request |
| 摘要注入位置 | summary 和 goal anchor 拼接到 system prompt 末尾 | 模型生成摘要和 tool output 可能被提升为 system 级权威内容 |
| 历史读取 | SQLite 持久化全部消息，agent 读取最近 400 条 | 旧消息超出窗口后不会进入模型请求；当前还没有 token-aware / 工具交换对齐的边界 |
| Transcript 检索 | messages 表存在，但没有 messages FTS、message ID 引用、compaction boundary 或 recall 工具 | 只能算“持久化基础”，还不具备可检索、可回读的导航层 |
| Static context | `system_prompt` 每个 run 只构建一次；每轮只刷新 tool catalog 和 active skills | project/capability 等世界状态可能在 run 内过期，并非“每轮重建” |
| Microcompact | 有工具结果大小上限和摘要前投影截断，但没有按价值清理旧日志的独立阶段 | 仍可能把低价值大输出带入摘要流程 |
| 版本一致性 | 没有 history/model/prompt/tool catalog/auth 的候选版本校验 | 不存在可安全采用的异步摘要候选 |

### 2.4 历史案例及其时效性

文档最初核对时，HEAD 为 `957fef8`。当时一次长对话中，模型执行了大量工具调用但未完成任务，并出现过：

```text
trending.refresh | write
```

当时平台 manifest 只接受 `write_reversible`，因此 manifest 校验失败、应用未注册、`search_tools(source: "app")` 返回空。压缩后模型丢失了这条决定性证据，转而检查 SQLite 内部表、`/Applications/WorldBase.app`、harness 二进制和 `app.asar`。

**该案例的当前状态需要区分版本：**

- 在 HEAD `957fef8` 上，`write` 确实不是合法枚举，案例成立；
- 当前工作区已增加 `CapabilityRisk` 的 legacy alias（`write` → `write_reversible`）以及 `repair_legacy_capability_risks`；
- 当前工作区还新增了 AI application upgrade prompt，明确要求不要检查 `app.asar`、SQLite 内部表或 harness 二进制；
- 因此，这个具体 manifest 错误不应再被描述为“当前仍可复现的问题”，但它仍可作为**压缩丢失精确错误与死路**的历史证据。

### 2.5 改造前根因归纳

1. **精确错误先被 head-only 截断，再被摘要**
   - 关键错误如果位于 tool result 中后段，在进入摘要模型前就可能消失。

2. **摘要源选择不足**
   - 超过 48 条后只保留第一条用户消息和末尾消息，中间证据可能完全不可见。

3. **多次压缩递归损失**
   - 上一轮 summary 被截断后再次参与下一轮 summary，且每 16 轮强制触发一次。

4. **没有任务状态 Ledger**
   - 没有 confirmed facts、critical errors、attempts、dead ends、active/blocked/next actions。

5. **goal anchor 缺少消息来源约束**
   - latest user request 可能被 runtime synthetic message 或工具图片覆盖，且最多 2,000 chars。

6. **摘要进入 system prompt**
   - 模型生成内容和不可信工具输出被放进 system 角色，权威层级不安全。

7. **最近历史窗口仍是固定行数**
   - 已改为读取最近 400 条，但 400 是 SQLite row 数，不是 token 数，也不保证从完整 tool exchange 边界开始。

8. **压缩预算不是实际可用输入预算**
   - 输入阈值没有可靠覆盖最大输出预算，且没有 overflow 专用恢复路径。

9. **没有可用的 Transcript 导航层**
   - 没有 messages FTS、message ID、compaction boundary、`recall_context` / `read_transcript_range`。

10. **Static context 和世界状态没有每轮重建**
    - system prompt 每个 run 构建一次；project/capability 状态可能不会随 run 内变化刷新。

11. **没有压缩前 microcompact 和后台预计算**
    - 当前只有工具结果上限与同步摘要，没有按价值清理旧日志，也没有版本化后台候选。

---

## 3. 竞品调研

### 3.1 Codex

调研版本：

- 本机 CLI：`codex-cli 0.167.1`
- 源码快照：`openai/codex@5045589550122ec4f073d10e3d66a0813bcb7be0`

#### 3.1.1 核心机制

Codex 的压缩由四部分组成：

1. 模型生成的 handoff summary；
2. 最近用户消息原文；
3. 重新构建的 system/world state；
4. 当前工具、权限和项目环境。

#### 3.1.2 摘要 Prompt

Codex 的压缩 Prompt 位于：

```text
codex-rs/prompts/templates/compact/prompt.md
```

要求保留：

- 当前进度和关键决策；
- 重要上下文、约束和用户偏好；
- 剩余工作和明确下一步；
- 继续任务所需的关键数据、示例和引用。

摘要插入为特殊的 compaction summary message，而不是普通 assistant 文本。

#### 3.1.3 保留最近用户消息

Codex 使用：

```text
COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000
```

压缩后会保留最多约 20k tokens 的最近用户消息原文。

意义：

- 摘要可以压缩叙事；
- 最近用户意图不需要依赖模型重新概括；
- 用户中途修改要求时不易丢失。

#### 3.1.4 重建世界状态

Codex 不把以下内容交给摘要模型：

- Base instructions；
- 工具定义；
- 权限配置；
- 当前 world state；
- 项目/环境上下文。

压缩后通过 `build_compaction_replacement_history` 等路径重新构建稳定上下文，再与摘要和最近用户消息组装。

#### 3.1.5 异步预压缩

实现位于：

```text
codex-rs/core/src/session/async_compaction.rs
```

关键特性（启用 async compaction feature 且 provider 支持 remote compaction v2 时）：

- 默认达到约 **65%** 上下文时启动后台压缩候选；
- 不阻塞当前 turn；
- 压缩候选带 history version、model、compaction hash、auth owner；
- 只有这些字段均未变化时才采用候选；
- 历史、模型、compaction hash 或认证变化时丢弃过期候选。

#### 3.1.6 优点与局限

优点：

- 架构清晰：静态状态与对话摘要分离；
- 最近用户消息原文保留充分；
- 后台压缩减少主路径延迟；
- 版本检查避免使用过期摘要。

局限：

- 摘要 Prompt 比较通用；
- 没有像 OpenCode 那样强制结构化字段；
- 对“精确错误、已确认死路”的显式保留依赖摘要模型自觉。

---

### 3.2 OpenCode

调研版本：

- 本机 CLI：`1.19.3`
- 源码快照：`anomalyco/opencode@73abe63ac23224d88e739e7028882e547ef65a79`

#### 3.2.1 核心机制

实现位于：

```text
packages/core/src/session/compaction.ts
```

规范文档：

```text
specs/v2/session.md
```

OpenCode 使用：

1. 结构化 checkpoint；
2. 最近 15k tokens 原文；
3. 完整 transcript 持久化；
4. 后台预计算；
5. 模板校验与重试。

#### 3.2.2 结构化 checkpoint

模板包含：

```markdown
## Objective
## Requirements
## Decisions
## Work State
### Completed
### Active
### Blocked
## Next Move
## Relevant Files
## Important Context
```

特别要求：

- 保留精确文件路径、符号、命令、错误字符串、URL、ID；
- 只保留仍未解决的问题；
- 已完成事项从 Active 移除；
- 已解决 blocker 不重复；
- Relevant Files 最多 15 个；
- 不列举所有读过的文件，只保留真正需要继续工作的文件。

#### 3.2.3 最近原文窗口

默认配置：

```text
auto = true
keep = 15,000 tokens
未配置 buffer 时预留 15%
窗口 >= 32k 时，预留至少 16k tokens
```

自动压缩阈值计算大致为：

```text
context_window - buffer

# 窗口 >= 32k 时 buffer = max(15%, 16k)
# 更小窗口只按 15% 预留，避免预留值吃掉整个窗口
```

#### 3.2.4 后台预计算

```text
PRECOMPUTE_LEAD = 60,000 tokens
```

在距离 ceiling 约 60k tokens 时即可开始后台摘要。

该能力由 `precompute` 设置控制；源码中的默认值是关闭，宿主可以显式开启。

后台摘要特点：

- 不流式输出给用户；
- 不进入主请求路径；
- 计费进入 usage；
- 到阈值后再替换即时摘要。

#### 3.2.5 完整 transcript 与引用

完整对话历史始终持久化。

摘要只保存：

- summary text；
- `metadata.keepID`；
- 最近原文窗口的引用。

压缩只替换模型当前可用的活动历史，不删除原始历史。

#### 3.2.6 模板校验

如果摘要没有包含任何合法 section heading：

1. 先追加一次 nudge；
2. 仍不符合则视为压缩失败；
3. 不使用无效摘要。

#### 3.2.7 自适应 transcript 裁剪

如果摘要请求本身过长，会按层级逐步裁剪：

1. 完整 transcript；
2. 截断旧工具输出；
3. 移除旧工具输出并截断工具输入；
4. 只保留用户文本；
5. 最终省略低价值消息。

#### 3.2.8 优点与局限

优点：

- 结构化程度最高；
- 最近原文窗口充足；
- 历史可追溯；
- 后台预计算减少压缩等待；
- 摘要模板可校验、可重试。

局限：

- 实现复杂度较高；
- 对数据库、事件投影和持久化能力要求高；
- 需要额外维护 checkpoint 版本和消息引用关系。

---

### 3.3 ZCode

调研版本：

- 本机安装包：`ZCode 3.15.1`
- 运行时代码：`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`

ZCode 为闭源打包实现，以下结论基于本机安装包中的可读运行时代码和字符串。

#### 3.3.1 详细交接摘要

ZCode 的压缩 Prompt 要求先输出 `<analysis>`，再输出 `<summary>`，并包含：

1. Primary Request and Intent；
2. Key Technical Concepts；
3. Files and Code Sections；
4. Errors and fixes；
5. Problem Solving；
6. All user messages；
7. Pending Tasks；
8. Current Work；
9. Optional Next Step。

尤其强调：

- 用户后来的纠正必须保留；
- 安全约束必须原样保留；
- 错误及修复过程必须保留；
- 当前工作必须详细描述；
- 下一步必须直接对应用户最新请求。

#### 3.3.2 保留最近消息原文

压缩后提示中明确包含：

```text
Recent messages are preserved verbatim.
```

#### 3.3.3 Transcript 回溯

摘要后会附带完整 transcript 路径：

```text
If you need specific details from before compaction...
read the full transcript at: <path>
```

这是解决“摘要无法容纳所有精确细节”的关键兜底机制。

#### 3.3.4 Microcompact

ZCode 在完整压缩前支持 `LocalToolResultClear`：

- 触发类型包括 token pressure 和 time-based；
- 优先清理旧工具结果；
- 保留工具调用和关键状态；
- 不足时才进入完整模型摘要。

#### 3.3.5 生命周期保护

ZCode 还包含：

- 压缩 timeline 和 boundary；
- 压缩失败重试；
- 压缩后 reminder；
- REPL/VM 状态清理提示；
- session memory 摘要源；
- model summary 和 session memory 两种摘要来源。

#### 3.3.6 优点与局限

优点：

- 对错误、用户纠正、当前任务和下一步保留最详细；
- transcript 回溯非常实用；
- microcompact 能显著降低摘要负担；
- 对压缩失败和中断有明确生命周期状态。

局限：

- `<analysis>` 本身消耗输出 token；
- 摘要容易过长；
- 依赖模型严格遵循复杂模板；
- 闭源实现，难以直接复用代码。

---

## 4. 方案对比

| 能力 | Codex | OpenCode | ZCode | 推荐 |
|---|---|---|---|---|
| 静态上下文重建 | 强 | 强 | 中 | 采用 Codex/OpenCode |
| 结构化摘要 | 中 | 强 | 强 | 采用 OpenCode + ZCode |
| 最近原文 | 最多 20k 用户消息 | 默认 15k | 保留最近消息 | 采用按窗口动态分配的混合窗口；通常 12k–16k，小窗口按比例缩小 |
| 精确错误保留 | 中 | 强 | 强 | 必须强制保留 |
| 已确认死路保留 | 弱 | 中 | 强 | 必须显式保留 |
| 完整 transcript | 持久化 | 持久化 | 持久化 + 路径 | 采用完整存储与检索 |
| 后台预压缩 | 强 | 强 | 中 | 采用 |
| microcompact | 中 | 强 | 强 | 采用 |
| 版本一致性 | 强 | 强 | 中 | 采用 |
| 模板校验 | 中 | 强 | 中 | 采用 |

---

## 5. 推荐架构

### 5.1 五层上下文

基于"lost in the middle"效应（模型对上下文首尾注意力最强，中部较弱），五层在物理上下文窗口中的排列顺序如下：

```text
┌─────────────────────────────────────────────┐  ← 上下文开头（高注意力）
│ 1. Static Context                           │
│ system prompt / tools / permissions / env   │
│ project state / capability details          │
├─────────────────────────────────────────────┤  ← 中部（叙事参考，低注意力可接受）
│ 3. Structured Checkpoint                    │
│ objective / work state / decisions          │
│ dead ends summary / relevant files          │
├─────────────────────────────────────────────┤
│ 5. Transcript Store 引用（几行）             │
│ transcriptId / lastSummarizedMessageId      │
│ If you need X, call recall_context("...")   │
├─────────────────────────────────────────────┤  ← 末部（高注意力）
│ 2. Deterministic RunStateLedger             │
│ criticalErrors / deadEnds / nextActions     │
├─────────────────────────────────────────────┤
│ 4. Recent Raw Context                       │
│ 按窗口动态分配（通常 12k–16k tokens）        │
├─────────────────────────────────────────────┤
│ 当前用户消息 / in-flight request             │
└─────────────────────────────────────────────┘
```

排列原则：

- **Static Context 在最前**：每轮重建，永不过期，放开头确保模型始终感知权限和工具边界；
- **Checkpoint 在中部**：作为叙事参考，模型查阅时会主动注意，低注意力区可接受；
- **RunStateLedger + Recent Raw Window 在末部**：`criticalErrors`、`deadEnds`、`nextActions` 是不能靠注意力衰减赌运气的字段，必须靠近当前请求；
- **Transcript Store 引用只占几行**：位置无关，仅作为检索工具入口。

> 该五层排列现已落地。改造前 system prompt 每个 run 只构建一次，summary 与 goal anchor 会追加到 system prompt 末尾；本次实现已移除该行为。

### 5.2 Static Context

每轮重新生成，不参与摘要：

- system prompt；
- tool definitions；
- agent persona；
- permission policy；
- workspace/project metadata；
- active capabilities；
- skill instructions；
- MCP server/tool definitions；
- environment；
- current date。

要求：

> 静态上下文必须来自当前真实状态，不能从旧摘要中恢复。

> 改造前 `system_prompt` 在每个 run 开始时只构建一次。实现已在成功 compaction 后重建 static context，并在每轮刷新 tool catalog 与 active skills。

### 5.3 Deterministic RunStateLedger

由系统代码在工具调用后更新，不依赖模型自由总结。

建议结构：

```json
{
  "objective": "string",
  "latestUserRequest": "string",
  "requirements": [],
  "confirmedFacts": [
    {
      "fact": "string",
      "evidence": "tool_call_id | file_path | message_id",
      "timestamp": "ISO-8601"
    }
  ],
  "criticalErrors": [
    {
      "message": "string",
      "source": "string",
      "exact": true,
      "toolCallId": "string"
    }
  ],
  "capabilities": [
    {
      "id": "string",
      "title": "string",
      "risk": "string",
      "availability": "string"
    }
  ],
  "decisions": [],
  "attempts": [
    {
      "tool": "string",
      "argsDigest": "string",
      "outcome": "success | error",
      "errorSignature": "string | null"
    }
  ],
  "deadEnds": [
    {
      "hypothesis": "string",
      "evidence": "string",
      "doNotRepeat": true
    }
  ],
  "completed": [],
  "active": [],
  "blocked": [],
  "nextActions": []
}
```

#### 必须原样保留

- 精确错误字符串；
- manifest/schema 校验错误；
- 文件路径；
- 命令；
- 项目 ID；
- capability ID；
- 工具名；
- API 名称；
- 数据库错误码；
- 端口；
- 用户明确纠正；
- 安全约束。

#### 双轨写入机制

Ledger 的写入分两条轨道，不能全部归入确定性处理：

**Track A — Rust 同步写入（确定性，每次工具返回后立即执行）**

| 触发事件 | 写入字段 | 内容 |
|---|---|---|
| 工具返回 `is_error=true` | `criticalErrors` | 原始错误字符串 + toolCallId + source |
| 任意工具返回 | `attempts` | tool + argsDigest + outcome + turn |
| 用户消息到达 | `latestUserRequest` | 覆盖写 |
| capability 查询成功 | `capabilities` | 覆盖重建 |
| `active` 任务完成 | `completed` | 从 active 移入 |
| blocker 解除 | `blocked` | 移除对应条目 |

**Track B — 轻量 fact extractor（异步 prompt，不阻塞主路径）**

每轮工具调用结束后异步触发一次小 prompt，输入为当前工具结果 + Ledger 摘要，输出严格约束为：

```json
{
  "facts": ["string"],
  "deadEnd": "string | null"
}
```

Prompt 约束：`facts` 最多 2 条，每条 ≤ 20 词，只写"已被工具结果直接确认"的事实；`deadEnd` 只在当前结果明确否定某个假设时填写，否则 null。Track B 结果 append 到 `confirmedFacts` 和 `deadEnds`，失败则跳过，不影响主流程。

**确定性更新规则**

- 工具成功且产生新事实：由 Track B 写入 `confirmedFacts`；
- 工具失败：由 Track A 写入 `criticalErrors`；
- 同一错误重复出现：按 `errorSignature` 合并为 1 条并增加 `count`，不重复正文；
- 已确认某个假设不成立：由 Track B 写入 `deadEnds`；
- 用户改变要求：Track A 覆盖 `latestUserRequest`，并写入 `decisions`；
- 工具调用完成：Track A 写入 `attempts`；
- 当前计划完成：从 `active` 移入 `completed`；
- blocker 消失：从 `blocked` 删除。

#### Ledger 老化策略

**硬上限：Ledger 序列化为 JSON 后不超过 4,000 tokens。** 每次 append 后同步检查，超限时按以下 per-array 规则裁剪：

| 字段 | 保留规则 | 软上限 |
|---|---|---|
| `attempts` | 最近 20 条 + 所有 `outcome=error` | 60 条 |
| `confirmedFacts` | 达到 50 条时触发 batch merge | 50 条 |
| `criticalErrors` | 相同 `errorSignature` 合并为 1 条 + `count` | 20 条 |
| `completed` | 最近 10 条 | 10 条 |
| `decisions` | 最近 10 条 | 10 条 |
| `deadEnds` | **永不过期，全部保留** | 20 条 |
| `active` / `blocked` / `nextActions` | 实时状态，不累积 | 不限 |
| `capabilities` | 每轮覆盖重建 | 不限 |

**溢出时裁剪优先级（从最先裁剪到最后保护）：**

```text
1. completed → 只保留最近 5 条
2. attempts 的 success 条目 → 只保留最近 10 条
3. confirmedFacts → 触发 batch merge（取最旧 10 条合并为 1-3 条）
4. decisions → 只保留最近 5 条
5. 永不裁剪：criticalErrors / deadEnds / active / blocked / nextActions
```

**ConfirmedFacts batch merge 触发逻辑：**

```
if confirmed_facts.len() > 50 {
    将最旧的 10 条送入 fact dedup prompt：
    "以下事实有重叠或可合并的请合并为 1-3 条，格式不变"
    替换原 10 条为合并结果
}
```

### 5.4 Structured Checkpoint

调用摘要模型生成，并进行 Schema 校验。

建议模板：

```markdown
## Objective
- ...

## Requirements
- ...

## Confirmed Facts
- ...

## Critical Errors
- `exact error message` — source: ...

## Decisions
- ...

## Work State
### Completed
- ...
### Active
- ...
### Blocked
- ...

## Attempts and Outcomes
- ...

## Dead Ends
- ...

## Capabilities
- `capability.id` — title; risk; availability

## Relevant Files
- `path`: why it matters

## Next Move
1. ...

## Knowledge Gaps
<!-- 列出本次摘要无法完整保留的内容，供后续 recall_context 参考 -->
- turn N–M 的完整 shell 输出（search: "关键词"）
- src/xxx.rs 在 turn N 的完整文件内容（search: "文件名 ContextCompressionState"）
```

摘要约束：

- 只摘要对话叙事，不摘要静态上下文；
- 精确错误不得改写；
- 已确认死路不得省略；
- 已回答问题从 Pending 中删除；
- 已解决 blocker 从 Blocked 中删除；
- 最多保留 15–20 个关键文件；
- 摘要长度建议按 token 而非字符控制；
- **必须填写 `Knowledge Gaps`**：列出本次摘要无法完整保留的信息（大体积输出、完整文件内容、原始 stack trace 等），每条附带推荐的 `recall_context` 检索词，格式为括号内 `search: "关键词"`。

### 5.5 Recent Raw Context

建议保留：

- 最近原文按模型窗口动态分配：常见 12k–16k tokens；32k fallback 下必须缩小，不能固定占用 12k–16k；
- 最近 2–4 个完整工具交换；
- 当前 in-flight 用户消息；
- 最近一次错误及完整结果；
- 最近一次修改的 diff 或文件内容；
- 当前 todo / plan。

选择窗口时必须同时扣除 system、tool definitions、checkpoint、ledger、输出预留和安全余量，不能只按最近消息条数或固定 token 数分配。

不要保留：

- 已成功且不再需要的安装日志；
- 旧构建输出；
- 同一文件的重复完整读取；
- 未被引用的搜索页面全文；
- 已完成任务的旧调试日志。

### 5.6 Transcript Store

完整 transcript 必须持久化，并提供工具：

```text
recall_context(query, limit?)
read_transcript_range(messageId, before?, after?)
search_transcript(query, role?, toolName?, limit?)
```

摘要中应附带：

```text
transcriptId
lastSummarizedMessageId
firstKeptMessageId
```

模型在摘要信息不足时可以重新读取精确片段。

**压缩后主动触发机制：** 仅提供工具还不够，压缩后模型不知道自己遗漏了什么。需要两个互补机制：

**机制 A — Checkpoint 中的 `Knowledge Gaps` 字段**（见 §5.4）：摘要模型生成，明确告知哪些细节被压缩、附推荐检索词，模型遇到相关疑问时能精准 recall。

**机制 B — 压缩后系统提示注脚**：压缩完成后在 Static Context 末尾追加一段注脚，不参与下次摘要（通过 message role 或 tag 标记跳过）：

```text
[Compaction Note — turn N]
Context was compacted. Full transcript available via recall_context("<keywords>").
Gaps identified by summarizer — call recall_context if you need details:
  • <gap 1 from Knowledge Gaps>
  • <gap 2 from Knowledge Gaps>
```

每次压缩后覆盖写一次，仅起当轮提醒作用，不累积到下轮摘要中。

---

## 6. 压缩流水线

```text
1. 估算当前请求 token
2. 判断是否接近阈值
3. 先执行 microcompact
4. 判断是否仍超阈值
5. 后台预计算 summary candidate
6. 校验 summary schema
7. 校验 history version / model / auth
8. 选择 recent raw window
9. 重建 static context
10. 组装新的活动上下文
11. 记录 compaction boundary
12. 继续当前 logical step
```

### 6.1 Microcompact

完整摘要之前先清理低价值内容：

1. 截断超过阈值的旧工具输出；
2. 删除旧成功构建日志；
3. 删除重复文件读取；
4. 删除无关搜索结果正文；
5. 保留错误、diff、测试失败和用户要求。

建议先设置工具输出上限：

```text
普通工具结果：8k–16k chars
错误结果：保留首尾各 8k chars
build/test 日志：保留最近 200 行 + 首个失败块
搜索/网页：保留标题、URL、摘要、命中位置
```

### 6.2 阈值策略

建议：

```text
可用输入预算 = context_window - 本次请求实际 max_output_tokens - 安全余量
后台预计算：可用输入预算的 60%–65%
正式压缩：可用输入预算的 80%–85%
输出预留：至少覆盖本次请求真实 max_tokens；当前 WorldBase MAX_TOKENS = 8,192
```

不能简单照搬“最低预留 16k tokens”：WorldBase 当前单次正常请求输出上限是 8,192 tokens，但 Anthropic reasoning 等路径可能调整实际输出预算，因此应以本次请求真实输出参数为准。对于 1M token 模型，也不能按固定 3k 字符摘要处理，应按比例和目标模型能力调整。

改造前差异：旧 `context_warning_threshold` 只做 `window - clamp(15%, 2,048, 8,192)`，没有显式减去实际输出预算。当前已改为 `TokenBudget`，统一扣除实际输出预算和安全余量。

### 6.3 溢出处理

provider 返回 context overflow 时：

1. 只允许一次 emergency compaction；
2. 保持当前 logical step；
3. 重建同一请求；
4. 第二次 overflow 直接终止；
5. 不得无限“压缩 → 重试 → 再 overflow”。

### 6.4 版本一致性

每个压缩候选必须记录：

```text
historyVersion
modelSlug
promptHash
toolCatalogVersion
authOwner
```

采用候选前逐项比较。任一变化则丢弃候选并重新压缩。

---

## 7. 压缩优先级

当 token 不足时，按以下顺序保留：

1. 当前用户最新请求；
2. 用户明确约束和安全要求；
3. 当前阻塞错误和精确错误串；
4. 当前 active/blocked 工作状态；
5. 下一步动作；
6. 最近原始工具交换；
7. 已确认事实；
8. 关键文件路径；
9. capability 清单和用途；
10. 结构化摘要；
11. 更早的对话叙事；
12. 重复搜索、成功日志和已解决中间过程。

---

## 8. 防止“压缩后绕圈”的额外规则

### 8.1 Dead-end Registry

每次压缩必须保留：

```json
{
  "hypothesis": "应用未启动导致 capability 不可发现",
  "result": "invalid",
  "evidence": "capability 调用会自动启动应用",
  "doNotRepeat": true
}
```

压缩后 system prompt 或 checkpoint 中明确写出：

```text
Do not repeat these confirmed dead ends unless new contradictory evidence appears.
```

### 8.2 Progress Fingerprint

记录最近 N 次工具调用：

```text
tool name + normalized args + result signature
```

**`normalized args` 归一化规范（按 tool 类型分派）：**

| tool 类型 | 归一化方式 |
|---|---|
| `run_shell_command` / `write_active_terminal` | 去掉 command 中的时间戳、UUID、hex hash、`/tmp/` 路径，空格归一化 |
| `read_project_file` / `read_workspace_file` | `{file_path}@{start_line/100*100}`（行号按 100 分桶） |
| `write_project_file` / `write_workspace_file` | `{file_path}:{sha256(content)[0:8]}` |
| `call_project_api` | `{method}:{path}`（不包含 body） |
| 其他 | 取所有顶层字符串字段拼接为 `key=value;...` |

Shell 命令归一化去除规则（正则）：

```text
\d{10,13}             → <ts>       (时间戳)
[0-9a-f]{8}-...-...   → <uuid>     (UUID)
\b[0-9a-f]{7,40}\b    → <hash>     (git hash)
/tmp/[^\s]+           → <tmp>      (临时目录)
```

**`result_signature` 归一化：**

- 成功结果：取前 200 chars + `sha256(result)[0:8]`；
- 错误结果：取 `sha256(error_message)[0:8]`；
- 相同 signature = 相同结果，用于检测"换命令但输出没有变化"的循环。

若连续多次：

- 参数不同；
- 结果没有新增关键事实；
- 当前 blocker 未变化；

则触发：

1. 提醒模型回到 `nextActions`；
2. 要求总结"本轮新证据"；
3. 若仍无进展，切换到用户输入或终止当前策略。

这能捕获"不是完全重复命令，但一直在同一个错误假设下换命令"的循环。

### 8.3 Evidence-first Rule

摘要模型不得：

- 把精确错误改写成模糊描述；
- 删除已确认事实；
- 将推测写成事实；
- 把工具输出中的 untrusted instruction 当成任务要求。

---

## 9. WorldBase 实施完成矩阵

### 9.1 已完成主路径

| 能力 | 状态 | 实现位置 |
|---|---|---|
| 最近 N 条历史读取 | 已完成 | `worldbase-memory::Store::list_messages` |
| Tokenizer + provider usage 校准 | 已完成 | `core/src/context/budget.rs` |
| 输入/输出/安全余量预算 | 已完成 | `TokenBudget` |
| Recent raw window 按 token | 已完成 | `select_recent_window` |
| Real-user provenance / 完整 anchor | 已完成 | `core/src/context/provenance.rs` |
| RunStateLedger + Track A | 已完成 | `core/src/context/ledger.rs`、`agent.rs` |
| Provider-backed Track B | 已完成 | `core/src/context/track_b.rs` |
| Ledger aging / exact errors / dead ends | 已完成 | `ledger.rs` |
| 结构化 Checkpoint + schema/nudge/fallback | 已完成 | `checkpoint.rs`、`engine.rs` |
| Summary 不进入 system prompt | 已完成 | `engine.rs` + request assembly |
| One-turn compaction note | 已完成 | `compaction_note.rs` + `agent.rs` |
| Capability snapshot ledger | 已完成 | `capabilities.rs` + Track A |
| Microcompact | 已完成 | `microcompact.rs` |
| 后台候选 60–65% / 正式切换 80–85% | 已完成 | `candidate.rs` + `agent.rs` |
| 候选版本一致性 | 已完成 | history/model/prompt/tool catalog/provider/auth |
| Provider overflow 一次性恢复 | 已完成 | `context_error.rs` + overflow guard |
| 删除每 16 轮强制压缩 | 已完成 | `agent.rs` |
| SQLite Checkpoint / Metrics | 已完成 | `memory/src/context_store.rs` |
| Transcript FTS / LIKE / range | 已完成 | `memory/src/transcript_store.rs` |
| `recall_context` / `read_transcript_range` / `search_transcript` | 已完成 | `tools/src/recall_context.rs`、`transcript_tools.rs` |
| Mobile transcript tool exposure | 已完成 | `tools/src/lib.rs` |
| Recovery telemetry | 已完成 | `mark_latest_compaction_recovered` + `compaction_recovery_rate` |
| 静态上下文在压缩后重建 | 已完成 | `agent.rs` compaction path |

### 9.2 验证结果

最终门禁：

```bash
bash scripts/verify-context-compression.sh
```

全部通过：

- `cargo fmt --all -- --check`
- `cargo test -p worldbase-memory --lib`（29）
- `cargo test -p worldbase-providers --lib`（97）
- `cargo test -p worldbase-tools`
- `cargo test -p worldbase-core`
  - 187 library tests
  - 10 context integration tests
  - 15 context E2E tests
  - 51 general E2E tests
- `cargo check --workspace`

### 9.3 剩余限制

1. Provider-native tokenizer 与 `cl100k_base` 仍可能有小偏差，但输出预留和安全余量独立生效。
2. 没有稳定 provider identity 的自定义 provider 使用 Track B heuristic fallback，避免猜测凭据或模型路由。
3. transcript range 的 not-found/ownership 目前从 Store 错误文本映射，未来可改为 typed error。
4. recovery rate 是工具恢复行为的代理指标，不直接等同于任务语义成功。
5. live-model E2E 仍需显式 API key 和网络环境。

## 10. 建议的数据结构

> 下面是目标数据结构，当前代码中尚不存在。落地时需要同时保存真实 message ID 和版本字段，不能只存摘要文本。

```rust
pub struct CompactionCheckpoint {
    pub id: String,
    pub summary: String,
    pub knowledge_gaps: Vec<KnowledgeGap>,  // 新增：被压缩内容的检索入口
    pub ledger: RunStateLedger,
    pub first_kept_message_id: String,
    pub last_summarized_message_id: String,
    pub transcript_id: String,
    pub history_version: u64,
    pub model_slug: String,
    pub tool_catalog_version: u64,
    pub created_at: String,
}

pub struct KnowledgeGap {
    pub description: String,          // 例如："turn 15–18 的完整 shell 输出"
    pub recommended_search: String,   // 例如："manifest risk write"
}

pub struct RunStateLedger {
    pub objective: String,
    pub latest_user_request: String,
    pub requirements: Vec<String>,
    pub confirmed_facts: Vec<ConfirmedFact>,
    pub critical_errors: Vec<CriticalError>,
    pub capabilities: Vec<CapabilitySummary>,
    pub decisions: Vec<Decision>,
    pub attempts: Vec<Attempt>,
    pub dead_ends: Vec<DeadEnd>,
    pub completed: Vec<String>,
    pub active: Vec<String>,
    pub blocked: Vec<String>,
    pub next_actions: Vec<String>,

    // 老化控制字段
    pub token_budget: usize,           // 默认 4000
    pub current_tokens: usize,         // 实时计算
    pub last_trimmed_at: Option<String>,
}

pub struct ConfirmedFact {
    pub fact: String,
    pub evidence: String,              // tool_call_id | file_path | message_id
    pub timestamp: String,
}

pub struct CriticalError {
    pub message: String,               // 原始精确错误
    pub source: String,                // 工具名或文件路径
    pub exact: bool,                   // 是否逐字保留
    pub tool_call_id: String,
    pub error_signature: String,       // 用于去重
    pub count: usize,                  // 重复次数
}

pub struct Attempt {
    pub tool: String,
    pub args_digest: String,           // 归一化参数摘要
    pub outcome: AttemptOutcome,
    pub error_signature: Option<String>,
    pub turn: usize,
}

pub enum AttemptOutcome {
    Success,
    Error,
}

pub struct DeadEnd {
    pub hypothesis: String,
    pub evidence: String,
    pub do_not_repeat: bool,
}
```

---

## 11. 实施记录

### 11.1 基础设施

- `worldbase-memory` 新增 checkpoint、compaction metrics、messages FTS、LIKE fallback 和 range read。
- `worldbase-providers` 新增 context-overflow classifier。
- `worldbase-tools` 新增三个 transcript recovery 工具并纳入 mobile allow-list。
- `worldbase-core` 新增 `context` 模块，并接入 live `agent.rs` 请求路径。

### 11.2 P0 正确性修复

1. `Store::list_messages` 改为最近 N 条、时间正序返回。
2. `TokenBudget` 显式扣除实际输出预算和安全余量。
3. 删除每 16 轮无条件压缩，改为 60–65% 后台候选、80–85% 正式切换。
4. Provider context overflow 只允许一次 emergency compaction。
5. Real-user anchor 使用持久化 message ID，synthetic/tool image 不得覆盖。
6. 精确错误在 Track A 同步写入 Ledger。
7. Summary/checkpoint 只作为 tagged user-role evidence，不进入 system prompt。
8. Microcompact 在完整摘要前清理低价值旧输出。

### 11.3 P1 结构化状态与恢复

1. `RunStateLedger` 保存 objective、requirements、facts、critical errors、capabilities、decisions、attempts、dead ends、work state 和 next actions。
2. Track A 同步记录 tool attempt、exact error 和 capability snapshot。
3. Track B 使用 active provider 的严格 JSON prompt，失败回退 heuristic，并拒绝 stale/out-of-order updates。
4. Structured checkpoint 使用 schema validation、一次 nudge 和 deterministic fallback。
5. Compaction boundary、transcript ID 和版本字段持久化到 SQLite。
6. 压缩后注入一次性 compaction note，包含 knowledge gaps 和 recall 提示。
7. 三个 transcript 工具通过 conversation-scoped memory APIs 恢复原文证据。
8. 成功 recovery 会标记最近一次 compaction，并可通过 `compaction_recovery_rate` 汇总。

### 11.4 P2 性能与观测

- 后台摘要候选不阻塞当前 turn，并在 version mismatch 时丢弃。
- Microcompact 降低摘要输入体积。
- Metrics 记录 before/after tokens、latency、reason 和 recovery_used。
- Token estimator 使用 provider usage 做有界校准。
- Static context 在成功 compaction 后重建。

### 11.5 最终验证

```bash
bash scripts/verify-context-compression.sh
```

结果：rustfmt、memory、providers、tools、core 和 workspace check 全部通过。

## 12. 当前验收标准与结果

### 功能验收

1. 连续压缩 5 次后，原始目标和最新用户要求仍存在；
2. 连续压缩 5 次后，精确错误字符串仍逐字存在；
3. 已确认 dead end 不会在压缩后重新尝试；
4. 最近原始窗口按模型窗口动态分配，且关键工具结果可被模型访问；
5. 摘要遗漏时可通过 transcript 检索恢复；
6. 压缩后工具定义、权限、项目 capability 不来自旧摘要；
7. 压缩失败不会产生空摘要或伪摘要；
8. 同一 logical step 在 overflow 后最多重试一次完整压缩。

### 质量指标

| 指标 | 建议目标 |
|---|---:|
| 精确错误保留率 | 100% |
| 用户要求保留率 | 100% |
| 已确认 dead end 保留率 | 100% |
| 最近关键工具结果可恢复率 | 100% |
| 摘要 schema 合法率 | > 99% |
| 压缩后重复无效探索率 | < 5% |
| 压缩 P95 延迟 | < 5 秒或完全后台化 |
| 压缩后任务继续成功率 | > 95% |

### 回归测试

- 任意 `manifest_invalid:` 精确错误在 5 次压缩后仍逐字存在；
- 超过 400 条历史后，当前用户消息仍进入模型请求；
- 压缩后 summary 不被提升为 system prompt；
- 32k fallback 下输入预算、输出预算和安全余量之和不超过窗口；
- 用户中途改变要求后，压缩不恢复旧目标；
- 当前工具调用尚未完成时不得压缩掉该调用；
- 长输出 shell 日志不会挤掉最近错误；
- 同一个失败命令重复出现时，只保留一次并增加计数；
- transcript 查询能找回被摘要掉的代码片段和错误原文。

---

## 13. 结论

本次改造已把原来的“同步摘要 + 目标锚点”路径升级为分层上下文系统：

```text
静态上下文重建
+ 确定性 RunStateLedger
+ Provider-backed Track B
+ 结构化 Checkpoint
+ token-aware Recent Raw
+ 可检索 Transcript Store
+ 版本化后台预计算
+ microcompact
+ overflow 一次性恢复
```

最终状态是：

```text
精确错误和真实用户请求可保留
+ 死路和执行状态可继承
+ 摘要遗漏可从 transcript 恢复
+ compaction 不再污染 system prompt
+ provider overflow 不再无限重试
```

推荐改为：

```text
静态上下文重建
+ 确定性 RunStateLedger
+ 结构化 Checkpoint
+ 最近原文窗口
+ 完整 Transcript Store
+ 后台预压缩
+ microcompact
```

这不是单纯增加摘要长度，而是把“稳定状态”“任务状态”“叙事摘要”“原始证据”分层管理。

最终目标：

1. 压缩后模型仍知道目标；
2. 仍知道已经确认了什么；
3. 仍知道什么路已经走不通；
4. 仍能读取精确错误和代码片段；
5. 仍能继续下一步，而不是重新探索。

---

## 参考资料

- OpenAI Codex CLI 文档：https://learn.chatgpt.com/docs/codex/cli
- OpenAI Codex 源码：`openai/codex@5045589550122ec4f073d10e3d66a0813bcb7be0`
  - `codex-rs/prompts/templates/compact/prompt.md`
  - `codex-rs/core/src/compact.rs`
  - `codex-rs/core/src/session/async_compaction.rs`
  - `codex-rs/core/src/context/compaction_summary.rs`
- OpenCode 源码：`anomalyco/opencode@73abe63ac23224d88e739e7028882e547ef65a79`
  - `packages/core/src/session/compaction.ts`
  - `specs/v2/session.md`
- ZCode 3.15.1 本机安装包
  - `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`
- WorldBase 当前实现
  - `harness-rs/crates/core/src/agent.rs`
  - `harness-rs/crates/memory/src/lib.rs`
  - `harness-rs/crates/providers/src/anthropic.rs`
  - `harness-rs/crates/protocol/src/application.rs`
  - `harness-rs/crates/tools/src/project_tools.rs`
