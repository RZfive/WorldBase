# WorldBase 跨 Agent、跨对话共享记忆与 Embedding 架构

**状态**：设计基线
**日期**：2026-09-24
**适用范围**：Electron 桌面端、Rust Harness、未来 Flutter/IM 入口

## 1. 决策摘要

WorldBase 的记忆不再以 Agent 为所有者，而以本地用户为主要所有者。所有 Agent、所有 conversation 都通过同一个 Memory Service 访问用户级共享记忆；项目、群组、频道和 Agent 专属内容使用更窄的 scope。

语义记忆采用以下组合：

```text
SQLite                 事实数据、来源、状态、任务、FTS5
sqlite-vec             可选的向量 KNN 索引（索引文件本地保存）
Embedding Model        文本 -> 固定维度向量
Memory Service         权限、写入、索引、召回、重排
Conversation Summary   跨对话回忆的主要检索文档
```

向量模型不放入应用本地，也不随应用安装包下载。用户必须在供应商配置中添加可用的 embedding 模型，再在 Memory Settings 中选择当前模型。没有配置当前 embedding 模型时，系统只使用 SQLite/FTS5，不创建、不写入、不查询向量数据库。

当前不引入 Qdrant Server、Milvus 等外部服务。sqlite-vec 只作为已启用 embedding 模型时的本地派生索引；未来如果需要更大规模、HNSW/量化或远程同步，可在不改变 Memory Service 接口的情况下增加其他 VectorIndex 实现。

## 2. 必须区分的三个模型

### 2.1 Chat Model

负责回答用户问题、执行工具和参与对话。当前项目的 `AIEngine`、Rust Harness provider 都属于这一层。

### 2.2 Memory Analysis Model

负责从对话中提取候选记忆、生成对话摘要、合并冲突和判断重要性。它可以复用一个聊天模型，但它不是 embedding 模型。

### 2.3 Embedding Model

负责把可检索文本转换成向量：

```text
embedding_text -> Float32Array[dimensions]
```

保存语义向量时必须先调用 embedding 模型。向量数据库不会自动理解原文；它只保存向量并执行近邻搜索。查询时也必须用同一个 embedding 模型生成 query vector，且模型版本、维度、预处理方式和距离度量必须匹配。

embedding 模型文件不放进应用或用户数据目录。数据库只保存供应商、模型标识、模型版本、维度和输入模板等指纹；真正的向量由供应商 API 生成。

## 3. 目标范围

### 3.1 跨 Agent

用户确认的偏好、长期目标、兴趣、沟通习惯和长期约束放入：

```text
scopeType = user
scopeId   = local-user
```

只要全局记忆设置允许，任何 Agent 都能读取。

### 3.2 跨 conversation

跨 conversation 需要同时支持两类召回：

1. **用户记忆**：用户是谁、喜欢什么、当前长期目标是什么。
2. **历史情景**：之前讨论过什么、做过什么决定、哪些事情还没有完成。

因此不能只保存 `memory_entries`，还要保存并向量化 `conversation_summaries`、决策和重要历史片段。

### 3.3 当前上下文与长期记忆分离

原始聊天记录仍由 conversation/session 日志保存，不直接全部注入新对话。长期层保存精炼后的记忆，语义索引保存可检索的摘要和重要片段。

## 4. 总体架构

```text
                         ┌──────────────────────┐
                         │ Renderer / Chat UI   │
                         └──────────┬───────────┘
                                    │ IPC / preload
                                    ▼
                         ┌──────────────────────┐
                         │ Main Memory Service  │
                         │ 权限、策略、召回、写入 │
                         └──────┬─────────┬─────┘
                                │         │
                ┌───────────────┘         └────────────────┐
                ▼                                          ▼
       ┌─────────────────┐                         ┌──────────────────┐
       │ memory.sqlite   │                         │ EmbeddingService │
       │ 事实与 FTS5      │                         │ 供应商 embedding  │
       └────────┬────────┘                         └────────┬─────────┘
                │                                           │
                └──────────────────┬────────────────────────┘
                                   ▼
                         ┌──────────────────────┐
                         │ memory-vector.sqlite │
                         │ sqlite-vec 派生索引  │
                         └──────────────────────┘
```

Rust Harness 和冻结的 TypeScript Agent Loop 必须使用同一个 Memory Service。不能让 Rust 和 Electron 各自维护一套用户共享记忆，否则跨后端运行时会出现召回不一致。

## 5. 数据分层

### 5.1 主数据库：`memory.sqlite`

主数据库是事实来源。

```text
memory.sqlite
├── memory_entries
├── conversation_summaries
├── memory_events
├── embedding_documents
├── embedding_jobs
├── embedding_generations
└── FTS5 virtual tables
```

### 5.2 向量数据库：`memory-vector.sqlite`

向量数据库是可删除、可重建的投影。

```text
memory-vector.sqlite
├── vector_row_map
└── vec_documents_<generation>
```

分成两个文件的原因：

- 向量扩展加载失败时，普通记忆仍然可读。
- 模型更换时可构建新索引再切换。
- 索引损坏时可以从主数据库重建。
- 主数据库备份不依赖具体向量引擎。

## 6. 主要数据结构

### 6.1 `memory_entries`

现有 `MemoryEntry` 继续作为兼容基础，新增以下治理字段：

```text
status             active / pending_confirmation / superseded / deleted
sensitivity        normal / sensitive
evidence_count     被多少次对话或用户确认支持
last_confirmed_at  最近一次用户确认时间
expires_at         阶段性偏好的过期时间，可为空
```

`sourceConversationId` 和 `sourceMessageIds` 用于溯源，不用于判断共享权限。

### 6.2 `conversation_summaries`

```text
id
conversation_id
user_id
project_id
title
summary
topics_json
decisions_json
open_questions_json
important_message_ids_json
content_hash
summary_model_id
summary_model_revision
created_at
updated_at
```

每个 conversation 至少维护一个滚动摘要；关键决策和未完成事项可以作为独立检索文档。

### 6.3 `embedding_documents`

它是业务数据和向量索引之间的稳定中间层。

```text
id
source_type          memory / conversation_summary / decision / chunk
source_id
scope_type
scope_id
embedding_text       送给 embedding 模型的规范化文本
content_hash
active_generation_id
status               queued / indexing / indexed / failed
retry_count
last_error
created_at
updated_at
```

保存 `embedding_text` 是为了以后可以基于同一输入重建向量。原始聊天正文不应直接作为默认 embedding 文本。

### 6.4 `embedding_jobs`

```text
id
document_id
generation_id
status               queued / running / succeeded / retry / failed / canceled
attempts
next_retry_at
error_message
created_at
updated_at
```

主数据写入和任务入队在同一个 SQLite transaction 中完成；真正的 embedding 和向量写入异步执行。

### 6.5 `embedding_generations`

不同模型、版本或维度不能混用一个向量空间。

```text
id
provider_id
model_id
model_revision
dimensions
distance_metric     cosine / dot / l2
normalized
preprocess_version
index_path
status              building / active / retired / failed
total_documents
indexed_documents
failed_documents
created_at
activated_at
```

### 6.6 sqlite-vec 表

具体维度由 generation 决定，以下是 768 维示例：

```sql
CREATE VIRTUAL TABLE vec_documents_v1 USING vec0(
  scope_key TEXT partition key,
  document_kind TEXT,
  embedding FLOAT[768] distance_metric=cosine,
  +document_id TEXT
);
```

因为 `vec0` 的 `rowid` 和业务文档 ID 是两套标识，向量数据库中还要保存：

```text
vector_row_map
- document_id
- vector_rowid
- generation_id
- content_hash
- indexed_at
```

## 7. Embedding Service

### 7.1 接口

```ts
interface EmbeddingModelDescriptor {
  providerId: string
  modelId: string
  modelRevision?: string
  dimensions: number
  distance: 'cosine' | 'dot' | 'l2'
  normalized: boolean
  preprocessVersion: string
}

interface EmbeddingService {
  describe(): Promise<EmbeddingModelDescriptor>
  embedDocuments(texts: string[]): Promise<Float32Array[]>
  embedQuery(text: string): Promise<Float32Array>
  health(): Promise<EmbeddingHealth>
}
```

### 7.2 远程实现

本项目只支持远程 embedding。Embedding 模型不下载到本地，不进入安装包，也不由 Rust/Electron 运行时加载。记忆文本通过供应商配置的 embedding 接口生成向量。

API Key、Base URL 和聊天模型配置继续由供应商保存，但 embedding 模型必须作为供应商下的独立模型列表配置，不能默认复用 `activeModel`。

建议的共享类型：

```ts
interface ProviderEmbeddingModel {
  id: string
  dimensions?: number
  maxInputTokens?: number
  distance?: 'cosine' | 'dot' | 'l2'
  normalized?: boolean
  queryPrefix?: string
  documentPrefix?: string
  enabled?: boolean
}

interface AIProvider {
  // existing chat provider fields...
  embeddingModels?: ProviderEmbeddingModel[]
  embeddingProtocol?: 'openai-embeddings'
}
```

`dimensions` 可以在供应商模型配置中填写，也可以在首次健康检查时从接口结果中确认。第一次生成向量后必须锁定维度，后续不能在同一个 generation 中改变。

Memory Settings 负责选择当前使用的供应商和模型：

```ts
interface MemoryEmbeddingSettings {
  enabled: boolean
  providerId?: string
  modelId?: string
}
```

供应商配置负责“有哪些 embedding 模型可用”，Memory Settings 负责“记忆当前使用哪一个”。这样可以在不改 Agent 配置的情况下切换全局记忆模型。

### 7.3 未配置模型时的行为

当 `MemoryEmbeddingSettings.providerId` 或 `modelId` 为空，或者模型已经从供应商配置中删除时：

- Memory Service 仍然保存文字记忆和 conversation 摘要。
- FTS5 关键词检索继续工作。
- 不创建 `memory-vector.sqlite`。
- 不创建 embedding job。
- 不调用供应商 embedding API。
- 不执行向量召回或向量重排。

如果用户清空了原有 embedding 设置，应停止任务队列、关闭向量数据库，并删除或隔离派生向量文件；主数据库中的文字记忆、来源和 FTS5 索引保留。之后重新配置模型时，再从主数据库批量重建 generation。

### 7.4 远程请求边界

远程 embedding 请求只由 Main 进程发起，Renderer 和 Agent 都不能直接访问 embedding API。

```text
Renderer / Agent
  └── Memory Service
        └── ProviderEmbeddingClient
              ├── provider.baseUrl
              ├── provider.apiKey
              └── provider.embeddingModels[modelId]
```

### 7.5 文本规范化

不同 embedding 模型可能要求不同的 query/document 前缀。因此预处理必须版本化：

```text
document input:
passage: 用户喜欢先看到结论，再阅读详细解释。

query input:
query: 用户偏好的回答方式是什么？
```

不能只保存模型名称而忽略输入模板。模板发生变化时也需要建立新的 generation。

## 8. 供应商 Embedding 模型与容量性能

本方案不在本地保存 embedding 模型权重，因此本地磁盘和内存不再包含模型下载及推理运行时。需要关注的是：向量索引、远程请求延迟、供应商配额和批量索引成本。

### 8.1 供应商模型配置要求

供应商配置页面需要支持：

- 添加一个或多个 embedding 模型 ID。
- 可选填写向量维度。
- 可选填写最大输入 token 数。
- 选择距离度量，默认 `cosine`。
- 配置 query/document 前缀或输入模板。
- 对 embedding 模型执行连接和维度探测。
- 删除模型前检查是否正在被 Memory Settings 使用。

当前聊天模型列表和 embedding 模型列表必须分开显示：

```text
聊天模型：gpt-xxx、claude-xxx、...
Embedding 模型：text-embedding-xxx、bge-xxx、...
```

不能把所有聊天模型都显示成可用于记忆向量的模型，也不能根据模型名称猜测它支持 `/embeddings`。

### 8.2 向量索引占用

如果使用 `Float32` 向量：

```text
索引原始向量大小 ≈ 文档数量 × 维度 × 4 bytes
```

| 文档数 | 384 维 | 512 维 | 768 维 | 1024 维 |
|---:|---:|---:|---:|---:|
| 1,000 | 1.5 MB | 2.0 MB | 3.1 MB | 4.1 MB |
| 10,000 | 15 MB | 20 MB | 31 MB | 41 MB |
| 100,000 | 154 MB | 205 MB | 307 MB | 410 MB |
| 500,000 | 768 MB | 1.0 GB | 1.5 GB | 2.0 GB |

以上只计算向量本体。还应为 SQLite page、metadata、映射表和索引内部结构预留额外空间。产品设计上不要默认把每条原始消息都向量化；优先向量化长期记忆、conversation 摘要、决策和重要片段。

### 8.3 性能判断

远程 embedding 的主要成本是网络请求和供应商推理，不是本地 sqlite-vec 查询。一次交互式查询的路径是：

```text
用户消息
  └── 远程 embedding 请求   主要耗时
        └── sqlite-vec KNN  通常是次要耗时
              └── SQLite 取正文、重排、Prompt 注入
```

性能受以下因素影响最大：

1. 供应商 API 网络距离和连接复用。
2. embedding 模型和供应商侧推理时间。
3. 输入 token 数量和 batch size。
4. 供应商限流、并发和配额。
5. 本地 sqlite-vec 的文档数量和作用域过滤。
6. 是否缓存相同 query 的 embedding。

向量索引本体只保存向量和文档 ID，不保存模型权重。只要文档数量受控，启用向量存储不会引入本地模型常驻内存；本地内存主要来自 SQLite page cache 和请求 batch。

产品性能目标建议定义为：

```text
embedding API P95              <= 800 ms（普通短查询，供应商依赖）
query embedding + KNN P95      <= 1200 ms（普通短查询）
单次聊天注入                   向量检索 + FTS + 重排 <= 1500 ms 目标
后台批量索引                   使用 batch，遵守供应商限流和预算
没有 embedding 配置             不能产生 embedding 网络请求
```

这些是验收目标，不是当前已测结果。供应商延迟不可控时，聊天首轮可以先使用 FTS5 和已有记忆，向量召回异步补充；不能让 embedding 请求失败导致普通聊天失败。

## 9. 当前向量模型选择策略

### 9.1 没有模型时

默认状态为关闭语义向量：

```text
MemoryEmbeddingSettings.enabled = false
memory-vector.sqlite 不存在
Memory Service = SQLite + FTS5
```

用户仍然可以保存文字记忆、搜索记忆和跨 conversation 的关键词摘要。配置 embedding 模型后，系统才创建向量索引并回填已有文档。

### 9.2 已配置模型时

Memory Settings 中选择：

```text
providerId = provider_x
modelId    = embedding-model-y
```

系统读取该供应商的 API Key、Base URL 和 embedding 模型参数，生成新的 embedding generation，然后异步回填记忆和 conversation 摘要。

### 9.3 切换或清空模型

切换模型不能直接覆盖旧 generation：

```text
创建新 generation
  -> 从主数据库批量调用新供应商模型
  -> 新索引构建完成
  -> 切换 active_generation_id
  -> 删除旧派生索引
```

清空模型配置时：停止 embedding job、关闭并删除派生向量库、保留文字记忆和 FTS5；以后重新配置时从主数据库重建。

## 10. 写入流程

### 10.1 用户明确要求记住

```text
memory_save
  1. Main 校验 scope 和全局记忆策略
  2. 写入 memory_entries
  3. 如果已配置当前 embedding 模型，生成 embedding_documents
  4. 如果已配置当前 embedding 模型，写入 embedding_jobs
  5. 返回 saved + embeddingStatus（indexed / pending / disabled）
  6. 仅在启用状态下后台完成 embedding 和 vector upsert
```

向量生成失败时，不能丢失用户明确保存的文字记忆；状态应为 `pending` 或 `failed`，之后自动重试。

### 10.2 对话结束

```text
chatStream done
  ├── 异步更新 conversation summary
  ├── 提取长期记忆候选
  ├── 用户确认或按全局策略激活
  └── 已配置 embedding 模型时批量进入 embedding queue
```

不要让远程 embedding API 阻塞聊天流的最终回复。

### 10.3 更新和删除

`content_hash` 未变化时不重复生成 embedding。记忆更新时创建新任务；删除时立即删除主记录，并通过可靠任务删除对应向量。向量删除失败时必须保留 tombstone，防止旧记忆继续被召回。

## 11. 召回流程

```text
当前用户消息
  ├── query embedding
  ├── sqlite-vec 向量召回
  ├── FTS5 关键词召回
  ├── 按允许 scope 过滤
  ├── importance/confidence/recency 重排
  ├── 去重和冲突处理
  └── token budget 内注入 Prompt
```

基础记忆、相关用户记忆、相关历史摘要分别设置数量上限。默认只注入少量高质量内容，不能把整个用户画像或所有历史摘要塞进每轮 Prompt。

检索内容必须被标记为“记忆参考资料”，Agent 不能把记忆中的旧指令当作当前用户指令。当前用户的新陈述优先于旧记忆。

## 12. Rust / Electron 接入边界

当前仓库已经存在两套 memory 入口：Electron 的 `MemoryStore/MemoryEngine` 和 Rust Harness 的 `memory.*` RPC。共享记忆上线前必须统一所有权。

推荐：

```text
Main Memory Service = 用户共享记忆的唯一事实来源
Rust Harness         = 通过 host RPC 调用 search/save/forget
TypeScript Engine    = 通过同一个 Memory Service 调用
Renderer             = 只经 IPC 调用，不直接打开数据库
```

需要调整的主要位置：

- `apps/electron/src/main/ai-engine/memory/memory-store.ts`：保留主数据库和 FTS5。
- `apps/electron/src/main/ai-engine/memory/memory-engine.ts`：改为 Memory Service 的兼容 facade。
- 新增 `embedding-service.ts`、`sqlite-vector-index.ts`、`memory-job-queue.ts`。
- `apps/electron/electron/main-process/ai/agent-context.ts`：TS 和 Rust 都走统一召回。
- `apps/electron/electron/main-process/ipc.ts`：memory CRUD 改为调用 Memory Service。
- `apps/electron/electron/main-process/services.ts`：初始化主库、向量库、Embedding Service 和队列。
- `apps/electron/electron/main-process/state.ts`：增加 `memoryService`、`embeddingService` 和 index status。
- `apps/electron/electron/preload.ts` / `env.d.ts`：增加 index status、rebuild、embedding settings API。

Rust Harness 不应再拥有一份与 Electron 不一致的用户共享向量索引。Rust 可以作为供应商 API 的适配层，但主数据库、索引和模型选择仍由 Memory Service 管理。

## 13. Electron 打包和运行时要求

`sqlite-vec` 是原生 SQLite 扩展，必须按目标平台处理：

- macOS arm64/x64
- Windows x64
- Linux x64/arm64（如果发布）
- `asarUnpack` 或 `extraResources` 中放置可加载的扩展文件
- macOS 动态库签名和 notarization
- 开发环境和打包 App 都执行扩展加载测试

`openSqliteDatabase()` 只在打开向量数据库时允许加载扩展，普通 SQLite 连接保持关闭扩展能力。应用启动时应检查：

```text
extension loaded
vec_version available
dimension matches generation
active index readable
```

## 14. 远程 Embedding 与索引 benchmark 计划

供应商模型的质量 benchmark 不能直接等同于 WorldBase 的实际延迟。需要固定 API、网络和索引条件，建立自己的 benchmark：

```text
平台：macOS arm64、Windows x64、Linux x64
供应商：provider id、base URL、API protocol
模型：供应商配置中的 embedding model id
输入：64、256、512、1024 tokens
batch：1、8、32（以供应商接口支持为准）
指标：网络耗时、API 总耗时、P50/P95、失败率、限流、成本、索引写入速度
```

测试集至少包含：

1. 中文用户偏好改写。
2. 中文与英文混合项目术语。
3. 代码问题和自然语言问题的对应关系。
4. 跨 conversation 的历史决策查询。
5. 相似但不应命中的用户记忆。

验收指标：

```text
semantic recall@5
semantic recall@10
false injection rate
P50/P95 query latency
embedding API error rate
embedding API cost
每分钟后台索引文档数
```

如果某个供应商模型的召回提升不能覆盖其 API 延迟、失败率和成本，就不应作为默认模型。模型选择以 WorldBase 自己的记忆查询数据集为准，而不是只看供应商宣传或通用 benchmark。

## 15. 记忆设置页

独立的 Memory Settings 页面需要提供：

- 记忆总开关。
- 自动记忆模式：仅明确保存、建议确认、自动保存。
- Embedding 模式：使用供应商模型、暂停语义索引。
- 当前供应商、模型 ID、模型版本、维度和距离度量。
- 从已配置的供应商模型中选择当前记忆模型。
- 连接测试、维度探测、切换和重建索引。
- 远程请求状态、配额和预计成本。
- 向量索引状态、队列数量、失败数量和最近错误。
- 共享用户记忆、历史对话、项目记忆的独立开关。
- 远程 embedding 隐私提示。

Agent 设置页只保留“是否允许读取用户共享记忆”等能力权限，不再管理用户级记忆库和 embedding 模型。

## 16. 分阶段实施

### P0：Embedding 基础设施

- `EmbeddingService` 接口和 fake provider。
- `embedding_documents/jobs/generations` 表。
- sqlite-vec 加载、KNN 和重建测试。
- `memory-vector.sqlite` 派生索引。
- 对现有手工保存记忆建立 embedding。

### P1：供应商 Embedding 模型

- Provider 配置中的 embedding 模型列表和模型参数。
- OpenAI-compatible `/embeddings` 请求适配。
- 连接测试、维度校验、批量请求和限流重试。
- 远程请求隐私提示、失败状态和成本记录。

### P2：跨 conversation

- conversation rolling summary。
- 决策、未完成事项和重要片段文档。
- 向量 + FTS5 混合召回。
- `memory_search` 和 `conversation_search` 工具。

### P3：质量与迁移

- 记忆质量测试集。
- generation 双索引重建。
- 模型切换和断点续建。
- Windows/Linux 兼容性验证。

## 17. 最终选型

第一版确定为：

```text
事实存储：             SQLite
关键词检索：           FTS5
语义索引：             已配置模型时使用 sqlite-vec
Embedding 来源：       Provider 配置中的远程模型
未配置模型：           只使用 SQLite + FTS5，不使用向量存储
模型选择：             全局 Memory Settings
索引所有权：           Main Memory Service
Rust 角色：            Provider API adapter / host adapter
向量库真相：           不作为事实来源，可重建
```

核心原则是：**模型负责产生向量，SQLite/向量索引负责保存和召回，Memory Service 负责决定什么可以被记住、谁可以读取以及哪些记忆可以进入 Prompt。**
