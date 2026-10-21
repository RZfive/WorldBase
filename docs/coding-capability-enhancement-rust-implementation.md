# WorldBase 编码能力升级 - Rust Harness 实施方案（修订版）

**版本**：2.1  
**实施边界**：编码能力只在 `harness-rs/` 内实现，Rust 是唯一运行时  
**日期**：2026-10-21

---

## 🎯 架构调整：单一 Rust 运行时

### 当前事实基线

在开始任何编码增强前，必须先区分“已有能力”和“拟定能力”，避免把设计稿当成已完成实现。

| 能力 | 状态 | 说明 |
|------|------|------|
| 通用 Agent 循环 | ✅ 已实现 | `worldbase-core` 的单个执行段最多 128 步；达到段上限后会自动压缩并继续下一段，整次运行还受 8 小时、预算和取消信号约束 |
| 上下文压缩 | ✅ 已实现 | 长对话达到阈值后压缩历史，并保留近期消息与任务锚点 |
| 并行只读工具 | ✅ 已实现 | 相互独立的只读工具调用可并行执行 |
| 并行子代理 | ✅ 已实现 | `spawn_subagents` 可并行分派独立子任务，并回收各自结果 |
| Coding 验证门禁 | ✅ 已实现（MVP） | `chat.send.codingMode` 跟踪未验证修改，阻止带修改的 `finish_task: completed` 或普通文本绕过验证 |
| 前端验证 profile | ✅ 已实现（MVP） | 识别 `package.json`、pnpm/npm/yarn/bun 和 typecheck/lint/test/build scripts |
| 前端诊断归一化 | ✅ 已实现（MVP） | 解析 TypeScript、ESLint、Jest/Vitest 输出为结构化 diagnostic |
| 错误模式与修复计划 | ✅ 已实现（MVP） | 28 个前端错误模式、稳定失败签名、重复失败检测与 `RepairPlan` |
| `coding_verify` 工具 | ✅ 已实现（MVP） | Rust 原生工具按 profile 顺序执行验证命令并返回结构化 evidence |
| TS/JS/TSX tree-sitter 解析 | ✅ 已实现（MVP） | 文件语言识别、语法树解析、唯一节点定位和语法错误检测 |
| 语义编辑与符号索引 | ✅ 已实现（MVP） | `coding_edit` 支持 replace/insert_after/delete/rename，写入前校验文件未变化 |
| Coding Loop 完整编排 | 🧭 提案 | 验证门禁、修复轮次与诊断已接入；跨阶段编排和 LSP 仍待实现 |
| LSP 集成 | 🧭 提案 | 诊断、跳转和符号信息尚未接入 |

**硬约束**：

- Harness 是 Rust-only。不得在宿主应用或脚本层再维护一套编码引擎，也不得为同一能力增加第二套运行时实现。
- Desktop、CLI、Mobile 都是客户端；编码计划、工具调度、验证和状态管理统一在 Rust harness 内完成。
- 客户端与 harness 复用现有 JSON-RPC 2.0 协议；Mobile 使用手写 `dart:ffi` 绑定加载并启动 native harness，不使用代码生成桥接框架。
- 依赖方向固定为 `protocol/tools/coding → core → app-server/mobile-ffi/cli`；`coding` 不得依赖 `core`，避免形成 Cargo 循环依赖。
- “Rust-only Harness”只描述运行时实现语言，不限制被管理项目的技术栈。前端项目仍需执行 pnpm/npm/yarn/bun 验证；Rust/Python/Go profile 是后续扩展。
- 下文除“已实现”明确标注外，模块、文件路径、配置项和指标均为待实施设计。

### 调整前（v1.0 方案）

旧方案把编码逻辑放在宿主应用层，再由应用进程调用工具。该方案会产生以下问题：

- 编码状态、工具权限和会话存储分散在不同进程，难以保证行为一致。
- Desktop、CLI、Mobile 需要各自维护调用适配和错误处理。
- 跨进程传输增加序列化与故障点，也无法天然复用 Rust 侧的并行工具能力。

### 调整后（v2.x 方案）⭐

```text
客户端层
├── Desktop UI        ─┐
├── CLI               ─┼─ JSON-RPC 2.0 ─┐
└── Mobile UI         ─┘  手写 dart:ffi  │
                                         ▼
harness-rs/（唯一运行时）
├── crates/core/                 # 已实现：分段 128 步循环、压缩、并行调度、coding gate
├── crates/tools/                # 已实现：文件、搜索、命令、子代理等工具
├── crates/protocol/             # 已实现：JSON-RPC 与能力协商
├── crates/mobile-ffi/           # 已实现：进程内 native 启动边界
└── crates/coding/               # 增量实现：纯编码策略层，不依赖 core
    ├── state.rs                 # 已实现：验证门禁与修复轮次状态机
    ├── verification.rs          # 已实现：前端验证 profile 检测
    ├── verification_runner.rs   # 已实现：顺序验证与 evidence 汇总
    ├── error_analyzer/          # 已实现：前端诊断归一化、错误模式与修复报告
    └── smart_editor/            # 已实现：符号索引、语义定位与编辑提案
```

**优势**：

- ✅ Desktop、Mobile、CLI 共享同一套编码能力与权限模型。
- ✅ 复用已有 128 步循环、上下文压缩、并行只读工具和子代理能力，不另起循环。
- ✅ 编码逻辑、工具执行和会话数据都在 Rust 进程内，减少跨语言边界。
- ✅ Rust 编译期类型检查和统一错误处理降低维护成本。
- ✅ 客户端升级不影响核心算法，核心修复也能同时覆盖所有端。

---

## 📊 对长任务的价值

### 当前通用循环已经解决的问题

```rust
// 已实现能力的抽象表示，不是新增 API。
async fn run_agent_task(task: Task) -> Result<TaskOutcome> {
    let mut context = ContextCompressor::new(task.initial_context);
    let mut step = 0;

    while step < 128 {
        step += 1;
        context.maybe_compress().await?;

        let batch = plan_next_batch(&context).await?;
        let results = execute_tools(batch).await?; // 只读调用与子代理可并行
        context.extend(results);

        if task.is_complete(&context) {
            return Ok(TaskOutcome::Success);
        }
    }

    Ok(TaskOutcome::StepLimitReached)
}
```

已有能力适合长时间探索，但还缺少编码任务的关键闭环：明确的修改计划、针对编辑的验证、失败后的诊断，以及“诊断 → 编辑 → 再验证”的结构化收敛。

### 升级目标

```rust
// 提案能力示意：外层修复轮次受 max_repair_rounds 限制，
// 每一轮仍复用通用 Agent 循环；128 只是单段上限，不是整次任务总上限。
async fn coding_workflow(task: CodingTask) -> Result<CodingOutcome> {
    let plan = coding_orchestrator.plan(&task).await?;
    let context = context_manager
        .collect_for_plan(&plan, &task.workspace)
        .await?;

    let mut last_diagnosis = None;
    for repair_round in 1..=task.config.max_repair_rounds {
        let edits = smart_editor.generate(&plan, &context, last_diagnosis.as_ref()).await?;
        apply_edits(&task.workspace, &edits).await?;

        let verification = verification_engine.run(&plan.verification_steps).await?;
        if verification.is_success() {
            return Ok(CodingOutcome::success(repair_round, edits));
        }

        last_diagnosis = Some(
            error_analyzer
                .diagnose(&verification.failure, &context)
                .await?,
        );
    }

    Ok(CodingOutcome::partial(last_diagnosis))
}
```

**目标指标（需用固定基准集验证，当前不是既成结果）**：

| 指标 | 当前基线 | 目标 | 验证方式 |
|------|----------|------|----------|
| 目标文件收集 | 由模型逐步调用工具 | 计划驱动批量收集，复用并行只读能力 | 工具调用轨迹与耗时 |
| 编辑方式 | 文本替换为主 | 语法节点级增量编辑（提案） | 编辑后 AST/编译校验 |
| 失败恢复 | 依赖通用循环继续探索 | 结构化诊断 + 有限修复轮次（提案） | 修复轮次成功率 |
| 超长任务 | 单段 128 步 + 自动续跑 + 上下文压缩 | 在既有分段预算内提高单步信息密度 | 任务完成率与步数分布 |
| 用户干预 | 视任务而定 | 减少机械性排错 | 人工接管次数 |

### 典型长任务场景

#### 场景 1：重构前端应用（20+ 文件）

**当前可行路径**：

```text
1. 通用循环搜索调用点并读取相关文件
2. 只读文件读取与搜索可并行执行
3. 模型分批生成补丁
4. 调用项目实际的 typecheck / lint / test / build 验证
5. 根据编译输出继续下一批修改
```

**增强目标**：

```text
1. Coding Loop 生成受影响的 crate 与文件清单
2. Context Manager 收集依赖边界内的代码
3. Smart Editor 按语法节点生成最小补丁（提案）
4. Error Analyzer 归一化 cargo 诊断（提案）
5. 修复轮次内重新验证，超出上限时返回结构化诊断
```

#### 场景 2：批量修复编译错误（50+ 处）

**当前痛点**：

- 编译输出较长，容易挤占上下文预算。
- 同类错误需要模型反复识别，缺少统一归并。
- 修改多个文件后，若未再次运行 `cargo check`，可能遗漏连锁错误。

**增强目标**：

- 先按文件与错误码聚类，再生成批量修复计划。
- 每轮只处理可验证的一小组修改，避免一次性大范围改写。
- 把剩余错误、已尝试修复和验证结果写入会话状态。

---

## 🏗️ Rust 侧架构设计

### 目录结构

```text
harness-rs/
├── Cargo.toml
└── crates/
    ├── core/                      # 已实现：通用 Agent 循环、压缩、子代理
    ├── tools/                     # 已实现：工具注册、权限和并行只读调用
    ├── protocol/                  # 已实现：JSON-RPC、事件和能力协商
    ├── mobile-ffi/                # 已实现：进程内 native 启动入口
    └── coding/                    # 提案：编码增强 crate
        ├── Cargo.toml
        └── src/
            ├── lib.rs
            ├── orchestrator.rs    # 编码计划与修复轮次
            ├── context.rs         # 上下文收集、压缩与预算控制
            ├── verification.rs    # 构建、测试、差异与格式检查
            ├── smart_editor/
            │   ├── mod.rs
            │   ├── parser.rs      # tree-sitter 语言注册（提案）
            │   ├── query.rs       # 节点选择器（提案）
            │   └── semantic_edit.rs
            └── error_analyzer/
                ├── mod.rs
                ├── pattern.rs     # 编译/测试错误模式（提案）
                └── diagnosis.rs   # 模型辅助诊断（提案）
```

`crates/coding` 只承载编码专用编排，不复制通用循环。它通过 `worldbase-core`、`worldbase-tools` 和 `worldbase-protocol` 的公开接口接入现有运行时。

### 依赖选型（Rust 生态）

```toml
[dependencies]
# 异步、并发与超时
tokio = { workspace = true }

# 序列化
serde = { workspace = true, features = ["derive"] }
serde_json = { workspace = true }

# 错误处理与日志
anyhow = { workspace = true }
thiserror = { workspace = true }
tracing = { workspace = true }

# 持久化与缓存（按实际需求启用）
rusqlite = { workspace = true }
lru = "0.12"

# 前端语言解析（第一批）；版本必须与 workspace 锁文件一致
tree-sitter = { workspace = true }
tree-sitter-javascript = { workspace = true }
tree-sitter-typescript = { workspace = true }
```

实施时先在 `harness-rs/Cargo.toml` 的 workspace dependencies 中加入并经 `cargo check` 验证，再让 `crates/coding` 引用。不得在客户端另装一套解析或编辑依赖。

### 核心数据结构

```rust
// crates/coding/src/lib.rs（提案）
use std::path::PathBuf;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodingRequest {
    pub user_prompt: String,
    pub project_id: Option<String>,
    pub workspace_root: PathBuf,
    pub context: CodingContext,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CodingContext {
    pub open_files: Vec<PathBuf>,
    pub recent_edits: Vec<Edit>,
    pub compressed_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodingResult {
    pub status: CodingStatus,
    pub repair_rounds: u32,
    pub changes: Vec<Edit>,
    pub diagnosis: Option<ErrorDiagnosis>,
    pub metrics: PerformanceMetrics,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum CodingStatus {
    Success,
    Partial,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edit {
    pub edit_type: EditType,
    pub file_path: PathBuf,
    pub byte_range: Option<Range<usize>>,
    pub new_content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum EditType {
    Create,
    Patch,
    FullRewrite,
    Delete,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PerformanceMetrics {
    pub time_ms: u64,
    pub files_read: u32,
    pub files_modified: u32,
    pub verification_attempts: u32,
}
```

`repair_rounds` 是编码层修复轮次，不应与通用 Agent 循环的单段 128 步预算混用。编码层必须遵守外层分段预算、运行时长、取消信号和权限检查。

### 主循环实现（Rust）

```rust
// crates/coding/src/orchestrator.rs（提案示意）
use anyhow::{Context, Result};
use tokio::time::{timeout, Duration};
use tracing::{info, warn};

impl CodingOrchestrator {
    pub async fn execute(&self, request: CodingRequest) -> Result<CodingResult> {
        let started = std::time::Instant::now();
        let plan = timeout(
            Duration::from_secs(self.config.planning_timeout_secs),
            self.plan_changes(&request),
        )
        .await
        .context("编码计划生成超时")??;

        let context = self
            .context_manager
            .gather_for_plan(&plan, &request.workspace_root)
            .await
            .context("编码上下文收集失败")?;

        let mut last_failure = None;
        let mut all_edits = Vec::new();

        for repair_round in 1..=self.config.max_repair_rounds {
            info!(repair_round, "开始编码修复轮次");

            let edits = self
                .smart_editor
                .generate(&plan, &context, last_failure.as_ref())
                .await?;
            self.apply_edits(&request.workspace_root, &edits).await?;
            all_edits.extend(edits);

            let verification = self
                .verification
                .run(&plan.verification_steps)
                .await?;

            if verification.is_success() {
                return Ok(CodingResult {
                    status: CodingStatus::Success,
                    repair_rounds: repair_round,
                    changes: all_edits,
                    diagnosis: None,
                    metrics: self.metrics(&context, &all_edits, started),
                });
            }

            let diagnosis = self
                .error_analyzer
                .diagnose(&verification.failure, &context)
                .await?;
            if !diagnosis.is_recoverable {
                warn!("诊断为不可恢复错误，提前结束");
                break;
            }
            last_failure = Some(verification.failure);
        }

        Ok(CodingResult {
            status: CodingStatus::Partial,
            repair_rounds: self.config.max_repair_rounds,
            changes: all_edits,
            diagnosis: last_failure
                .as_ref()
                .map(|failure| self.error_analyzer.diagnose_sync(failure, &context))
                .transpose()?,
            metrics: self.metrics(&context, &all_edits, started),
        })
    }
}
```

实施时，`apply_edits` 必须调用现有工具权限层，并支持取消、工作区边界检查、写入前快照和失败回滚。

### 并行上下文收集（Rust）

```rust
// crates/coding/src/context.rs（提案示意）
use std::sync::Arc;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

impl ContextManager {
    pub async fn gather_for_plan(
        &self,
        plan: &CodingPlan,
        workspace: &Path,
    ) -> Result<CodeContext> {
        let files = self.expand_dependencies(&plan.required_files).await?;
        let semaphore = Arc::new(Semaphore::new(self.config.max_parallel_reads));
        let mut tasks = JoinSet::new();

        for path in files {
            let semaphore = semaphore.clone();
            let workspace = workspace.to_path_buf();
            let cache = self.cache.clone();

            tasks.spawn(async move {
                let _permit = semaphore.acquire_owned().await?;
                if let Some(hit) = cache.get(&path).await {
                    return Ok((path, hit));
                }

                let content = read_workspace_file(&workspace, &path).await?;
                cache.insert(path.clone(), content.clone()).await;
                Ok((path, content))
            });
        }

        let mut collected = Vec::new();
        while let Some(result) = tasks.join_next().await {
            collected.push(result??);
        }

        self.compress_if_needed(collected).await
    }
}
```

该模块优先复用 `worldbase-tools` 中已有的只读文件工具和并行调度，不直接绕过权限层。紧凑上下文沿用现有压缩机制，避免重复维护摘要策略。

### 智能编辑器（Rust + tree-sitter，提案）

```rust
// crates/coding/src/smart_editor/semantic_edit.rs（提案示意）
use anyhow::{Context as _, Result};
use tree_sitter::{Language, Parser};

pub struct SmartEditor {
    languages: LanguageRegistry,
}

impl SmartEditor {
    pub async fn generate(
        &self,
        plan: &CodingPlan,
        context: &CodeContext,
        last_failure: Option<&VerificationFailure>,
    ) -> Result<Vec<Edit>> {
        let mut edits = Vec::new();

        for intent in &plan.target_files {
            let source = context.source(&intent.file_path).context("缺少目标文件")?;
            let parsed = self.parse(source, &intent.file_path)?;
            let strategy = self.select_strategy(intent, &parsed, last_failure)?;

            let edit = match strategy {
                EditStrategy::SemanticReplace { selector, new_code } => {
                    self.semantic_replace(&parsed, &selector, &new_code)?
                }
                EditStrategy::InsertAfter { anchor, new_code } => {
                    self.insert_after(&parsed, &anchor, &new_code)?
                }
                EditStrategy::FullRewrite { new_code } => {
                    self.full_rewrite(&intent.file_path, &new_code, &parsed)?
                }
            };
            edits.push(edit);
        }

        Ok(edits)
    }

    fn semantic_replace(
        &self,
        parsed: &ParsedFile,
        selector: &NodeSelector,
        new_code: &str,
    ) -> Result<Edit> {
        let node = parsed
            .query(selector)
            .context("未定位到目标语法节点")?;
        let formatted = preserve_indentation(parsed.source(), node.byte_range(), new_code);

        Ok(Edit {
            edit_type: EditType::Patch,
            file_path: parsed.path.clone(),
            byte_range: Some(node.byte_range()),
            new_content: formatted,
        })
    }

    fn parse(&self, source: &str, path: &Path) -> Result<ParsedFile> {
        let language: Language = self.languages.for_path(path)?;
        let mut parser = Parser::new();
        parser.set_language(&language)?;
        let tree = parser.parse(source, None).context("tree-sitter 解析失败")?;
        Ok(ParsedFile::new(path, source, tree))
    }
}
```

**提案边界**：

- 语法节点适配器必须与具体 grammar 版本绑定，并通过 fixture 测试。
- 如果目标语言没有可用 grammar，只能使用纯文本补丁，并在结果中明确说明无法执行 AST 编辑的原因；不要伪造 AST 保证。
- 写回前仍要经过现有 patch 工具与工作区权限检查。
- 当前已实现 TS/JS/TSX 解析、符号索引、语义编辑、前端诊断归一化、错误模式与修复计划，以及 `coding_verify`；完整 Coding Loop 编排、模型辅助诊断和 LSP 仍属增量提案。

---

## 🔌 跨端协议（复用现有 Rust 边界）

### Desktop 侧调用

Desktop 不运行编码引擎。第一阶段复用现有 `chat.send` 生命周期，通过 `codingMode` 开启门禁，并调用 Rust 原生 `coding_verify` 工具；不新增独立编码 RPC：

```json
{"jsonrpc":"2.0","id":41,"method":"chat.send","params":{"conversationId":"conv_123","text":"修复类型错误","targetProjectId":"proj_123","codingMode":true}}
```

编码阶段的工具调用、验证结果和最终状态继续复用现有事件流。`coding.execute` / `coding.cancel` 保留为未来独立任务 API 的候选，不作为当前 MVP 入口，避免复制 `chat.send`、取消和续传生命周期。

### CLI 侧调用

```rust
// 示意：CLI 在 Rust 进程内复用编码服务
use anyhow::Result;
use worldbase_coding::{CodingContext, CodingRequest, CodingService};

#[tokio::main]
async fn main() -> Result<()> {
    let service = CodingService::from_harness_config().await?;
    let result = service
        .execute(CodingRequest {
            user_prompt: "修复编译错误".into(),
            project_id: Some("proj_123".into()),
            workspace_root: std::env::current_dir()?,
            context: CodingContext::default(),
        })
        .await?;

    println!("status={:?} rounds={}", result.status, result.repair_rounds);
    Ok(())
}
```

实际落地时可直接调用 library API；如果 CLI 作为独立进程运行，则复用 `worldbase-protocol` 的 JSON-RPC 客户端。

### Mobile 侧调用（手写 `dart:ffi`）

Mobile 通过手写 `dart:ffi` 绑定加载 native harness。FFI 只负责进程内启动与端口/鉴权信息获取，编码请求仍通过现有 JSON-RPC 连接发送。

```dart
// apps/mobile/lib/core/harness_ffi.dart 中的绑定模式（示意）
import 'dart:ffi';
import 'package:ffi/ffi.dart';

typedef _StartNative = Int32 Function(Pointer<Uint8> dataDir, Uint32 portHint);
typedef _StartDart = int Function(Pointer<Uint8> dataDir, int portHint);

final library = DynamicLibrary.process();
final startHarness = library.lookupFunction<_StartNative, _StartDart>(
  'worldbase_start',
);

int startInProcessHarness(String dataDir) {
  final dir = dataDir.toNativeUtf8();
  try {
    return startHarness(dir.cast<Uint8>(), 0);
  } finally {
    malloc.free(dir);
  }
}
```

约束：

- 绑定代码手写并提交到 Mobile 仓库，显式声明参数类型、内存所有权和释放责任。
- native 库构建由 cargo 驱动，产物通过现有打包流程注入。
- 不允许在 Dart 侧实现第二套编码编排。

---

## 📅 实施计划（提案）

### 时间线（16 周）

| 阶段 | 周数 | 内容 | 交付物 |
|------|------|------|--------|
| 1 | Week 1-2 | Rust crate、数据结构、协议能力声明 | `crates/coding` 骨架 + `cargo test` 基线 |
| 2 | Week 3-6 | 编码门禁、验证 profile、修复状态 | 复用现有循环的 `codingMode` + `coding_verify` |
| 3 | Week 7-10 | TS/JS/TSX tree-sitter 与语义编辑 | 语法节点定位、最小补丁、格式测试；Rust/Python/Go 后续扩展 |
| 4 | Week 11-13 | Error Analyzer 与模型辅助诊断 | 错误归一化、修复建议、限流与审计 |
| 5 | Week 14-15 | Desktop/CLI/Mobile 集成 | JSON-RPC 联调、手写 FFI 回归测试 |
| 6 | Week 16 | UI 状态与 Alpha 验证 | 进度事件、诊断展示、基准报告 |

### 人员分工（推荐 2 人）

| 角色 | 职责 | 技能要求 |
|------|------|---------|
| **Rust 工程师 A**（主力） | 通用循环接入、Coding Loop、Error Analyzer、协议 | Rust、Tokio、异步取消、JSON-RPC |
| **Rust 工程师 B**（主力） | Context Manager、tree-sitter、语义编辑、验证 | Rust、编译原理、AST、测试工程 |

---

## ✅ 优势总结

### 对编码能力的提升

- 复用现有分段 128 步通用循环，长任务不必从零构建执行框架。
- 编码计划、编辑、验证与诊断共享同一上下文和权限边界。
- AST 编辑和错误分析作为增量能力接入，失败时可退回已验证的普通补丁流程，不影响基础可用性。

### 对长任务的提升

- 上下文压缩减少无效历史占用，为代码与诊断保留预算。
- 只读工具和子代理并行，缩短探索阶段。
- 结构化修复轮次把“继续试试”变成可观测、可中止的收敛过程。

### 对架构的提升

- Desktop、Mobile、CLI 共享单一 Rust 实现。
- 能力通过 JSON-RPC 暴露，Mobile 仅维护手写 FFI 边界。
- 编码模块可独立测试，不需要客户端同步发布同名引擎。

---

## 📞 下一步

### 立即行动

1. 已完成 `crates/coding` 与 `core`、`tools`、`protocol` 的第一版接口边界。
2. 已建立 MVP：`codingMode` 门禁、前端验证 profile、`coding_verify`、TS/JS/TSX 解析。
3. 下一步完善跨阶段 Coding Loop 编排、真实项目基准与 LSP。
4. 保持 `chat.abort` 作为编码任务取消入口，补齐验证命令取消和超时测试。
5. 用 `cargo test --workspace` 与 Electron 契约测试验证不改变现有行为。

### 参考资料

- **架构设计与实施指南**：模块职责、数据结构和路线图。
- **核心算法与代码示例**：Rust 伪代码与算法边界。
- **实施检查清单**：按“已实现 / 提案 / 验收”三态更新任务状态。

---

**版本**：2.1  
**维护者**：WorldBase AI 团队  
**最后更新**：2026-10-21
