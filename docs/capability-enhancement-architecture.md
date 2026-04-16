# The World — AI Agent 能力补全架构设计

> 基于 Claude Code 源码分析，对 The World Agent 系统的能力差距分析与增强设计方案。

---

## 1. 对标分析：Claude Code vs The World

### 1.1 能力矩阵对比

| 能力维度 | Claude Code | The World 现状 | 差距等级 |
|---------|-------------|---------------|---------|
| **工具系统** | 50+ 工具，Zod schema 校验，feature-gated 按需加载 | 30+ 工具，JSON Schema 定义，全量注册 | ⚠️ 中 |
| **文件编辑** | FileEdit (精确替换)、FileWrite (整文件)、FileRead (行范围) | write_project_file (整文件)、patch_project_file (行范围补丁)、read_project_file | ✅ 基本对齐 |
| **代码搜索** | Glob + Grep + 内嵌 ripgrep/bfs | search_project_code (基础搜索) | 🔴 缺失 |
| **命令执行** | Bash 工具 + 安全分类器(ML) + 沙盒模式 | run_project_command (白名单限制) | ⚠️ 中 |
| **权限控制** | 5 层权限 (校验→工具→规则→自动分类→用户确认) | 2 层 (白名单 + 用户确认) | 🔴 缺失 |
| **上下文管理** | 自动压缩 + 侧链转录 + 大输出持久化 | 自动压缩 (16 轮触发) | ⚠️ 中 |
| **多 Agent** | Coordinator 模式 + 子 Agent 隔离 (worktree/remote) | 无 | 🔴 缺失 |
| **Skills 系统** | Markdown + YAML 前言 + 参数替换 + 分叉执行 | 基础 Skill Store (文件注入到 prompt) | 🔴 缺失 |
| **Plan 模式** | 进入/退出 plan 模式，只读规划不执行 | 无 | 🔴 缺失 |
| **MCP 协议** | 完整 MCP 客户端 (Resources + Tools + Prompts) | 无 | 🔴 缺失 |
| **LSP 集成** | 诊断信息 + 符号查找注入到 Agent | 无 | 🔴 缺失 |
| **成本追踪** | 按模型精细计费 + 预算强制 | 无 | ⚠️ 中 |
| **TODO 管理** | Agent 自主创建/管理任务列表 | 无 | ⚠️ 中 |
| **Web 获取** | WebFetch + WebSearch 工具 | 无(仅项目内 API 调用) | ⚠️ 中 |
| **工具结果存储** | 超大输出自动写入文件，返回路径引用 | 输出截断 (40KB) | ⚠️ 中 |
| **Git 集成** | 深度 git 状态注入 + commit 归因 | 无 | 🔴 缺失 |
| **钩子系统** | pre/post sampling hooks + pre/post tool hooks | 无 | 🔴 缺失 |

### 1.2 Claude Code 的关键设计模式

从 Claude Code 源码中提取的 **10 个值得借鉴的核心设计模式**：

1. **Async Generator 驱动的流式循环** — Agent 主循环用 `async *runStream()` 实现，天然支持取消、暂停、进度报告
2. **工具并发分区** — 只读工具可并发执行，写入工具串行执行
3. **Feature-Gated 工具加载** — 工具按 feature flag 条件加载，避免不必要的上下文占用
4. **侧链转录 (Sidechain Transcript)** — 子 Agent 的消息历史独立存储，不污染主对话
5. **大输出持久化** — 工具返回超过 100K 字符时自动写入临时文件，返回路径引用
6. **上下文窗口感知压缩** — 实时监控 token 用量，在阈值内主动压缩旧消息
7. **多层权限决策链** — 校验 → 工具逻辑 → 规则匹配 → 自动分类 → 用户确认
8. **迭代指纹去重** — 检测 Agent 进入工具调用死循环 (相同调用+相同结果连续 N 次)
9. **Skill 分叉执行** — Skill 用独立上下文执行，结果汇总回主对话
10. **Coordinator/Worker 分离** — 复杂任务拆分为规划层(只做调度)和工作层(执行具体操作)

---

## 2. 能力增强优先级排序

按照 **对代码生成质量影响×实现可行性** 排序：

| 优先级 | 能力 | 影响 | 成本 | 状态 | 理由 |
|--------|------|------|------|------|------|
| **P0** | 增强权限系统 | 🔴高 | 中 | ✅ 已实现 | 安全基础，当前白名单太简陋，阻碍更多工具开放 |
| **P0** | Glob/Grep 代码搜索工具 | 🔴高 | 低 | ✅ 已实现 | Agent 理解项目全貌的关键能力，现有 search 太弱 |
| **P0** | 工具结果存储增强 | 🔴高 | 低 | ✅ 已实现 | 大文件/大输出场景下 Agent 能力断崖式下降 |
| **P1** | Plan 模式 | 🔴高 | 中 | ✅ 已实现 | 复杂任务需要"先想再做"，减少返工 |
| **P1** | Skills 系统增强 | 🔴高 | 中 | ✅ 已实现 | 用户可定制 Agent 行为，提高生成质量 |
| **P1** | 迭代安全机制 | 高 | 低 | ✅ 已实现 | 指纹去重 + 死循环检测，防止 Agent 空转浪费 token |
| **P1** | 成本追踪 | 高 | 低 | ✅ 已实现 | 用户需要了解 AI 调用成本 |
| **P2** | 多 Agent 协调 | 高 | 高 | 跨项目或大规模修改的并行能力 |
| **P2** | Git 深度集成 | 中 | 中 | 生成代码的版本管理和回滚 |
| **P2** | MCP 协议支持 | 中 | 高 | 生态扩展，但当前生态尚未成熟 |
| **P2** | Hook 系统 | 中 | 中 | 扩展性好，但非当前瓶颈 |
| **P3** | LSP 集成 | 中 | 高 | Electron 环境下集成 LSP 成本较高 |
| **P3** | Web 获取工具 | 低 | 低 | The World 是项目管理场景，web 搜索非核心 |

---

## 3. 架构设计

### 3.1 总体架构演进

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     The World Agent 系统 (增强版)                         │
│                                                                          │
│  ┌─── Coordinator Layer (NEW) ──────────────────────────────────────┐   │
│  │  PlanEngine       — 任务规划与拆分                                │   │
│  │  AgentSpawner     — 子 Agent 生成与隔离                           │   │
│  │  TaskTracker      — 子任务状态追踪                                │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                              │                                           │
│  ┌─── Agent Core (增强) ────────────────────────────────────────────┐   │
│  │                                                                    │   │
│  │  ┌── Context Manager (增强) ──┐  ┌── Permission Engine (NEW) ──┐  │   │
│  │  │ TokenBudgetMonitor         │  │ RuleEngine                   │  │   │
│  │  │ MessageCompactor           │  │ AutoClassifier               │  │   │
│  │  │ ToolResultStorage (NEW)    │  │ DenialTracker                │  │   │
│  │  │ SidechainTranscript (NEW)  │  │ UserConfirmation             │  │   │
│  │  └────────────────────────────┘  └──────────────────────────────┘  │   │
│  │                                                                    │   │
│  │  ┌── Safety Guards (增强) ───┐  ┌── Cost Tracker (NEW) ────────┐  │   │
│  │  │ LoopDetector (指纹去重)   │  │ PerModelAccounting            │  │   │
│  │  │ TimeoutGuard              │  │ BudgetEnforcement             │  │   │
│  │  │ MaxIterationGuard         │  │ UsageReport                   │  │   │
│  │  └────────────────────────────┘  └──────────────────────────────┘  │   │
│  │                                                                    │   │
│  │  ┌── Tool Registry (增强) ─────────────────────────────────────┐  │   │
│  │  │                                                              │  │   │
│  │  │  ┌─ 现有工具 ─────┐  ┌─ 新增工具 ──────────────────────┐   │  │   │
│  │  │  │ read_project    │  │ glob_search          (P0)       │   │  │   │
│  │  │  │ write_project   │  │ grep_search          (P0)       │   │  │   │
│  │  │  │ patch_project   │  │ enter_plan_mode      (P1)       │   │  │   │
│  │  │  │ call_api        │  │ exit_plan_mode       (P1)       │   │  │   │
│  │  │  │ query_db        │  │ run_skill            (P1)       │   │  │   │
│  │  │  │ run_command     │  │ manage_todo          (P1)       │   │  │   │
│  │  │  │ analyze_data    │  │ spawn_agent          (P2)       │   │  │   │
│  │  │  │ create_project  │  │ git_status           (P2)       │   │  │   │
│  │  │  │ start_server    │  │ git_diff             (P2)       │   │  │   │
│  │  │  │ ...             │  │ git_commit           (P2)       │   │  │   │
│  │  │  └─────────────────┘  └─────────────────────────────────┘   │  │   │
│  │  │                                                              │  │   │
│  │  │  ┌─ Tool Execution Engine ──────────────────────────────┐   │  │   │
│  │  │  │ ConcurrencyPartitioner (读写分区并发)                 │   │  │   │
│  │  │  │ ResultPersistence (大输出文件化)                       │   │  │   │
│  │  │  │ ProgressReporter (执行进度回调)                       │   │  │   │
│  │  │  └──────────────────────────────────────────────────────┘   │  │   │
│  │  └──────────────────────────────────────────────────────────────┘  │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─── Skill Engine (NEW) ──────────────────────────────────────────┐    │
│  │  SkillLoader        — 从文件/目录加载 Skill 定义                  │    │
│  │  SkillRegistry      — 注册表 + 去重 + 优先级                     │    │
│  │  ArgumentResolver    — ${arg} 参数解析与替换                      │    │
│  │  ForkExecutor       — Skill 分叉执行 (独立上下文)                 │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─── Hook System (NEW) ───────────────────────────────────────────┐    │
│  │  preSampling        — LLM 请求前钩子 (context 注入)               │    │
│  │  postSampling       — LLM 响应后钩子 (日志/分析)                  │    │
│  │  preTool            — 工具执行前钩子 (权限检查)                    │    │
│  │  postTool           — 工具执行后钩子 (结果处理)                    │    │
│  └──────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
```

---

### 3.2 P0: 代码搜索工具

**借鉴**: Claude Code 的 `GlobTool` 和 `GrepTool`

当前 Agent 对项目的理解依赖于 `list_project_files` + `read_project_file` 逐文件阅读，效率极低。Agent 需要在大型项目中快速定位目标代码。

#### 3.2.1 glob_search — 文件模式搜索

```typescript
// src/main/ai-engine/agent/tools/tool-glob-search.ts

interface GlobSearchParams {
  project_id: string
  pattern: string        // glob 模式: "**/*.ts", "src/**/index.*"
  path?: string          // 限定搜索起始目录
  max_results?: number   // 默认 100
}

interface GlobSearchResult {
  files: Array<{
    path: string
    size: number
    modified: string
  }>
  total_matches: number
  truncated: boolean
}
```

- 实现: 基于 `fast-glob` 或 Node.js `fs.glob`（Node 22+）
- 排除: `node_modules/`, `.next/`, `dist/`, `.git/` 等
- 排除规则可读取项目的 `.gitignore`

#### 3.2.2 grep_search — 代码内容搜索

```typescript
// src/main/ai-engine/agent/tools/tool-grep-search.ts

interface GrepSearchParams {
  project_id: string
  pattern: string           // 搜索文本或正则
  path?: string             // 限定搜索目录
  include_pattern?: string  // 仅搜索匹配的文件类型: "*.ts"
  is_regexp?: boolean       // 是否正则
  max_results?: number      // 默认 50
  context_lines?: number    // 前后上下文行数，默认 2
}

interface GrepSearchResult {
  matches: Array<{
    file: string
    line: number
    content: string
    context_before: string[]
    context_after: string[]
  }>
  total_matches: number
  truncated: boolean
}
```

- 实现: 逐文件 `readline` 搜索，或引入 `@vscode/ripgrep` 获得原生性能
- 安全: 仍限定在项目目录内

---

### 3.3 P0: 多层权限系统

**借鉴**: Claude Code 的 5 层权限决策链

当前系统仅有命令白名单 + 高危操作用户确认两层。需要设计更灵活的权限框架。

```typescript
// src/main/ai-engine/agent/permissions/permission-engine.ts

/**
 * 权限决策链 (按顺序执行, 先匹配先决定):
 * 
 * 1. Schema 校验     — 工具参数是否合法
 * 2. 工具级权限       — 工具自身的 checkPermissions()
 * 3. 规则引擎         — 用户配置的 allow/deny 规则
 * 4. 自动分类         — 基于规则的安全分析 (代替 ML 分类器)
 * 5. 用户确认         — 弹窗让用户决定
 */

interface PermissionRule {
  tool: string                // 工具名 或 "*"
  pattern?: string            // 参数匹配模式 (如 command 的正则)
  decision: 'allow' | 'deny' | 'ask'
  reason?: string
}

interface PermissionCheckResult {
  allowed: boolean
  reason: string
  askedUser: boolean        // 是否经过用户确认
  rule?: PermissionRule     // 匹配到的规则
}

class PermissionEngine {
  private rules: PermissionRule[] = []
  
  /** 加载用户配置的规则 (从 settings 或 .world-permissions.json) */
  loadRules(rules: PermissionRule[]): void
  
  /** 执行完整的权限决策链 */
  async check(
    toolName: string, 
    args: Record<string, unknown>,
    context: ToolUseContext
  ): Promise<PermissionCheckResult>
  
  /** 工具级权限检查 (每个工具可覆盖) */
  private checkToolPermissions(tool: RegisteredTool, args: Record<string, unknown>): PermissionCheckResult | null
  
  /** 规则引擎匹配 */
  private matchRules(toolName: string, args: Record<string, unknown>): PermissionCheckResult | null
  
  /** 基于规则的安全自动分类 */
  private autoClassify(toolName: string, args: Record<string, unknown>): 'safe' | 'risky' | 'unknown'
  
  /** 请求用户确认 */
  private async askUser(toolName: string, args: Record<string, unknown>, reason: string): Promise<boolean>
}
```

**自动分类规则示例** (代替 Claude Code 的 ML 分类器):

```typescript
const COMMAND_SAFETY_RULES = [
  // 安全: 纯读取命令
  { pattern: /^(cat|head|tail|wc|ls|find|grep|echo)\b/, risk: 'safe' },
  // 安全: 包管理器读取
  { pattern: /^npm (list|ls|outdated|audit|info)\b/, risk: 'safe' },
  // 需确认: 包安装
  { pattern: /^npm (install|i|add)\b/, risk: 'risky' },
  // 需确认: git 写操作
  { pattern: /^git (push|reset|rebase|merge|checkout)\b/, risk: 'risky' },
  // 禁止: 危险操作
  { pattern: /^(rm|rmdir|chmod 777|curl.*\|.*sh)\b/, risk: 'deny' },
]
```

---

### 3.4 P0: 工具结果存储增强

**借鉴**: Claude Code 的 `toolResultStorage` — 超大输出写入文件后返回路径引用

当前系统对大输出简单截断 (40KB)，导致 Agent 丢失关键信息。

```typescript
// src/main/ai-engine/agent/tool-result-storage.ts

const INLINE_THRESHOLD = 30_000    // 30KB 以下：直接内联
const PERSIST_THRESHOLD = 100_000  // 100KB 以上：写入文件返回引用
// 30KB ~ 100KB 之间：截断 + 提示使用 read_project_file 查看完整内容

interface ToolResultStorageOptions {
  projectId: string
  toolName: string
  callId: string
}

class ToolResultStorage {
  /**
   * 处理工具返回结果:
   * - 小结果: 原样返回
   * - 中等结果: 截断 + 元数据提示
   * - 大结果: 写入临时文件, 返回文件路径 + 摘要
   */
  async processResult(
    result: unknown,
    options: ToolResultStorageOptions
  ): Promise<{ content: string; persisted?: string }> {
    const serialized = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    
    if (serialized.length <= INLINE_THRESHOLD) {
      return { content: serialized }
    }
    
    if (serialized.length > PERSIST_THRESHOLD) {
      const filePath = await this.persistToFile(serialized, options)
      return {
        content: `[Result persisted to file: ${filePath}] (${serialized.length} chars)\n` +
                 `First 500 chars:\n${serialized.slice(0, 500)}...`,
        persisted: filePath
      }
    }
    
    // 中等大小：截断
    return {
      content: serialized.slice(0, INLINE_THRESHOLD) + 
               `\n\n[TRUNCATED: ${serialized.length} total chars. Use read_project_file to see full content.]`
    }
  }
  
  private async persistToFile(content: string, options: ToolResultStorageOptions): Promise<string> {
    const dir = path.join(app.getPath('temp'), 'the-world', 'tool-results')
    await fs.mkdir(dir, { recursive: true })
    const filename = `${options.toolName}_${options.callId}_${Date.now()}.txt`
    const filePath = path.join(dir, filename)
    await fs.writeFile(filePath, content, 'utf-8')
    return filePath
  }
}
```

---

### 3.5 P1: Plan 模式

**借鉴**: Claude Code 的 `EnterPlanModeTool` / `ExitPlanModeV2Tool`

让 Agent 在复杂任务中先规划、再执行，减少错误和返工。

```typescript
// src/main/ai-engine/agent/plan-mode.ts

interface PlanStep {
  id: string
  description: string
  tools: string[]           // 计划使用的工具
  dependencies: string[]     // 依赖的其他步骤 id
  status: 'pending' | 'in-progress' | 'completed' | 'failed'
}

interface Plan {
  id: string
  goal: string
  steps: PlanStep[]
  createdAt: number
}

/**
 * Plan 模式核心:
 * 
 * 1. Agent 调用 enter_plan_mode → 切换到只读模式
 * 2. 在 Plan 模式下, 写入类工具被禁用, Agent 只能:
 *    - 读取文件
 *    - 搜索代码
 *    - 拟定计划 (通过 update_plan 工具)
 * 3. Agent 调用 exit_plan_mode → 切换到执行模式, 按计划逐步执行
 * 4. 用户可以在计划阶段审核并修改计划
 */

// 工具定义
const enterPlanModeTool: ToolDefinition = {
  name: 'enter_plan_mode',
  description: '进入规划模式。在此模式下你只能读取和搜索代码，制定修改计划。计划确认后才能开始执行修改。当任务涉及多个文件或复杂逻辑时应先进入规划模式。',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: '本次规划的目标描述' }
    },
    required: ['goal']
  }
}

const exitPlanModeTool: ToolDefinition = {
  name: 'exit_plan_mode',
  description: '退出规划模式，开始按计划执行修改。',
  parameters: {
    type: 'object', 
    properties: {
      plan_summary: { type: 'string', description: '计划摘要' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            files: { type: 'array', items: { type: 'string' } }
          }
        }
      }
    },
    required: ['plan_summary', 'steps']
  }
}
```

Plan 模式在 UI 层的展现：
- 进入 Plan 模式时展示 "📋 规划中..." 状态 badge
- 计划步骤渲染为可折叠的检查列表
- 用户可以编辑/删除/重排步骤后确认执行

---

### 3.6 P1: Skills 系统增强

**借鉴**: Claude Code 的 `.claude/skills/` markdown + YAML frontmatter 机制

当前 SkillStore 仅将 skill 内容注入 system prompt。需要增强为完整的 Skill 执行框架。

```typescript
// src/main/ai-engine/skills/skill-engine.ts

/**
 * Skill 定义格式 (Markdown + YAML frontmatter)
 * 
 * 存储路径: 
 *   ~/.the-world/skills/       (用户全局)
 *   {project}/.world/skills/   (项目级别)
 * 
 * 示例 skill 文件: create-api-route.md
 * ---
 * name: create-api-route  
 * description: 创建 RESTful API 路由
 * whenToUse: 当用户要求添加新的 API 接口时
 * arguments:
 *   - name: resource_name
 *     description: 资源名称 (如 users, products)
 *   - name: operations  
 *     description: 支持的操作 (CRUD)
 * allowedTools:
 *   - read_project_file
 *   - write_project_file
 *   - patch_project_file
 *   - run_project_command
 * context: fork          # fork = 独立上下文执行 | inline = 注入当前对话
 * ---
 * 
 * 你是一个 API 路由生成专家。为 ${resource_name} 资源创建完整的 RESTful 路由...
 */

interface SkillDefinition {
  name: string
  description: string
  whenToUse?: string
  arguments?: Array<{
    name: string
    description: string
    required?: boolean
  }>
  allowedTools?: string[]
  context: 'fork' | 'inline'
  content: string          // Markdown 正文 (作为 system prompt)
}

class SkillEngine {
  private registry = new Map<string, SkillDefinition>()
  
  /** 从目录加载所有 skill 定义 */
  async loadFromDirectory(dir: string): Promise<void>
  
  /** 解析 markdown + YAML frontmatter */
  private parseSkillFile(content: string): SkillDefinition
  
  /** 参数替换: ${arg_name} → 实际值 */
  private substituteArguments(template: string, args: Record<string, string>): string
  
  /** 
   * 执行 Skill:
   * - inline: 将 skill 内容注入当前对话的 system prompt
   * - fork: 创建独立的 Agent 上下文执行，返回结果到主对话
   */
  async execute(
    skillName: string,
    args: Record<string, string>,
    parentContext: AgentContext
  ): Promise<SkillResult>
  
  /** 注册为 Agent 工具 (run_skill) */
  getToolDefinition(): ToolDefinition
}
```

对应的 Agent 工具:

```typescript
const runSkillTool: ToolDefinition = {
  name: 'run_skill',
  description: '执行一个预定义的 Skill。Skills 包含领域专家知识和工作流程，能帮助你更好地完成特定类型的任务。',
  parameters: {
    type: 'object',
    properties: {
      skill_name: { type: 'string', description: 'Skill 名称' },
      arguments: { 
        type: 'object', 
        description: 'Skill 参数键值对',
        additionalProperties: { type: 'string' }
      }
    },
    required: ['skill_name']
  }
}
```

---

### 3.7 P1: 迭代安全机制增强

**借鉴**: Claude Code 的迭代指纹去重和循环检测

```typescript
// src/main/ai-engine/agent/loop-detector.ts

interface IterationFingerprint {
  toolCalls: Array<{
    name: string
    argsHash: string      // 参数的 hash
  }>
  resultHash: string       // 结果的 hash
}

class LoopDetector {
  private history: IterationFingerprint[] = []
  private readonly maxDuplicates = 6
  
  /** 记录一次迭代的指纹 */
  record(iteration: IterationFingerprint): void {
    this.history.push(iteration)
  }
  
  /** 检测是否进入死循环 */
  isLooping(): { looping: boolean; reason?: string } {
    if (this.history.length < this.maxDuplicates) return { looping: false }
    
    const recent = this.history.slice(-this.maxDuplicates)
    const first = recent[0]
    const allSame = recent.every(fp => 
      fp.toolCalls.length === first.toolCalls.length &&
      fp.toolCalls.every((tc, i) => 
        tc.name === first.toolCalls[i].name && 
        tc.argsHash === first.toolCalls[i].argsHash
      ) &&
      fp.resultHash === first.resultHash
    )
    
    if (allSame) {
      return {
        looping: true,
        reason: `Agent 在最近 ${this.maxDuplicates} 次迭代中重复执行了相同的操作且获得相同的结果`
      }
    }
    
    return { looping: false }
  }
  
  /** 生成参数 hash (容忍微小差异) */
  private hashArgs(args: Record<string, unknown>): string {
    // 对字符串值截断比较，容忍 truncation 差异
    const normalized = JSON.stringify(args, (_, v) => 
      typeof v === 'string' && v.length > 200 ? v.slice(0, 200) : v
    )
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
  }
}
```

---

### 3.8 P1: 成本追踪

**借鉴**: Claude Code 的 `cost-tracker.ts`

```typescript
// src/main/ai-engine/cost-tracker.ts

interface ModelPricing {
  inputPerMillion: number    // 输入 token 单价 (美元/百万token)
  outputPerMillion: number   // 输出 token 单价
  cacheReadPerMillion?: number
}

interface UsageEntry {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cost: number               // 计算后的美元成本
  timestamp: number
}

class CostTracker {
  private pricing: Map<string, ModelPricing> = new Map([
    ['gpt-4o', { inputPerMillion: 2.5, outputPerMillion: 10 }],
    ['gpt-4o-mini', { inputPerMillion: 0.15, outputPerMillion: 0.6 }],
    ['claude-sonnet-4-20250514', { inputPerMillion: 3, outputPerMillion: 15 }],
    ['deepseek-chat', { inputPerMillion: 0.14, outputPerMillion: 0.28 }],
    // ... 可通过 settings 扩展
  ])
  
  private sessionUsage: UsageEntry[] = []
  private budgetLimit?: number  // 可选的会话预算上限
  
  /** 记录一次 API 调用的 token 消耗 */
  record(model: string, inputTokens: number, outputTokens: number, cacheReadTokens?: number): void
  
  /** 获取当前会话总成本 */
  getSessionCost(): { totalCost: number; breakdown: Record<string, number> }
  
  /** 检查是否超过预算 */
  isOverBudget(): boolean
  
  /** 获取使用报告 (展示在 UI) */
  getUsageReport(): {
    totalCost: number
    totalInputTokens: number
    totalOutputTokens: number
    callCount: number
    byModel: Record<string, { cost: number; calls: number }>
  }
}
```

UI 展示: 在聊天面板底部显示 token 消耗和预估成本。

---

### 3.9 P2: 多 Agent 协调

**借鉴**: Claude Code 的 Coordinator/Worker 模式

```typescript
// src/main/ai-engine/coordinator/coordinator.ts

/**
 * Coordinator 模式:
 * 
 * 当复杂任务需要跨多个项目或大规模并行修改时，
 * 主 Agent 升级为 "Coordinator"，它只负责:
 *   1. 理解需求
 *   2. 拆分子任务
 *   3. 分配给 Worker Agents
 *   4. 汇总结果
 * 
 * Worker Agent:
 *   - 独立的对话上下文 (侧链转录)
 *   - 受限的工具集 (只有执行工具，没有规划工具)
 *   - 可以针对不同项目并行运行
 */

interface WorkerTask {
  id: string
  description: string
  projectId: string
  assignedTools: string[]
  status: 'queued' | 'running' | 'completed' | 'failed'
  result?: string
}

class Coordinator {
  private workers: Map<string, WorkerAgent> = new Map()
  
  /** 生成 Worker Agent */
  async spawnWorker(task: WorkerTask): Promise<WorkerAgent> {
    const worker = new WorkerAgent({
      task,
      tools: this.getWorkerTools(task.assignedTools),
      systemPrompt: this.buildWorkerPrompt(task),
      transcript: new SidechainTranscript(task.id),
      onProgress: (event) => this.handleWorkerProgress(task.id, event)
    })
    this.workers.set(task.id, worker)
    return worker
  }
  
  /** Worker 可用的工具集 (排除规划类工具) */
  private getWorkerTools(requested: string[]): RegisteredTool[] {
    const WORKER_DISALLOWED = ['enter_plan_mode', 'spawn_agent', 'create_project']
    return this.allTools.filter(t => 
      requested.includes(t.name) && !WORKER_DISALLOWED.includes(t.name)
    )
  }
}

/** 侧链转录 — Worker Agent 的消息历史独立存储 */
class SidechainTranscript {
  private messages: ChatMessage[] = []
  
  constructor(private taskId: string) {}
  
  push(message: ChatMessage): void { this.messages.push(message) }
  
  /** 持久化到磁盘 (方便调试和恢复) */
  async persist(): Promise<void> {
    const dir = path.join(app.getPath('userData'), 'transcripts')
    await fs.writeFile(
      path.join(dir, `${this.taskId}.json`),
      JSON.stringify(this.messages, null, 2)
    )
  }
  
  /** 生成摘要返回给 Coordinator */
  summarize(): string {
    const last = this.messages[this.messages.length - 1]
    return last?.content || '[Worker completed without output]'
  }
}
```

对应的 Agent 工具:

```typescript
const spawnAgentTool: ToolDefinition = {
  name: 'spawn_agent',
  description: '创建并启动一个 Worker Agent 来执行子任务。Worker Agent 有独立的上下文和工具集。适用于可以并行处理的独立子任务。',
  parameters: {
    type: 'object',
    properties: {
      task_description: { type: 'string', description: '子任务描述' },
      project_id: { type: 'string', description: '目标项目 ID' },
      tools: { 
        type: 'array', 
        items: { type: 'string' },
        description: '分配给 Worker 的工具列表'
      }
    },
    required: ['task_description', 'project_id']
  }
}
```

---

### 3.10 P2: Git 深度集成

**借鉴**: Claude Code 的 git 状态注入和 commit 归因

```typescript
// src/main/ai-engine/agent/tools/tool-git-operations.ts

/** 在每次 LLM 请求的系统 prompt 中注入 git 状态 */
function buildGitContext(projectId: string): string {
  const status = await git.status(projectRoot)
  const branch = await git.currentBranch(projectRoot)
  const recentCommits = await git.log(projectRoot, { maxCount: 5 })
  
  return `
## Git Context
- Branch: ${branch}
- Status: ${status.modified.length} modified, ${status.staged.length} staged, ${status.untracked.length} untracked
- Recent commits:
${recentCommits.map(c => `  - ${c.hash.slice(0, 7)} ${c.message}`).join('\n')}
${status.modified.length > 0 ? `- Modified files:\n${status.modified.map(f => `  - ${f}`).join('\n')}` : ''}
`
}

/** Git 工具定义 */
const gitStatusTool = {
  name: 'git_status',
  description: '查看项目的 git 状态 (分支、修改文件、暂存区)',
  // ...
}

const gitDiffTool = {
  name: 'git_diff',
  description: '查看项目文件的 git diff (支持 staged/unstaged)',
  // ...
}

const gitCommitTool = {
  name: 'git_commit',
  description: '提交当前修改。Agent 的修改会被标记为 AI 生成。',
  // ...
  // 自动添加 commit trailer: "Generated-by: The World AI Agent"
}
```

---

### 3.11 P2: Hook 系统

**借鉴**: Claude Code 的 pre/post sampling hooks

```typescript
// src/main/ai-engine/hooks/hook-manager.ts

type HookPhase = 'preSampling' | 'postSampling' | 'preTool' | 'postTool'

interface Hook {
  phase: HookPhase
  name: string
  priority: number     // 0 = 最高优先级
  handler: (ctx: HookContext) => Promise<HookResult>
}

interface HookContext {
  phase: HookPhase
  messages?: ChatMessage[]     // preSampling: 即将发送的消息
  response?: LLMResponse       // postSampling: LLM 的响应
  toolName?: string            // preTool/postTool: 工具名
  toolArgs?: Record<string, unknown>
  toolResult?: unknown         // postTool: 工具返回值
}

interface HookResult {
  modified?: boolean           // 是否修改了 context
  abort?: boolean              // 是否中止后续流程
  reason?: string
}

class HookManager {
  private hooks: Map<HookPhase, Hook[]> = new Map()
  
  register(hook: Hook): void
  
  async run(phase: HookPhase, ctx: HookContext): Promise<HookResult> {
    const hooks = this.hooks.get(phase) || []
    for (const hook of hooks.sort((a, b) => a.priority - b.priority)) {
      const result = await hook.handler(ctx)
      if (result.abort) return result
    }
    return { modified: false }
  }
}

// 内置 hooks 示例:
// 1. AI 日志 hook (postSampling) — 记录每次 LLM 调用到 ai-log-store
// 2. 成本追踪 hook (postSampling) — 累计 token 消耗
// 3. 安全审计 hook (preTool) — 记录所有工具调用到审计日志
// 4. Git context hook (preSampling) — 注入 git 状态到 system prompt
```

---

## 4. 实施路径

### Phase 1: 基础增强 (P0) — 预计 2-3 周

```
Week 1:
├── glob_search 工具实现 + 测试
├── grep_search 工具实现 + 测试  
└── ToolResultStorage 实现

Week 2-3:
├── PermissionEngine 多层权限框架
├── 规则引擎 + 自动分类器
├── 现有工具迁移到新权限框架
└── UI: 权限规则设置面板
```

### Phase 2: 智能增强 (P1) — 预计 3-4 周

```
Week 4-5:
├── Plan 模式 (enter/exit + UI 展现)
├── LoopDetector 迭代安全机制
└── CostTracker 成本追踪 + UI 展现

Week 6-7:
├── SkillEngine 核心 (加载/解析/执行)
├── Skill 分叉执行机制
├── run_skill 工具对接
└── UI: Skill 管理面板增强
```

### Phase 3: 高级能力 (P2) — 预计 4-6 周

```
Week 8-10:
├── Coordinator/Worker 多 Agent 框架
├── SidechainTranscript 侧链转录
├── spawn_agent 工具
└── UI: 多 Agent 进度可视化

Week 11-13:
├── Git 深度集成 (simple-git)
├── git_status / git_diff / git_commit 工具
├── System prompt git context 注入
├── Hook 系统
└── 内置 hooks (日志/成本/审计/git)
```

---

## 5. 关键实现细节 (来自 Claude Code 的经验)

### 5.1 工具并发分区

Claude Code 将工具分为 **读取类** 和 **写入类**，读取类工具可以并行执行:

```typescript
// The World 实现建议
const READONLY_TOOLS = new Set([
  'read_project_file', 'list_project_files', 'glob_search', 'grep_search',
  'query_project_database', 'get_project_status', 'get_project_logs',
  'list_projects', 'git_status', 'git_diff'
])

async function executeToolCalls(calls: ToolCall[]): Promise<ToolResult[]> {
  const readCalls = calls.filter(c => READONLY_TOOLS.has(c.name))
  const writeCalls = calls.filter(c => !READONLY_TOOLS.has(c.name))
  
  // 读取工具并行执行
  const readResults = await Promise.all(readCalls.map(c => executeTool(c)))
  
  // 写入工具串行执行
  const writeResults: ToolResult[] = []
  for (const call of writeCalls) {
    writeResults.push(await executeTool(call))
  }
  
  return [...readResults, ...writeResults]
}
```

### 5.2 上下文窗口管理策略

Claude Code 的策略值得直接采用:
- 保持 15% headroom (最小 2048, 最大 8192 tokens)
- 压缩时优先移除最旧的消息
- 每 16 轮无条件触发主动压缩
- 压缩摘要限制在 1500 字符内

### 5.3 JSON 参数修复

Claude Code 的鲁棒 JSON 解析值得参考:

```typescript
// 当前 The World 已有类似实现，但可以增强:
function repairToolArguments(raw: string): Record<string, unknown> {
  // 1. 去除 markdown 代码围栏
  let cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '')
  
  // 2. 提取第一个平衡的 JSON 对象
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (match) cleaned = match[0]
  
  // 3. 尝试标准解析
  try { return JSON.parse(cleaned) } catch {}
  
  // 4. 修复常见问题: 尾随逗号、单引号、未转义换行
  cleaned = cleaned
    .replace(/,\s*([}\]])/g, '$1')           // 尾随逗号
    .replace(/'/g, '"')                       // 单引号
    .replace(/\n/g, '\\n')                    // 未转义换行
  
  try { return JSON.parse(cleaned) } catch {}
  
  // 5. 最后手段: 返回错误
  return { _parse_error: 'Failed to parse tool arguments', _raw: raw.slice(0, 500) }
}
```

### 5.4 Feature-Gated 工具加载

Claude Code 根据 feature flag 按需加载工具。The World 可以简化实现:

```typescript
// src/main/ai-engine/agent/tools/index.ts

interface ToolRegistryOptions {
  enablePlanMode?: boolean
  enableSkills?: boolean
  enableCoordinator?: boolean
  enableGit?: boolean
  enabledFeatures?: Set<string>
}

function registerAllTools(options: ToolRegistryOptions): RegisteredTool[] {
  const tools: RegisteredTool[] = [
    // 核心工具 — 始终加载
    toolReadFile(), toolWriteFile(), toolPatchFile(),
    toolListFiles(), toolGlobSearch(), toolGrepSearch(),
    toolCallApi(), toolQueryDb(), toolRunCommand(),
    toolStartServer(), toolCreateProject(), toolListProjects(),
    toolAnalyzeData(),
    
    // 条件加载
    ...(options.enablePlanMode ? [toolEnterPlanMode(), toolExitPlanMode()] : []),
    ...(options.enableSkills ? [toolRunSkill()] : []),
    ...(options.enableCoordinator ? [toolSpawnAgent()] : []),
    ...(options.enableGit ? [toolGitStatus(), toolGitDiff(), toolGitCommit()] : []),
  ]
  
  return tools
}
```

---

## 6. 与 Claude Code 的关键差异

The World 不应照搬 Claude Code 的全部设计。以下是需要注意的差异：

| 方面 | Claude Code | The World | 处理策略 |
|------|-------------|-----------|---------|
| **运行环境** | 终端 CLI + 用户本地文件系统 | Electron 桌面应用 + 受控子项目 | 权限模型更简单，安全边界更清晰 |
| **目标场景** | 通用代码编辑辅助 | 全栈项目生成与管理 | 工具设计以项目为中心，不需要通用 bash |
| **多模型支持** | 仅 Anthropic 模型 | OpenAI 兼容 (多模型) | 工具 schema 保持最大兼容性 |
| **用户交互** | 终端文本 | GUI (Vue 3) | UI 可以更丰富 (可视化计划/进度) |
| **项目隔离** | 单个工作目录 | 多个受控子项目 | 天然具备隔离性，不需要 worktree |
| **数据访问** | 通过文件系统 | 统一数据层 (SQLite + API) | 保持现有数据访问优势 |

**不建议引入的 Claude Code 特性**:
- ~~Worktree 隔离~~ — The World 的子项目天然隔离
- ~~ML 安全分类器~~ — 规则引擎足够，避免复杂度
- ~~MCP 协议~~ (P3延后) — 当前生态ROI不足
- ~~Terminal capture~~ — Electron 环境下子项目运行时已有日志收集
- ~~REPL 工具~~ — The World 已有 `run_project_command`

---

## 7. 总结

The World 当前的 Agent 系统在 **项目管理** 和 **全栈生成** 方面有独特优势（统一数据层、运行时管理、项目隔离），但在 **代码理解**、**安全控制**、**智能规划**、**可扩展性** 方面存在明显差距。

通过借鉴 Claude Code 的关键设计模式 — 特别是 **代码搜索工具**、**多层权限引擎**、**Plan 模式**、**Skill 分叉执行**、**循环检测** — 可以显著提升 The World Agent 的代码生成质量和安全性，同时保持项目管理场景的特色优势。

核心原则: **不做通用 coding agent，做最强的项目管理 AI**。
