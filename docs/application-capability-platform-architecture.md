# WorldBase 应用能力平台架构

## 1. 目标与边界

把 WorldBase 已安装、内置或托管的应用能力纳入统一目录，让 Agent 能先发现适合当前任务的能力，再按需启动应用并调用其操作。每个应用不需要修改 Agent 主循环；新增应用遵循同一份能力契约即可接入。

这里的“应用”包括：

- WorldBase 内置功能和宿主服务，例如文档、图片、工作区和项目管理。
- WorldBase 创建或托管的 Web 项目、轻应用。
- 通过受信任插件接口接入的本地或远程应用。
- MCP 服务。MCP 继续作为外部服务适配器，不取代内部应用协议。

架构目标是**可扩展的应用能力目录**，不是绕过授权后任意控制任意软件。应用层向 AI 暴露的都是有版本、有 schema、有权限声明的操作接口；AI 不把打开窗口、点击界面或任意 IPC 当作应用业务 API。只有需要人工查看/确认的场景才使用 UI。没有业务接口的旧应用应先补接口，UI automation 仅作为隔离的兼容能力，不进入默认应用接入路径。

## 2. 设计原则

1. **应用只暴露接口**：Agent 调用应用 operation API，不把 UI 自动化当成业务集成协议。
2. **Rust 优先、进程内优先**：通用目录、检索、schema 校验、权限、调度和可移植业务工具使用 Rust；能够作为 crate 接入的第一方应用优先实现 Rust provider 并进程内调用。
3. **少量工具进入主上下文**：完整目录不直接发给模型；固定的检索工具按需推荐少量能力，schema 只在匹配后注入。
4. **桥接只用于平台边界**：Electron HostBridge 仅承接窗口、系统文件选择、OS 凭证等 Rust 无法直接拥有的桌面 API；不为每个应用操作新增一条专用 Electron IPC/HostBridge。
5. **稳定目录，多种受控 provider**：第一方 Rust、受控本地 RPC、远端 MCP 都遵循统一 provider 契约；外部程序不加载任意 Rust 动态库。
6. **用户授权绑定范围**：授权绑定应用、操作、数据范围和运行方式；新版本新增权限时重新询问。

## 3. 总体结构

```text
用户任务
   │
   ▼
Rust Agent Loop ── 基础工具（常驻） + search_tools（常驻）
   │                           │
   │                           ▼
   │                 Rust Tool/Capability Catalog
   │        基础工具 + 外部 Skill、MCP、应用能力及其 schema
   │                           │
   │            Rust 本地检索 → 返回候选给当前主模型判断
   │                           │
   │         仅把 top-k 描述/schema 挂到本 run 下轮请求
   ▼
Agent 调用 app__{app}__{capability}(arguments)
   │
   ▼
Capability Dispatcher
   schema 校验 → policy/approval → scope 校验 → timeout/cancel
   │
   ├── Rust native provider ───────────────┐
   ├── Electron platform adapter ── HostBridge │
   ├── Managed app RPC ── scoped loopback  │
   └── MCP adapter                         │
                                           ▼
                                  Application Runtime Manager
                                  检查/按需启动/健康检查/复用
                                           │
                                           ▼
                              应用执行 operation 并返回结构化结果
```

**职责归属**

| 组件 | 责任 | 建议落点 |
|---|---|---|
| 应用目录与来源适配 | 发现内置 Rust provider、托管应用和 MCP；校验 manifest；记录状态/版本 | Rust 是 canonical catalog owner；Electron 只报告平台运行状态 |
| Tool Registry | 维护 canonical app/capability ID、schema、来源和 provider 路由 | `harness-rs/crates/core`；稳定 DTO 放 `protocol` |
| Discovery / 候选召回 | 本地索引召回候选，当前主模型决定要用哪一个 | Rust `core` + `tools` |
| Dispatcher/Policy | schema 校验、权限、审计、超时、取消、重试和错误归一化 | Rust `core`；复用现有 Permission/Tool 流程 |
| Runtime Manager | 确保应用可用、复用实例、健康检查和关闭策略 | Rust 统一管理；仅 OS 特有生命周期经最小 Electron adapter |
| Provider adapter | 将统一 operation 调用转成 Rust crate、本地 RPC 或 MCP | Rust `tools`/`mcp-client`；Electron 仅提供少量平台 adapter |
| 应用工作台 | 供用户安装、启用、授权、查看状态和撤销应用 | Electron renderer；移动端展示可用子集 |

Rust 是 canonical catalog、策略、provider 路由和最终调用权限的权威。第一方应用 crate 可直接向 Rust registry 注册 provider；MCP/远端应用由 Rust adapter 加入目录。Electron 只同步其拥有的 OS/UI 状态和托管项目增删/启停事件，不持有另一份可执行工具目录。目录变更使用 `catalog_version`、`manifest_hash` 和 provider 版本；应用移除或权限变更时，Rust 使受影响的 run 目录失效并要求重新检索。

## 4. 目录数据模型

### 4.1 应用 Manifest

应用提供受版本控制的声明文件，例如内置应用在代码中内嵌，托管项目在 `.worldbase/app-capabilities.json` 中声明。Manifest 只描述能力，不允许声明任意 shell 命令、任意 IPC channel 或任意 URL。

```json
{
  "schemaVersion": 1,
  "app": {
    "id": "worldbase.tasks",
    "name": "Tasks",
    "version": "1.2.0",
    "description": "Manage tasks and project plans",
    "tags": ["tasks", "planning"],
    "platforms": ["desktop", "mobile"],
    "requiredFeatures": ["interactive"],
    "excludedFeatures": []
  },
  "runtime": {
    "kind": "host-service",
    "activation": "on-demand",
    "healthCheck": "tasks.health"
  },
  "capabilities": [
    {
      "id": "task.search",
      "title": "Search tasks",
      "description": "Find tasks by query, status, or due date",
      "inputSchema": {
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
        "additionalProperties": false
      },
      "outputSchema": {"type": "object"},
      "operation": "tasks.search",
      "risk": "read",
      "permissions": ["tasks.read"],
      "dataScopes": ["selected_workspace"]
    }
  ]
}
```

### 4.2 校验与身份

- `app.id`、`capability.id` 在一个安装作用域内唯一；注册表拒绝重名、保留前缀冒充和 schema 超限。
- 对外 tool name 由注册表生成，例如 `app__worldbase_tasks__task_search`；调用身份映射回不可变的 `(source_id, app_id, capability_id, manifest_version)`，模型不能自行改写 provider 路由。
- `inputSchema` 使用受限 JSON Schema 子集；校验深度、数组/字符串长度和 payload 大小，拒绝 schema 中的远程 `$ref`。
- `platforms` 只是第一层过滤；最终可见性必须取 `platforms`、`requiredFeatures`/`excludedFeatures`、宿主 capability negotiation、移动端工具白名单和 run policy 的交集。Manifest 不能借平台声明提升宿主权限。
- `dataScopes` 表示应用声明的可选范围，不是调用参数。真实 scope 由宿主的项目选择、conversation context 和用户 grant 解析，dispatcher 拒绝模型自行传入或扩大的 scope。
- 项目自带 manifest 属于**未受信任声明**：默认不可执行；用户启用后仍只允许它映射到托管 app RPC provider。内置/签名插件可通过来源策略获得不同信任等级。
- 工具描述、应用返回内容和 UI 中读取的内容都视为不可信输入；不得将其解释成新增权限或覆盖系统策略的指令。

### 4.3 目录记录

规范化记录包含：

```text
ApplicationRecord {
  source_id, app_id, name, version, description, tags,
  trust_level, enabled, platforms, runtime_kind,
  capabilities[], health, last_seen_at, manifest_hash
}
CapabilityRecord {
  app_id, capability_id, tool_name, description,
  input_schema, output_schema, risk, permissions,
  data_scopes, provider_ref, availability
}
```

运行状态（installed / enabled / ready / starting / failed / unavailable）与静态 manifest 分开保存。Manifest 更新时重新校验 schema、权限差异和 provider 映射，并对缓存目录做版本化失效。

### 4.4 应用开发期的 AI 接入契约

AI 接入必须在应用创建和设计阶段完成，不应等应用做完后再靠 UI 自动化“教会 AI 怎么点”。应用的 capability 是面向业务任务的接口；界面和 AI provider 调用同一领域 service，不能把 UI event handler、renderer IPC 或数据库表直接暴露给模型。

WorldBase 的应用模板/脚手架应在创建应用时生成 AI 接入骨架。新应用默认要求至少声明一个 capability；确实是纯展示、没有可执行业务操作的应用可以在模板中声明 `aiIntegration: "none"` 并说明原因，不能静默漏掉接入。脚手架至少生成：

- 稳定的 `app_id`、应用版本和 capability manifest。
- 一个示例 operation 的输入/输出类型、实现 stub 和调用说明。
- 权限、风险级别、数据范围、幂等和副作用声明。
- `AI_INTEGRATION.md`，说明用户会怎样用自然语言请求它、每个 operation 何时适用/不适用、前置条件、典型输入和结果。
- schema/manifest 验证命令和 capability contract test 骨架。

两种应用实现方式共享同一个 capability contract：

| 应用类型 | 开发者实现 | Agent 调用路径 |
|---|---|---|
| WorldBase 第一方/同仓 Rust 应用 | Rust domain service + capability provider trait；descriptor 尽量由 Rust 类型/schema 生成 | Rust Harness 进程内调用，默认路径 |
| 生成项目、Node/Web 或其他独立进程应用 | 应用自己的领域 service + 脚手架生成的 `/.well-known/worldbase/capabilities` discovery 和固定 operation endpoint/SDK | Rust project runtime 按 manifest allowlist 经认证 loopback/RPC 调用；不经过 Electron app-specific bridge |
| 外部 SaaS/第三方服务 | MCP server 或受支持的远程 provider adapter | Rust MCP/provider client；复用安装来源、服务器 allow-list 和用户授权 |

对于独立项目，模板产生的 endpoint 必须由服务端路由表绑定到本项目已声明的 operation ID。Manifest 不得填入任意 command、URL、route、IPC channel 或 provider 实现。Rust runtime 只把 `capability_id + validated input + scoped call context` 交给固定 SDK adapter，服务端再调领域 service。前端和 Agent 由此调用同一业务逻辑；AI 不需要理解应用内部页面、状态管理框架或数据库布局。

RPC SDK 对应用开发者提供稳定调用 envelope，而不是让每个应用发明一套协议：

```json
{
  "protocolVersion": 1,
  "callId": "host-generated-id",
  "capabilityId": "invoice.create_draft",
  "deadline": "host-generated-deadline",
  "idempotencyKey": "optional-host-generated-key",
  "input": {}
}
```

宿主身份、已授权 scope 和用户 grant 由 Rust runtime 在认证通道中绑定；它们不是模型可填写的 input 字段。应用返回版本化的 `status/data/error`，SDK 负责 schema 校验、错误码映射和取消传播。Discovery descriptor 可读取/缓存，operation endpoint 必须认证并只接受 manifest/provider allowlist 中的 capability ID。

独立应用模板可采用如下结构，AI adapter 只是调用既有 domain service 的薄层：

```text
my-app/
├── .worldbase/app-capabilities.json
├── AI_INTEGRATION.md
├── src/domain/                 # UI 与 AI 共用的业务 service
├── src/ai/                     # 生成的 operation/schema/RPC adapter
└── tests/capability_contract/  # schema、授权、scope、幂等和错误契约
```

第一方 Rust 应用使用对应的 crate 模块划分：`domain` 实现业务服务，`ai` 注册 descriptor 并调用 domain service，`tests` 执行相同 contract suite。生成器应从同一类型/定义产出 manifest 和 RPC schema，避免两份手写 schema 漂移。

Capability 的设计应遵守以下要求：

- 一项 capability 对应一个用户能描述的业务动作或查询，例如 `invoice.search`、`invoice.create_draft`，不要直接暴露通用 `execute_sql`、`run_command` 或巨大 `do_everything` 操作。
- 每项声明稳定 ID、短描述、适用场景/别名、严格 input/output schema、risk、permission、scope、side effects、幂等策略、deadline 和必要的前置条件。
- schema 应表达业务输入，而非实现细节；scope 由 Rust 从会话/项目/用户授权解析，模型参数不能扩大 scope。写操作返回结构化变更摘要和可用的撤销/查询引用。
- operation 必须有稳定错误码，支持超时/取消；可能产生外部副作用的 operation 必须支持幂等键或明确声明无法重试。
- discovery 使用短描述和 tags；激活后才将完整 schema、长说明、示例和 Skill/integration instructions 加入 run，避免为检索载入整份开发文档。

建议应用构建与发布流水线：

1. **创建**：选择应用模板时填 app 元信息、数据 scope、平台和 AI 接入类型；生成 manifest 和 endpoint/provider 骨架。
2. **实现**：先实现可被 UI 与 AI 共用的 domain service，再实现 Rust provider 或固定 RPC adapter；不能把业务逻辑只写在 UI handler。
3. **校验**：运行 `worldbase app validate`（待建设）检查 ID 冲突、schema 限制、权限/risk 一致性、平台 features、operation allowlist、manifest/provider 对应关系和文档完整性。
4. **测试**：运行生成的 contract tests，覆盖 schema 入出、未授权拒绝、scope 隔离、deadline/cancel、幂等、结果大小、runtime health、错误码和版本兼容；再做一次从发现、启动到调用的端到端测试。
5. **发布**：对 manifest/hash 和 provider version 做版本记录。权限新增/扩大必须生成权限 diff，并在用户启用新版本前审核；移除或弃用 capability 提供兼容窗口和迁移说明。

只有满足发布门禁的应用才能标记为 `ai_ready` 并出现在正常 `search_tools` 结果中。未接入的应用可以被目录列为“尚无 AI 操作接口”，但不应让模型误以为它可以通过打开界面完成同等业务操作。

## 5. 发现与按需工具注入

### 当前行为

当前 Rust Agent 会在每个 run 开始时把可用工具的 schema 一次性发送给主模型，基本等于“本 run 可见的工具都在上下文”，尚未实现基础工具与可发现工具的分层。实际集合来自 Rust builtins、该 run 允许的已配置 MCP tools、组协作工具和宿主 custom tools，再应用平台、会话、工作区和 allow/deny policy 过滤；所以不是所有设备、所有会话都能看到完全相同的工具。换句话说，当前不是所有编译注册的工具无条件可见，但所有通过这些过滤的内置工具都会进入模型上下文。

绘图工具没有从 Rust 内置目录消失：`generate_image` 和 `edit_image` 都注册在 `builtin_tools()`，声明为 Rust 原生执行；Electron 桌面能力过滤允许这些原生工具，移动端白名单也包含它们。它们通过权限 policy 后会进入当次模型请求的 tool schema，并把任务写入 Rust 所有的绘图队列。若当前会话仍看不到，应检查握手返回的 `availableTools`、本轮 `allowedToolNames`/`deniedToolNames` 和模型请求记录里的 tools；单纯 UI 工具列表或 Electron 兼容 contract 并不能代表最终的 Rust 模型目录。图片 provider/凭证影响执行是否成功，通常不决定 schema 是否可见。

### 目标分层

工具分为两层。**基础工具**直接常驻主模型上下文，包括日常文件/工作区读写、代码/内容搜索、任务计划/状态、对话控制、绘图等当前任务经常依赖的内置能力，让模型始终知道系统能做什么。**可发现能力**包括外部 Skill、MCP 工具和应用 operation，默认不进入主上下文，由 `search_tools` 按需检索。每个 Rust 工具 descriptor 明确标记 `always_on` 或 `discoverable`；已有内置工具分类前保持当前可见行为，只有明确列入迁移清单后才改为按需发现。

主模型每轮看到的工具集合为 `基础常驻工具 + search_tools + 本 run 已发现的少量可发现工具`。`search_tools` 不调用另一个模型，也不自己做语义推荐；Rust 本地按关键词、别名、tags 和可选本地索引召回少量候选，主模型读取结果后自行判断哪些能力适合当前任务。Skill 本身是 instructions 而不是 tool call：检索选中 Skill 后，Rust 加载其已验证的指令到当前 run；MCP 和应用能力则把 descriptor 与 executable handler 加入当前 run。

`search_tools` 输入可以包含 `task`（当前子目标摘要）、`query`、可选 `app_id`/category/source 和 `max_results`。默认检索范围是用户已启用且当前 run 可访问的外部 Skill、MCP 和应用能力；基础工具仍可直接调用，不需要通过搜索发现。检索过程如下：

1. Rust 先按启用状态、平台能力、run policy、用户授权、数据 scope 和 provider 健康状态过滤目录。
2. Rust 通过词法索引/别名/tags/embedding 在符合条件的 catalog 元数据中取最多 20 个候选，再本地排序为最多 8 个候选。候选描述和示例均按长度裁剪，并作为不可信数据处理。
3. `search_tools` 最多返回 5 个候选的 canonical ID、名称、短描述、来源和必要的输入参数提示；不回传完整历史，也不让工具检索扩大用户授权。
4. Rust 从可信 catalog 解析这些候选：MCP/应用能力的 schema 与 executable provider 作为同一个版本的条目原子加入 `RunToolCatalog`；Skill 则加载其受信任 instructions 并记录 active skill ID。
5. 下一次主模型请求同时看到搜索结果和最多 5 个候选的工具 schema/Skill 指令，由当前主模型自行判断是否使用以及具体调用哪个工具；其余目录内容不会进入上下文。

整个检索过程不增加 rerank/recommendation 模型。Rust 本地检索只负责缩小候选；当前主模型基于搜索结果完成最终语义判断，不增加第二个模型调用。搜索结果视为不可信数据；主模型不能通过结果文本创建权限或更改目录。检索工具本身不可递归检索；被选中能力调用后也不自动带入其余候选。

每次搜索默认最多返回 5 个 MCP/应用工具或 Skill，单次结果数可按模型上下文和工具描述长度调整；不对整个 run 设置固定搜索次数上限。长任务可以在新阶段、发现能力缺口或现有候选不适用时继续搜索。基础工具不计入动态工具预算且不会被检索策略移除。动态能力按当前任务阶段维护工作集：优先保留已调用且仍在当前计划中的工具，对未使用且较不相关的工具做替换；接近上下文预算时缩短描述、减少单次结果数或清理过期能力，不直接拒绝后续搜索。缓存键使用 `(catalog_version, normalized_query, policy_scope, platform)`，目录/权限变化即失效；重复查询返回缓存结果，不重复占用检索上下文。检索只消耗主模型处理搜索结果所需的常规上下文；通过代表性任务集衡量加入搜索结果后主流程净 token 变化。

搜索预算采用按需停止而非次数硬上限：当查询与近期查询语义重复且 catalog 未变化、连续搜索没有新增相关候选、当前工具集已覆盖未完成目标，或主 run 的 token/时长预算将耗尽时，Agent 应停止继续搜索或先汇报预算限制。Rust 可以对完全相同的并发请求做合并，对高频重复查询做短时缓存/节流；不能因 run 已搜索若干次就拒绝有新目标或新上下文的有效搜索。运行时间较长本身不应降低搜索权限。

**运行时需补齐的行为**：当前 Agent 在 run 开始时构建一次工具列表，MCP 动态工具也是 run 初始化时注入；需让下一轮模型请求重新读取活动 `RunToolCatalog`。`search_tools` 返回有限候选后，Rust 产生 `catalog_delta`/新版本号，Agent loop 在下一次模型请求前从 run catalog 重新生成完整 tool schema；主模型在该请求中看到候选摘要和可调用 schema 后自行选择。描述/schema 与 dispatcher handler 必须在同一版本原子提交。当前 `Hub` 的静态 `tools: Vec<Arc<dyn Tool>>` 和 `tool.call` 只查 Hub 工具，不能只往 prompt 追加搜索文本。

对话内 `tool.call` 接受当前 run 的短期 `run_capability_token`，由 Rust 解析到 `RunToolCatalog`；没有 run token 的管理调用只能使用全局静态 catalog，并明确拒绝 run-scoped 应用工具。token 不包含权限本身，只引用 Rust 保存的 run 状态，过期、取消或 catalog 失效时立即无效。

### 5.1 协议方法

Rust 内部的目录搜索、推荐、启动和第一方应用调用不经过 Electron bridge。只有 Electron 独占的 OS/UI 能力才增加窄的版本化 callback，例如：

```text
application.host.capability.invoke
  Rust -> Electron: registeredHostCapabilityId, callId, boundedInput, deadline
  Electron -> Rust: status, boundedOutput, warnings

application.host.state.changed
  Electron -> Rust: hostCapabilityId, availability, stateVersion
```

这些 callback 必须有请求关联 ID、一次应答、deadline、取消和状态版本。`HostBridge` 只是传输层，不能承载应用业务目录或通用 invoke 路由；宿主只接受 Rust 内置 allowlist 中的 `registeredHostCapabilityId`。托管应用 runtime、lease 和健康检查由 Rust 管理，宿主 OS 才需要 Electron adapter。

## 6. 调用与启动生命周期

1. Agent 根据意图调用发现工具。Discovery 只从已启用、平台匹配、权限满足的目录中返回候选能力。
2. Agent 选择 namespaced operation。Dispatcher 根据注册表解析真实 app/capability，不能信任模型传来的任意路由字段。
3. Dispatcher 校验 schema、调用来源、会话 app/project scope、权限、风险级别和 payload 限制；需要确认时经现有交互通道向用户申请。
4. Provider 查询 runtime 状态。若能力标为 `on-demand` 且实例未就绪，则调用 Runtime Manager 启动或唤醒应用，等待健康检查，启动失败时返回有结构化错误码的结果。
5. Provider 用宿主生成的短期调用上下文执行 operation。上下文至少包含 `call_id`、`conversation_id`、`app_id`、授权 scope、deadline 和 cancellation token；不能让应用伪造用户身份。
6. Dispatcher 校验结果 schema、裁剪大结果、清理敏感字段并记录审计，再将结构化结果回传 Agent。
7. 可交互操作默认不抢焦点。只有用户要求查看应用或需要人工完成步骤时才调用 `open_project_app` / `open_workspace_tab` 并呈现确认；业务 operation 仍走应用接口，不由 UI 点击替代。

同一个 app 实例由 Runtime Manager 复用，启动使用 single-flight，避免并发工具调用重复启动进程。闲置回收按 app manifest 和用户设置决定；不因一次 AI 调用结束就强制关闭用户正在使用的应用。每个调用都有 deadline、取消传播、并发上限和幂等策略。对写操作不自动重试，除非 operation 明确声明幂等键。

## 7. 执行 Provider 契约

```rust
#[async_trait]
trait ApplicationCapabilityProvider: Send + Sync {
    async fn health(&self, app: &ApplicationRecord) -> Result<AppHealth>;
    async fn ensure_ready(&self, app: &ApplicationRecord, ctx: &CallContext) -> Result<RuntimeLease>;
    async fn invoke(
        &self,
        capability: &CapabilityRecord,
        input: Value,
        ctx: &CallContext,
    ) -> Result<CapabilityResult>;
}
```

具体 provider 按优先级使用：

- **Rust native service（默认）**：应用实现 Rust trait/service interface，并在 crate 启动时注册 capability descriptor 和 provider。Harness 进程内调用，不需要 Electron IPC、HTTP loopback 或动态加载任意插件库。跨端可复用的业务规则留在此层。
- **受控应用 RPC**：仅用于独立进程或托管 Web 应用。由 Rust 管理进程/runtime，通过固定协议、每应用随机 token、loopback 绑定和 allowlisted operation adapter 调用。现有 project runtime 主要负责 Node/pnpm dev server 和端口健康探测；应用能力需要单独的认证 operation endpoint、readiness/health 契约和固定路由，不能把任意 dev server URL 当作 RPC。不能接受 manifest 任意目标 URL，也不能复用通用 LAN 代理权限。
- **MCP**：复用 `mcp-client` 连接和 tool schema；MCP 是外部/独立进程服务的适配器。应用 catalog 为 MCP tools 增加应用元数据、发现排序和 app 授权上下文，不复制 MCP transport 实现。
- **Electron platform adapter（例外）**：仅在 operation 确实依赖 OS、BrowserWindow、原生文件选择或 Electron WebContents 时使用窄 HostBridge callback。schema、业务规则、权限、路由和结果校验仍由 Rust 管理；不允许每个应用新增一套 TS 工具注册与完整业务 dispatch。
- **UI automation**：不作为应用能力 provider 的常规类型。页面自动化继续作为显式用户界面控制功能，与应用 business API 分离。

Manifest 中的 `runtime.healthCheck`、`operation` 和 provider 路由字段不是任意可执行字符串。它们只能引用受信任 provider 注册的 ID；provider 注册表保存允许的 operation、参数 schema 和目标，未签名/未信任来源不能新增 provider。应用升级时调用固定 provider 版本，不能由 manifest 改写执行目标。

Provider 对外返回统一形状：

```json
{
  "status": "ok",
  "data": {},
  "app": {"id": "worldbase.tasks", "version": "1.2.0"},
  "runtime": {"started_for_call": true},
  "warnings": []
}
```

错误采用稳定错误码，例如 `app_not_enabled`、`capability_not_found`、`permission_required`、`app_start_failed`、`app_unhealthy`、`input_schema_invalid`、`operation_timeout`、`operation_cancelled` 和 `provider_unavailable`。错误消息不包含密钥、私有路径或未经裁剪的应用响应。

## 8. 权限、安全与运行边界

权限需要同时检查工具默认 policy 和应用授权，二者取更严格结果：

| 风险 | 示例 | 默认策略 |
|---|---|---|
| `read` | 搜索、预览、只读统计 | 已授权 scope 内允许；可在严格模式下询问 |
| `write_reversible` | 新增草稿、修改可撤销记录 | 首次按应用/操作授权；执行前可要求确认 |
| `write_destructive` | 删除、覆盖、批量改动 | 每次确认或由明确的策略规则批准；要求结果/撤销信息 |
| `external_effect` | 发消息、付款、发布、外部提交 | 每次明确确认；后台任务不能自动放行 |

- 授权记录按 `app_id + capability_id/permission + data_scope + trust_level` 存储，支持查看、撤销和到期。
- 计划任务/无人值守运行只使用用户保存的显式授权策略；不可借 `interactive` 缺失而绕过确认。
- 桌面/移动端 capability negotiation、平台白名单和 app manifest 的平台声明取交集；移动端不能通过 manifest 抬升平台权限。
- Runtime Manager 只启动可信注册过的应用 entry。拒绝任意 command、未固定路径、路径穿越、DNS rebinding、非 loopback 管理端口和跨 app token 使用。
- 对 MCP/local plugin 保持现有安装确认与来源限制。外部 provider 的调用须继承现有 MCP server allow-list。
- 为每个 app/provider 设置并发、速率、超时和输出上限；执行日志只保留所需审计字段并支持敏感数据脱敏。
- 应用启动/健康检查失败可以按 provider 的幂等规则有限重试；业务 operation 默认不重试。写操作必须声明幂等键，重试只带相同 `idempotency_key`，否则返回 `operation_uncertain`。
- 应用升级或移除时，目录立即撤销未来调用；正在执行的调用固定其 `manifest_hash/provider_version`，继续使用未过期 lease 或进入 drain，完成后释放。新调用必须重新发现并重新授权，不能悄悄切换到新版本。
- 对应用返回的文字/网页/文件内容使用现有 prompt-injection 边界；内容不可直接让 Agent 安装插件、扩大权限或执行未授权操作。

## 9. 与当前仓库的接入映射

| 现有能力 | 当前实现 | 目标演进 |
|---|---|---|
| Rust Tool / descriptor | `harness-rs/crates/tools/src/lib.rs` 的 `Tool`、`ToolDescriptor` | 将工具元数据统一进入 catalog；常驻 `search_tools` |
| Tool 集合 | `Hub::tools_for()` 与 `builtin_tools()` 当前将大量工具静态提供 | 显式拆分 always-on 基础工具与 searchable catalog；基础工具持续可见，外部 Skill/MCP/应用能力按 run 动态激活 |
| Agent/MCP 动态工具 | `harness-rs/crates/core/src/agent.rs`、`tools/src/mcp_tools.rs` | 将内置工具、MCP、应用与托管项目能力统一到 discovery/catalog 接口 |
| Host callback | `tools/src/host_bridge.rs`、Electron Rust Harness host callback | 只添加必须的 OS/UI callbacks；Rust 持有应用接口、策略和 dispatch |
| Electron 工具适配 | `apps/electron/src/main/ai-harness/electron-tool-registry.ts` | 作为现有兼容工具迁移来源；新应用能力不进入这个 TS registry |
| 应用打开/UI | `tool-open-project-app.ts`、工作区页面工具 | 继续负责显式打开/聚焦和人工交互，不作为应用业务 API 或默认 fallback |
| 项目 runtime | `harness-rs/crates/project-runtime`（当前主要是 Node/pnpm dev server 管理）及 Electron adapter | 在其上增加独立的 app RPC readiness、lease 和授权路由，不开放通用 URL/命令执行 |
| MCP | `harness-rs/crates/mcp-client` 与 dynamic MCP tools | 保留传输实现；catalog 负责统一检索、工具命名、权限和结果处理 |

建议应用接口首先定义为 Rust trait 和版本化 DTO；只有跨进程应用才使用固定 RPC wire protocol。HostBridge 只为 Electron 特有的平台资源提供少数 callback，而不是把每个应用操作桥接一遍。新能力不得塞进冻结的 TS Agent Loop 或 Electron TS tool registry。Rust 侧的 `tool.call` 和 Agent run 必须调用同一个 `ToolCatalog`/dispatcher。现有 `open_project_app`、创建轻应用工具可以继续存在，但它们解决的是显示/创建，不等价于应用能力接口。

## 10. 持久化与用户控制

Rust store 是应用目录、授权和策略的权威持久化层；宿主事件只同步 OS/UI 可用状态和托管项目变更。检索索引可由 Rust 从已授权目录元数据构建和更新，不依赖额外模型服务。最小表/对象：

```text
applications(source_id, app_id, version, manifest_hash, enabled, trust_level, status)
application_capabilities(app_id, capability_id, schema_hash, provider_ref, availability)
application_grants(app_id, capability_pattern, permissions, data_scope, mode, expires_at)
application_call_audit(call_id, conversation_id, app_id, capability_id, status, duration_ms, approval_id)
```

UI 为每个应用显示来源、版本、能力摘要、权限范围、运行状态、最近调用和授权撤销入口。manifest 更新时展示新增权限，不静默沿用旧授权。密钥保存在现有 secret store 中，只在调用时通过 provider 注入，不能出现在 manifest、模型 schema、提示词或 audit input 中。

## 11. 逐步实施

### P0：Rust 目录和接口契约

- 定义 manifest、registry DTO、provider contract、错误码和授权粒度。
- 建立 Rust native provider interface；将现有内置 Rust 工具和 MCP tool 映射到目录元数据。
- 明确 `tool.call`、聊天、计划任务、子 Agent 对动态工具的可见性与权限规则。
- 实现 `RunToolCatalog` 的原子扩展、版本/hash 和失效机制；保留 `electron_host_override` 的现有覆盖优先级，所有新应用工具使用 `app__` 命名空间，不能被旧工具或 MCP 同名覆盖。

### P1：工具检索与动态工具集

- 实现 Rust 常驻 `search_tools`；保持基础工具常驻，把外部 Skill、MCP schema 和应用能力放入 searchable catalog。
- 为内置工具定义 `always_on` / `discoverable` 元数据，依据常用性、描述/schema token 成本和任务覆盖分类；不得为压缩上下文隐藏核心基础能力。
- 使用 Rust 本地词法/别名/tags 检索，由当前主模型判断候选；不新增 rerank 模型、模型配置或第二次模型调用。
- 将候选 ID 映射为权威 schema/handler，并原子加入当前 run 下一轮模型请求；限制单次返回量和上下文成本，以去重、增量收益和 run 总预算控制长任务搜索，不设置固定的 per-run 搜索次数上限。
- 实现 namespaced tool id、防冲突、schema validation、缓存失效和权限过滤。
- 让 direct `tool.call`、聊天 loop、计划任务和子 Agent 通过同一 catalog dispatcher；按短期 run token 访问 run-scoped 能力。

### P2：第一方应用 adapters

- 先以 Rust native service 接入低风险且边界清晰的服务，例如文档查询/草稿、项目状态、数据查询。
- 只有确实依赖 OS 的 operation 才通过窄 HostBridge callback。
- 增加 app runtime lease、超时/取消、审计、授权 UI 和结果裁剪。
- 在第一方应用模板中强制创建阶段定义 `AI_INTEGRATION.md`、capability descriptor 和 contract tests；为没有 AI operation 的应用提供显式 `aiIntegration: "none"` 例外及原因。

### P3：托管项目与轻应用

- 定义应用脚手架、`worldbase app validate`（待建设）、`.worldbase/app-capabilities.json` 和带随机 token 的本地 RPC SDK；新项目模板直接生成领域 service、AI adapter 和 contract tests。
- 为独立项目提供固定认证 operation API；Rust runtime 在项目停止时按需启动，健康检查通过后调用 operation；运行失败不回退到任意 shell。
- UI 页面工具仅用于人工查看和用户明确要求的 UI 交互，不作为接口失败时的静默 fallback。

### P4：插件生态与跨端

- 增加签名/可信来源、插件安装更新、沙箱边界、兼容版本和撤销机制；Rust trait provider 编译进受信任的 Harness，第三方运行时代码不能通过加载动态库进入 Harness 进程。
- 给已存在 MCP server 增加分类和应用元数据；不强迫迁移 MCP。
- 按 `platforms` 和宿主 capabilities 暴露跨端子集；Rust native provider 默认可由 desktop/CLI/mobile 共享，只有 platform adapters 被过滤。

## 12. 验收标准

- 安装/启用的应用能被发现；未授权、平台不匹配和不可用的能力不会进入模型工具集。
- 新增一个应用 adapter 不需要改 Agent 主循环或增加一个专用硬编码工具分支。
- 搜索工具只返回权限过滤后的真实 catalog 候选，主模型不能凭候选文本生成权限或 provider route；Rust 对执行仍做 schema 和 grant 校验。
- 按真实任务集测量检索结果引入的主模型 token/延迟与工具发现命中率，确保少量候选 schema 的开销低于全目录工具定义。
- Agent 可发现操作、按需看到其 schema、调用时自动启动所需 runtime，并拿到稳定结构化结果。
- 新建应用的模板默认包含可运行的 AI capability 示例、AI 使用说明和契约测试；发布校验能拦截未声明、schema 漂移、缺少授权声明或 endpoint/provider 不匹配的应用。
- UI 和 Agent operation 调用同一 domain service；新增应用的常规接入不需要新增 Electron app-specific bridge。
- 直接 `tool.call`、聊天、计划任务和子 Agent 使用同一权限决策；无人值守时不会默认确认高风险操作。
- 输入/输出 schema、超时、取消、并发、重试、启动失败和应用升级权限变化均有契约测试。
- 同名应用、恶意 schema、伪造 provider 路由、任意 URL/命令、跨项目 token 和 prompt injection 均不能越权。
- 应用可以停止/恢复；Agent 执行后不误关用户正在交互的应用，需用户参与的交互能明确请求用户操作。

## 13. 关键取舍

**不要把每个应用/插件都变成一组常驻模型工具。** 核心基础工具始终常驻，外部 Skill、MCP 和应用能力经受限检索入口按需加入；catalog 可完整扩展，模型可见集合按任务动态收敛。固定 gateway 只作为不支持动态 schema 的兼容路径。

**不要把“启动应用”当作“能操作应用”。** 启动只是 runtime lifecycle；实际操作必须落到应用公开的 operation API。应用 operation 尽量由 Rust service 直接实现，跨进程才用 RPC，Electron bridge 只处理 OS/UI 边界。接口故障不能静默降级为 UI 自动点击。

**不要让 manifest 自己授予权限。** Manifest 声明所需能力，用户或既有策略决定授权；provider 和 host 只在授予范围内执行。

## 14. 实现备注：MCP 元数据与移动端只读目录

**MCP 应用元数据。** `McpTool` 增加了可选的 `category`、`tags`、`app_id` 字段，全部带 serde 默认值，旧版 server 或旧持久化数据反序列化时得到空值，序列化时空值不会出现在 `mcp.list`/`mcp.status` 载荷中。发现工具时同时接受顶层字段和 MCP `_meta` 扩展中的同名元数据；`app_id` 兼容 `appId`/`app_id` 两种写法，tags 会合并并按原顺序去重。`McpToolSummary` 同步透出这些字段，供桌面端 Settings 展示。

**检索可发现性。** `dynamic_mcp_tools` 保持现有 `mcp__{server}__{tool}__{hash}` 命名不变，避免破坏已保存的工具 allow list。动态工具 wrapper 的 `source` 为 `mcp:<server>`，`tags` 合并 `category`、工具 tags 与 `app_id`，因此 `search_tools` 的词法检索可以通过分类、标签或所属应用匹配到 MCP 工具；原始 MCP 描述不被改写。

**移动端只读目录。** 移动端设置新增“应用 / Applications”页，通过现有 harness client 调用 Rust `application.list`（唯一权威目录），只读展示应用名称、`appId`、版本、trust、启用状态、健康状态，以及每个 capability 的标题、risk 和 availability。页面处理加载中、加载失败（可重试）和空目录状态，并明确提示启用/禁用、授权与审计仅在桌面端提供；移动端不暴露任何目录变更 RPC。应用目录的过滤、信任判断和跨端平台可见性仍由 Rust 负责。

## 15. 实现状态与使用说明（P2/P4 宿主层）

**Electron 宿主能力（P2）。** `apps/electron/src/main/ai-harness/host-capability-contract.ts` 定义协议版本 1 的调用信封：

```text
Rust -> Electron: { protocolVersion: 1, registeredHostCapabilityId, callId, deadline, input }
Electron -> Rust: { status: "ok" | "error", output, warnings, errorCode?, message? }
```

宿主只接受三个 ID：`host.fs.pick_file`、`host.shell.open_external`、`host.notification.show`。`deadline` 是剩余毫秒数，会被夹到 1–60000ms；输入/输出各限制 64 KiB；同一个 `callId` 只执行一次，重复调用返回 `duplicate_call_id`，不会再次触发 Electron API。`host-capability-registry.ts` 提供可注入的 `showOpenDialog` / `openExternal` / `Notification` adapters 与 `getStateVersion()` / `getStateSnapshot()`；`open_external` 只放行 http/https。`services.ts` 在 `Unsupported Rust host request` 之前接入该分支，既有 host request 行为不变。Rust 侧读取顶层 `errorCode`/`message`，因此错误响应同时保留 `output.code/message` 以兼容通用 envelope。`application.host.state.changed` 在每次 host capability invoke 前由 `services.ts` 通过 Rust RPC 发送当前 `stateVersion` 与 `availability`；registry 仍是状态的唯一来源。

**Electron 应用工作台（P2）。** 设置侧边栏新增 `applications` 分类（`ApplicationsPanel.vue`）。面板支持应用列表、启用/禁用、刷新、能力/风险/数据范围展示、授权保存/撤销（`allow`/`ask`/`deny`、capability pattern、data scope、到期时间）以及最近 20 条审计。所有数据都经 IPC `applications:*` 代理到 Rust 的 `application.list/get/setEnabled/refresh/grants.*/audit.list`，Electron 不保存第二份可执行目录；`lightapp:list/delete` 同样只做 Rust RPC 代理。参数在 main 进程做类型和取值校验后才发往 Rust。

**模型工具可见性（P1 衔接）。** `rust-harness-engine.ts` 的 `allowedToolNames` 过滤在协商目录之外额外放行 `app__*`、`search_tools` 与 `mcp__*`。这样 run 开始时尚未出现在静态工具列表里的应用能力和可发现 MCP 工具不会被 Electron 侧白名单误删；实际激活、权限和 schema 仍由 Rust `RunToolCatalog` 决定。

**使用入口。** 桌面端：设置 → 应用，即可查看 Rust 目录中的内置/托管/MCP 应用并进行启用、授权和审计；托管项目的启用状态与 manifest 校验仍以 Rust store 为准。移动端：我的 → 设置 → 扩展与连接 → 应用 / Applications，仅查看同一份 Rust 目录。开发者调试宿主能力时可直接用协议信封调用 `handleRustHostRequest` 的 `application.host.capability.invoke` 分支，不需要新增 per-app IPC。

**验收命令。**

```bash
pnpm electron:typecheck
pnpm --dir apps/electron test:rust-harness-host-callbacks
pnpm --dir apps/electron test:renderer-navigation
cargo test --manifest-path harness-rs/Cargo.toml -p worldbase-mcp-client
cargo test --manifest-path harness-rs/Cargo.toml -p worldbase-tools mcp
cd apps/mobile && flutter analyze --no-fatal-infos
```

## 参考文档

- [Rust Harness 架构](rust-harness-architecture.md)
- [Rust Harness 开发约定](rust-harness-development.md)
- [AI Agent 工具目录](ai-agent-tools.md)
- [项目结构](project-structure.md)
