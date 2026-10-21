# WorldBase 编码能力升级 - 核心算法与代码示例（Rust）

**版本**：2.0  
**目标读者**：Rust 工程师、架构师  
**说明**：本文提供 Rust 伪代码与算法边界，用于指导 `harness-rs` 中的实现。除“当前基线”外，代码均为提案示意，不代表已编译或已上线 API。

> **当前事实**：`worldbase-core` 的通用 Agent 循环已支持最多 128 步、上下文压缩、并行只读工具和并行子代理。Coding Loop、tree-sitter AST 编辑、Error Analyzer 与 LSP 集成都尚未实现。

---

## 目录

1. [Coding Loop Orchestrator 核心算法](#1-coding-loop-orchestrator-核心算法)
2. [Smart Editor 实现示例](#2-smart-editor-实现示例)
3. [Error Analyzer 实现示例](#3-error-analyzer-实现示例)
4. [Context Manager 实现示例](#4-context-manager-实现示例)
5. [Tool Executor 并行化实现](#5-tool-executor-并行化实现)
6. [AST 查询语言实现](#6-ast-查询语言实现)

---

## 1. Coding Loop Orchestrator 核心算法

### 1.1 主循环逻辑（Rust 伪代码）

```rust
// 提案：crates/coding/src/orchestrator.rs
use std::sync::Arc;
use anyhow::{Context, Result};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

pub struct CodingOrchestrator {
    planner: Arc<dyn CodingPlanner>,
    context_manager: Arc<ContextManager>,
    smart_editor: Arc<SmartEditor>,
    error_analyzer: Arc<ErrorAnalyzer>,
    verification: Arc<VerificationEngine>,
    session_store: Arc<SessionStore>,
    config: CodingConfig,
}

impl CodingOrchestrator {
    pub async fn execute(
        &self,
        request: CodingRequest,
        cancel: CancellationToken,
    ) -> Result<CodingResult> {
        let started = std::time::Instant::now();
        let session_id = SessionId::new();
        let mut metrics = CodingMetrics::default();

        self.session_store
            .create_session(&session_id, &request)
            .await?;

        let result = self
            .execute_inner(&session_id, &request, &cancel, &mut metrics)
            .await;

        let status = match &result {
            Ok(value) => value.status,
            Err(_) => CodingStatus::Failed,
        };
        self.session_store
            .finish_session(&session_id, status, started.elapsed())
            .await?;

        result
    }

    async fn execute_inner(
        &self,
        session_id: &SessionId,
        request: &CodingRequest,
        cancel: &CancellationToken,
        metrics: &mut CodingMetrics,
    ) -> Result<CodingResult> {
        // 阶段 1：计划。编码计划本身不消耗通用循环的 128 步预算；
        // 计划中的模型调用仍由 core 的预算与取消机制控制。
        let plan = tokio::select! {
            _ = cancel.cancelled() => return Err(anyhow::anyhow!("任务已取消")),
            plan = self.planner.plan(request) => plan.context("生成编码计划失败")?,
        };
        self.session_store.save_plan(session_id, &plan).await?;

        // 阶段 2：上下文。复用只读工具、并发限制和现有压缩器。
        let context = self
            .context_manager
            .gather_for_plan(&plan, &request.workspace_root, cancel)
            .await?;
        metrics.files_read = context.files.len() as u32;
        metrics.context_bytes = context.total_bytes;

        let mut all_changes = Vec::new();
        let mut last_failure = None;

        // 阶段 3：有限修复轮次。每轮都必须重新验证，不允许无证据地宣称完成。
        for repair_round in 1..=self.config.max_repair_rounds {
            self.session_store
                .start_round(session_id, repair_round)
                .await?;

            let edits = self
                .smart_editor
                .generate(&plan, &context, last_failure.as_ref(), cancel)
                .await?;

            let applied = self
                .apply_edits_checked(&request.workspace_root, &edits, cancel)
                .await?;
            all_changes.extend(applied);
            metrics.files_modified = all_changes
                .iter()
                .map(|edit| &edit.file_path)
                .collect::<std::collections::HashSet<_>>()
                .len() as u32;

            let verification = self
                .verification
                .verify(&plan.verification_steps, cancel)
                .await?;
            metrics.verification_attempts += 1;

            if verification.passed {
                info!(repair_round, "编码验证通过");
                return Ok(CodingResult::success(repair_round, all_changes, metrics.clone()));
            }

            let diagnosis = self
                .error_analyzer
                .diagnose(&verification.failure, &context)
                .await?;

            warn!(
                repair_round,
                category = ?diagnosis.category,
                recoverable = diagnosis.is_recoverable,
                "编码验证失败"
            );

            if !diagnosis.is_recoverable {
                return Ok(CodingResult::partial(
                    repair_round,
                    all_changes,
                    diagnosis,
                    metrics.clone(),
                ));
            }

            plan.apply_diagnosis(&diagnosis);
            last_failure = Some(verification.failure);
            self.session_store
                .finish_round(session_id, repair_round, &diagnosis, &verification)
                .await?;
        }

        Ok(CodingResult::partial(
            self.config.max_repair_rounds,
            all_changes,
            self.error_analyzer.last_diagnosis(),
            metrics.clone(),
        ))
    }
}
```

**预算关系**：

```text
通用 Agent 循环：最多 128 个模型/工具步骤（已实现）
        └── Coding Loop：最多 max_repair_rounds 个验证/修复轮次（提案）
                └── 每轮的计划、编辑、验证、诊断都受总步数和取消信号约束
```

编码层不得新建一个独立预算来绕过 128 步上限。实现时必须把 core 的 step budget、取消 token、权限上下文透传给每个子步骤。

### 1.2 计划生成与上下文分析

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodingPlan {
    pub required_files: Vec<PathBuf>,
    pub target_files: Vec<FileEditIntent>,
    pub verification_steps: Vec<VerificationStep>,
    pub estimated_complexity: Complexity,
    pub risks: Vec<String>,
}

impl LlmPlanner {
    async fn plan(&self, request: &CodingRequest) -> Result<CodingPlan> {
        let prompt = build_planning_prompt(request);
        let response = self
            .provider
            .complete_json::<CodingPlan>(&prompt, self.config.plan_timeout)
            .await?;

        validate_plan(&response, &request.workspace_root)?;
        Ok(response)
    }
}

fn build_planning_prompt(request: &CodingRequest) -> String {
    format!(
        r#"你是 WorldBase 的编码规划器。请只输出符合 schema 的 JSON。

用户请求：
{prompt}

工作区：
{workspace}

已打开文件：
{open_files}

请给出：
1. 需要读取的文件及原因；
2. 需要修改的文件、编辑意图和依赖边界；
3. 可执行的验证步骤；
4. 复杂度与风险。

不要声称已经修改文件。不要提出超出工作区的路径。"#,
        prompt = request.user_prompt,
        workspace = request.workspace_root.display(),
        open_files = request
            .context
            .open_files
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", "),
    )
}
```

计划校验至少包括：工作区边界、重复目标、无效验证命令、无法解析的路径和与用户请求无关的删除操作。验证命令必须来自允许列表或经过权限层确认。

### 1.3 编辑应用与超时

```rust
impl CodingOrchestrator {
    async fn apply_edits_checked(
        &self,
        workspace: &Path,
        edits: &[Edit],
        cancel: &CancellationToken,
    ) -> Result<Vec<Edit>> {
        let snapshot = self.snapshot_workspace_files(workspace, edits).await?;
        let mut applied = Vec::with_capacity(edits.len());

        for edit in edits {
            tokio::select! {
                _ = cancel.cancelled() => {
                    self.rollback(snapshot).await?;
                    return Err(anyhow::anyhow!("应用编辑时任务被取消"));
                }
                result = self.patch_tool.apply_checked(workspace, edit) => {
                    match result {
                        Ok(()) => applied.push(edit.clone()),
                        Err(error) => {
                            self.rollback(snapshot).await?;
                            return Err(error).context("应用编辑失败，已回滚本轮修改");
                        }
                    }
                }
            }
        }

        Ok(applied)
    }

    async fn verify_with_timeout(
        &self,
        steps: &[VerificationStep],
        cancel: &CancellationToken,
    ) -> Result<VerificationResult> {
        let timeout = tokio::time::Duration::from_secs(self.config.verify_timeout_secs);
        tokio::select! {
            _ = cancel.cancelled() => Err(anyhow::anyhow!("验证已取消")),
            result = tokio::time::timeout(timeout, self.verification.verify(steps, cancel)) => {
                result.context("验证超时")?
            }
        }
    }
}
```

---

## 2. Smart Editor 实现示例

### 2.1 语义定位与替换

以下代码展示 Rust 实现结构。AST 编辑尚未实现，tree-sitter grammar 版本、节点类型和字段名必须在目标语言适配器中分别验证。

```rust
// 提案：crates/coding/src/smart_editor/mod.rs
use std::collections::HashMap;
use anyhow::{Context, Result};
use tree_sitter::{Language, Parser, Tree};

pub struct SmartEditor {
    adapters: HashMap<LanguageId, LanguageAdapter>,
    config: SmartEditorConfig,
}

pub struct ParsedFile {
    pub path: PathBuf,
    pub source: Arc<str>,
    pub language: LanguageId,
    pub tree: Tree,
}

impl SmartEditor {
    pub async fn generate(
        &self,
        plan: &CodingPlan,
        context: &CodeContext,
        last_failure: Option<&VerificationFailure>,
        cancel: &CancellationToken,
    ) -> Result<Vec<Edit>> {
        let mut edits = Vec::new();

        for intent in &plan.target_files {
            tokio::select! {
                _ = cancel.cancelled() => return Err(anyhow::anyhow!("生成编辑已取消")),
                _ = tokio::task::yield_now() => {}
            }

            let source = context
                .source(&intent.file_path)
                .context("上下文中缺少目标文件")?;
            let parsed = self.parse(source, &intent.file_path)?;
            let strategy = self.select_strategy(intent, &parsed, last_failure)?;

            edits.push(match strategy {
                EditStrategy::SemanticReplace { target, new_code } => {
                    self.semantic_replace(&parsed, &target, &new_code)?
                }
                EditStrategy::InsertAfter { anchor, new_code } => {
                    self.insert_after(&parsed, &anchor, &new_code)?
                }
                EditStrategy::TextPatch { range, new_code } => {
                    self.text_patch(&parsed, range, &new_code)
                }
                EditStrategy::FullRewrite { new_code } => {
                    self.full_rewrite(&parsed, &new_code)
                }
            });
        }

        Ok(edits)
    }

    fn semantic_replace(
        &self,
        parsed: &ParsedFile,
        selector: &NodeSelector,
        new_code: &str,
    ) -> Result<Edit> {
        let matches = parsed.query_all(selector)?;
        if matches.len() != 1 {
            anyhow::bail!(
                "目标节点必须唯一，实际匹配 {} 个：{}",
                matches.len(),
                selector.describe()
            );
        }

        let target = matches[0];
        let replacement = format_for_range(parsed, target.byte_range(), new_code)?;
        Ok(Edit {
            edit_type: EditType::Patch,
            file_path: parsed.path.clone(),
            byte_range: Some(target.byte_range()),
            new_content: replacement,
        })
    }

    fn insert_after(
        &self,
        parsed: &ParsedFile,
        anchor: &NodeSelector,
        new_code: &str,
    ) -> Result<Edit> {
        let matches = parsed.query_all(anchor)?;
        if matches.len() != 1 {
            anyhow::bail!("插入锚点必须唯一，实际匹配 {} 个", matches.len());
        }
        let end = matches[0].byte_range().end;
        let indent = indentation_at(parsed.source(), matches[0].start_byte());
        let inserted = indent_multiline(new_code, indent);

        Ok(Edit {
            edit_type: EditType::Patch,
            file_path: parsed.path.clone(),
            byte_range: Some(end..end),
            new_content: inserted,
        })
    }

    fn parse(&self, source: &str, path: &Path) -> Result<ParsedFile> {
        let language_id = LanguageId::from_path(path)?;
        let adapter = self
            .adapters
            .get(&language_id)
            .context("没有可用的 tree-sitter grammar")?;
        let language: Language = adapter.language();

        let mut parser = Parser::new();
        parser.set_language(&language)?;
        let tree = parser.parse(source, None).context("tree-sitter 解析失败")?;

        Ok(ParsedFile {
            path: path.to_path_buf(),
            source: Arc::from(source),
            language: language_id,
            tree,
        })
    }
}
```

**策略选择**：

```rust
fn select_strategy(
    intent: &FileEditIntent,
    parsed: &ParsedFile,
    last_failure: Option<&VerificationFailure>,
) -> Result<EditStrategy> {
    if intent.edit_type == EditKind::Create {
        return Ok(EditStrategy::FullRewrite {
            new_code: intent.initial_content.clone().unwrap_or_default(),
        });
    }

    if let Some(selector) = intent.target_selector.as_ref() {
        let matches = parsed.query_all(selector)?;
        if matches.len() == 1 {
            return Ok(EditStrategy::SemanticReplace {
                target: selector.clone(),
                new_code: intent.new_code.clone(),
            });
        }
    }

    if let Some(anchor) = intent.anchor_selector.as_ref() {
        if parsed.query_all(anchor)?.len() == 1 {
            return Ok(EditStrategy::InsertAfter {
                anchor: anchor.clone(),
                new_code: intent.new_code.clone(),
            });
        }
    }

    if intent.change_ratio() > parsed.full_rewrite_threshold() {
        return Ok(EditStrategy::FullRewrite {
            new_code: intent.new_code.clone(),
        });
    }

    // 没有可靠语法锚点时，使用文本补丁，并记录限制。
    Ok(EditStrategy::TextPatch {
        range: intent.text_patch_range(),
        new_code: intent.new_code.clone(),
    })
}
```

上面的 `text_patch_range` 仅表示文本补丁的范围选择方法和必须记录的限制，不表示第二套编辑器。生产实现应提供明确范围、内容哈希和验证证据；无法确定安全范围时应拒绝自动编辑。

### 2.2 格式保持与编辑后校验

```rust
fn format_for_range(
    parsed: &ParsedFile,
    range: Range<usize>,
    new_code: &str,
) -> Result<String> {
    let original = &parsed.source[range.clone()];
    let indent = detect_indentation(original).unwrap_or("    ");
    let newline = detect_newline(original);
    Ok(apply_indentation_and_newlines(new_code, indent, newline))
}

fn validate_edited_tree(parsed: &ParsedFile, edited_source: &str) -> Result<()> {
    let mut parser = Parser::new();
    parser.set_language(&parsed.language())?;
    let tree = parser.parse(edited_source, None).context("无法解析编辑结果")?;
    let root = tree.root_node();

    if root.has_error() {
        anyhow::bail!("编辑结果包含语法错误节点");
    }
    Ok(())
}
```

编辑流程必须是：

```text
定位节点 -> 检查唯一性 -> 生成补丁 -> 保留格式 -> 应用补丁
-> 重新解析 -> 运行 formatter/编译/测试 -> 记录证据
```

---

## 3. Error Analyzer 实现示例

### 3.1 错误模式匹配

```rust
// 提案：crates/coding/src/error_analyzer/mod.rs
use std::sync::Arc;
use anyhow::{Context, Result};
use regex::Regex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ErrorCategory {
    Syntax,
    Type,
    Import,
    Runtime,
    Logic,
    Unknown,
}

#[derive(Debug, Clone)]
pub struct ErrorPattern {
    pub id: String,
    pub category: ErrorCategory,
    pub regex: Regex,
    pub priority: u16,
    pub is_recoverable: bool,
    pub action_template: FixActionTemplate,
}

pub struct ErrorAnalyzer {
    store: Arc<ErrorPatternStore>,
    patterns: Vec<ErrorPattern>,
    model: Arc<dyn DiagnosisModel>,
}

impl ErrorAnalyzer {
    pub async fn diagnose(
        &self,
        failure: &VerificationFailure,
        context: &CodeContext,
    ) -> Result<ErrorDiagnosis> {
        let normalized = self.normalize(failure)?;

        for pattern in &self.patterns {
            let Some(captures) = pattern.regex.captures(&normalized.message) else {
                continue;
            };

            let suggestion = self
                .build_suggestion(pattern, &captures, context)
                .await?;
            self.store.increment_usage(&pattern.id).await?;

            return Ok(ErrorDiagnosis {
                category: pattern.category,
                is_recoverable: pattern.is_recoverable,
                suggestions: vec![suggestion],
                confidence: 0.95,
                evidence: normalized.evidence,
            });
        }

        // 未知错误进入模型辅助诊断；结果只作为建议，除非通过验证。
        self.model_diagnose(&normalized, context).await
    }

    async fn model_diagnose(
        &self,
        normalized: &NormalizedError,
        context: &CodeContext,
    ) -> Result<ErrorDiagnosis> {
        let request = DiagnosisRequest {
            message: normalized.message.clone(),
            stack: normalized.stack.clone(),
            relevant_source: context.bounded_source_excerpt(),
            max_output_tokens: self.config.max_diagnosis_tokens,
        };

        let response = tokio::time::timeout(
            self.config.model_timeout,
            self.model.diagnose(request),
        )
        .await
        .context("模型辅助诊断超时")??;

        validate_diagnosis_schema(&response)?;
        Ok(response)
    }
}
```

**模式优先级**：

1. 明确的编译器错误码；
2. 文件与行列范围可定位的错误；
3. 项目级依赖/配置错误；
4. 测试断言失败；
5. 无定位信息的通用消息。

同一错误可能匹配多条规则，必须按“具体程度 + 优先级 + 最近验证轮次”排序，不能只按正则首次匹配返回。

**修复建议的最小结构**：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixSuggestion {
    pub action: FixAction,
    pub target_files: Vec<PathBuf>,
    pub rationale: String,
    pub confidence: f32,
    pub requires_manual_review: bool,
    pub verification_steps: Vec<VerificationStep>,
}
```

`requires_manual_review = true` 的建议不得直接写入源码。模型输出和规则输出使用同一 schema，便于审计。

### 3.2 TOP 20 错误模式定义

下表是初始规则集，落地时必须用真实编译器与测试输出 fixture 验证。表中“可恢复”只是候选标记，最终仍由上下文、权限和验证结果决定。

| ID | 类别 | 匹配模式 | 优先级 | 可恢复 | 建议动作 |
|----|------|----------|--------|--------|----------|
| syntax_001 | Syntax | `expected one of` | 1 | 是 | 补齐缺失的语法元素 |
| syntax_002 | Syntax | `unexpected closing delimiter` | 1 | 是 | 修复括号/分隔符匹配 |
| syntax_003 | Syntax | `unterminated string` | 1 | 是 | 修复字符串边界 |
| syntax_004 | Syntax | `mismatched closing delimiter` | 1 | 是 | 对齐开始/结束符号 |
| type_001 | Type | `expected .* found .*` | 2 | 是 | 统一表达式与目标类型 |
| type_002 | Type | `cannot find type` | 2 | 是 | 补充类型导入或定义 |
| type_003 | Type | `trait bound .* not satisfied` | 2 | 是 | 调整泛型约束或实现 trait |
| type_004 | Type | `no method named` | 2 | 是 | 检查接收者类型与方法导入 |
| type_005 | Type | `mismatched types` | 2 | 是 | 对齐函数签名与调用参数 |
| import_001 | Import | `unresolved import` | 1 | 是 | 检查模块路径与依赖声明 |
| import_002 | Import | `could not find .* in this scope` | 1 | 是 | 添加导入或限定路径 |
| import_003 | Import | `use of undeclared crate or module` | 1 | 是 | 检查 crate/module 名称 |
| import_004 | Import | `missing .* dependency` | 2 | 是 | 检查清单文件和 feature |
| runtime_001 | Runtime | `panicked at` | 3 | 视上下文 | 定位 panic 与输入边界 |
| runtime_002 | Runtime | `index out of bounds` | 3 | 是 | 增加边界检查或修正索引 |
| runtime_003 | Runtime | `called .* on .* None` | 3 | 是 | 补充分支处理 |
| logic_001 | Logic | `assertion failed` | 4 | 是 | 对齐预期值与实际行为 |
| logic_002 | Logic | `test .* failed` | 4 | 是 | 定位测试与实现差异 |
| logic_003 | Logic | `timeout` | 4 | 视上下文 | 检查死锁、重试与超时配置 |
| config_001 | Unknown | `invalid manifest` | 2 | 是 | 修复配置格式与版本字段 |

规则库应保留原始错误文本、规范化结果、命中的规则 ID 和验证结果。新增规则不能以提高覆盖率为由降低置信度门槛。

---

## 4. Context Manager 实现示例

### 4.1 智能上下文收集

```rust
// 提案：crates/coding/src/context.rs
use std::sync::Arc;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

pub struct ContextManager {
    cache: Arc<ContentCache>,
    compression: Arc<ContextCompressor>,
    max_parallel_reads: usize,
    budget: ContextBudget,
}

impl ContextManager {
    pub async fn gather_for_plan(
        &self,
        plan: &CodingPlan,
        workspace: &Path,
        cancel: &CancellationToken,
    ) -> Result<CodeContext> {
        let started = std::time::Instant::now();

        // 1. 依赖分析：只展开到当前 crate/module 的直接边界。
        let expanded = self.analyze_and_expand(plan, workspace).await?;

        // 2. 只读并行读取，复用工具权限与忽略规则。
        let contents = self
            .parallel_read(&expanded, workspace, cancel)
            .await?;

        // 3. 加入当前验证错误与最近编辑摘要。
        let focused = self.focus(contents, plan, self.budget.max_bytes)?;

        // 4. 复用已有上下文压缩器。
        let compressed = self
            .compression
            .compress_for_task(focused, self.budget.max_tokens)
            .await?;

        Ok(CodeContext {
            files: compressed.files,
            relevant_errors: plan.current_errors(),
            recent_edits: plan.recent_edits(),
            stats: ContextStats {
                files_read: compressed.stats.files_read,
                bytes_read: compressed.stats.bytes_read,
                bytes_retained: compressed.stats.bytes_retained,
                elapsed_ms: started.elapsed().as_millis() as u64,
            },
        })
    }

    async fn parallel_read(
        &self,
        paths: &[PathBuf],
        workspace: &Path,
        cancel: &CancellationToken,
    ) -> Result<Vec<FileContent>> {
        let semaphore = Arc::new(Semaphore::new(self.max_parallel_reads));
        let mut tasks = JoinSet::new();

        for path in paths {
            let path = path.clone();
            let workspace = workspace.to_path_buf();
            let semaphore = semaphore.clone();
            let cache = self.cache.clone();
            let cancel = cancel.clone();

            tasks.spawn(async move {
                tokio::select! {
                    _ = cancel.cancelled() => Err(anyhow::anyhow!("读取上下文中止")),
                    permit = semaphore.acquire_owned() => {
                        let _permit = permit?;
                        if let Some(hit) = cache.get(&path).await? {
                            return Ok(hit);
                        }
                        let content = read_workspace_file(&workspace, &path).await?;
                        cache.insert(path, content.clone()).await?;
                        Ok(content)
                    }
                }
            });
        }

        let mut files = Vec::new();
        while let Some(result) = tasks.join_next().await {
            files.push(result??);
        }
        Ok(files)
    }
}
```

**依赖展开边界**：

```text
1. 目标文件本身
2. 目标文件直接引用、且位于当前工作区的模块
3. 当前 crate/module 的清单文件与验证配置
4. 当前验证失败涉及的符号、测试和 fixture
5. 总数、单文件大小和总字节数达到预算即停止扩展
```

禁止无界递归整个工作区，也不要把 `.git`、构建产物、缓存目录和敏感配置送入上下文。

**压缩策略**：

```rust
pub struct ContextCompressor;

impl ContextCompressor {
    pub async fn compress_for_task(
        &self,
        files: Vec<FileContent>,
        max_tokens: usize,
    ) -> Result<CompressedContext> {
        let recent = keep_recent_edits_and_errors(&files);
        let symbols = extract_relevant_symbols(&files);
        let summaries = summarize_older_files(&files).await?;
        pack_until_budget(recent, symbols, summaries, max_tokens)
    }
}
```

压缩输出必须保留路径、符号名、错误码、已验证结论和未决问题。压缩本身是提案中的编码增强步骤，底层上下文压缩能力已经存在。

---

## 5. Tool Executor 并行化实现

### 5.1 当前基线

- 相互独立的只读文件读取、搜索等工具可以并行执行。
- `spawn_subagents` 支持并行子任务。
- 有写入、外部副作用或数据依赖的调用必须按安全顺序执行。
- 所有调用仍受权限层、超时、取消和全局并发上限约束。

### 5.2 依赖图与分层执行（提案）

```rust
use std::collections::{HashMap, VecDeque};
use anyhow::{bail, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolEffect {
    ReadOnly,
    Mutating,
    ExternalSideEffect,
}

#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: CallId,
    pub name: String,
    pub effect: ToolEffect,
    pub target: Option<PathBuf>,
    pub depends_on: Vec<CallId>,
}

#[derive(Debug, Default)]
pub struct DependencyGraph {
    pub nodes: Vec<CallId>,
    pub edges: Vec<(CallId, CallId)>,
}

pub fn build_dependency_graph(calls: &[ToolCall]) -> Result<DependencyGraph> {
    let mut graph = DependencyGraph {
        nodes: calls.iter().map(|call| call.id).collect(),
        edges: Vec::new(),
    };

    for call in calls {
        // 1. 显式依赖优先。
        for dependency in &call.depends_on {
            graph.edges.push((*dependency, call.id));
        }

        // 2. 相同文件的写操作依赖先前的读操作，并串行化写操作。
        if call.effect == ToolEffect::Mutating {
            if let Some(target) = &call.target {
                for earlier in calls.iter().filter(|candidate| {
                    candidate.target.as_ref() == Some(target)
                        && candidate.id != call.id
                }) {
                    if earlier.effect == ToolEffect::ReadOnly {
                        graph.edges.push((earlier.id, call.id));
                    } else if earlier.effect == ToolEffect::Mutating
                        && earlier.id.0 < call.id.0
                    {
                        graph.edges.push((earlier.id, call.id));
                    }
                }
            }
        }

        // 3. 未知副作用的调用必须串行化，避免隐式竞态。
        if call.effect == ToolEffect::ExternalSideEffect {
            for earlier in calls.iter().filter(|candidate| {
                candidate.id.0 < call.id.0
                    && candidate.effect == ToolEffect::ExternalSideEffect
            }) {
                graph.edges.push((earlier.id, call.id));
            }
        }
    }

    Ok(graph)
}

pub fn topological_layers(graph: &DependencyGraph) -> Result<Vec<Vec<CallId>>> {
    let mut in_degree: HashMap<CallId, usize> =
        graph.nodes.iter().copied().map(|id| (id, 0)).collect();
    let mut outgoing: HashMap<CallId, Vec<CallId>> = HashMap::new();

    for (from, to) in &graph.edges {
        outgoing.entry(*from).or_default().push(*to);
        *in_degree.entry(*to).or_default() += 1;
    }

    let mut ready: VecDeque<CallId> = in_degree
        .iter()
        .filter_map(|(id, degree)| (*degree == 0).then_some(*id))
        .collect();

    let mut layers = Vec::new();
    let mut visited = 0usize;

    while !ready.is_empty() {
        let mut layer = Vec::new();
        let layer_size = ready.len();

        for _ in 0..layer_size {
            let id = ready.pop_front().expect("ready queue is non-empty");
            visited += 1;
            layer.push(id);

            if let Some(neighbors) = outgoing.get(&id) {
                for neighbor in neighbors {
                    let degree = in_degree
                        .get_mut(neighbor)
                        .expect("edge target must exist");
                    *degree -= 1;
                    if *degree == 0 {
                        ready.push_back(*neighbor);
                    }
                }
            }
        }

        layers.push(layer);
    }

    if visited != graph.nodes.len() {
        bail!("工具调用依赖图包含环或未知依赖");
    }
    Ok(layers)
}
```

**执行规则**：

```text
1. 先校验每个 ToolCall 的工具名、参数和权限。
2. 只读节点可以同层并行；写入/外部副作用默认单独成层。
3. 每层执行前检查取消信号，执行后汇总结构化结果。
4. 某个节点失败时，将其后继节点标记为 Blocked，不执行未满足依赖的调用。
5. 不得因为一个只读调用失败而取消同一层中已安全完成的读取。
```

实现时应优先复用 `worldbase-tools` 的现有调用注册、权限与并行调度；上述 DAG 是提案层，不是当前已实现行为。

---

## 6. AST 查询语言实现

### 6.1 声明式查询 API

```rust
// 提案：crates/coding/src/smart_editor/query.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeSelector {
    pub kind: String,
    pub name: Option<String>,
    pub within: Option<Box<NodeSelector>>,
    pub has_child: Option<Box<NodeSelector>>,
    pub text_pattern: Option<String>,
}

impl NodeSelector {
    pub fn new(kind: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            name: None,
            within: None,
            has_child: None,
            text_pattern: None,
        }
    }

    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    pub fn within(mut self, parent: NodeSelector) -> Self {
        self.within = Some(Box::new(parent));
        self
    }

    pub fn with_child(mut self, child: NodeSelector) -> Self {
        self.has_child = Some(Box::new(child));
        self
    }

    pub fn with_text_matches(mut self, pattern: impl Into<String>) -> Self {
        self.text_pattern = Some(pattern.into());
        self
    }
}

pub trait TreeQuery {
    fn root(&self) -> SyntaxNodeRef;
    fn children<'a>(&'a self, syntax_node: &'a SyntaxNodeRef) -> Vec<SyntaxNodeRef>;
    fn kind(&self, syntax_node: &SyntaxNodeRef) -> &str;
    fn field_text(&self, syntax_node: &SyntaxNodeRef, field: &str) -> Option<String>;
    fn text(&self, syntax_node: &SyntaxNodeRef) -> String;
}

pub fn query_first(
    tree: &dyn TreeQuery,
    selector: &NodeSelector,
) -> Option<SyntaxNodeRef> {
    query_all(tree, selector).into_iter().next()
}

pub fn query_all(
    tree: &dyn TreeQuery,
    selector: &NodeSelector,
) -> Vec<SyntaxNodeRef> {
    let root = match &selector.within {
        Some(parent_selector) => match query_first(tree, parent_selector) {
            Some(parent) => parent,
            None => return Vec::new(),
        },
        None => tree.root(),
    };

    let mut results = Vec::new();
    collect_matches(tree, &root, selector, &mut results);
    results
}

fn collect_matches(
    tree: &dyn TreeQuery,
    current: &SyntaxNodeRef,
    selector: &NodeSelector,
    results: &mut Vec<SyntaxNodeRef>,
) {
    if matches_selector(tree, current, selector) {
        results.push(current.clone());
    }

    for child in tree.children(current) {
        collect_matches(tree, &child, selector, results);
    }
}

fn matches_selector(
    tree: &dyn TreeQuery,
    syntax_node: &SyntaxNodeRef,
    selector: &NodeSelector,
) -> bool {
    if tree.kind(syntax_node) != selector.kind {
        return false;
    }

    if let Some(name) = &selector.name {
        if tree.field_text(syntax_node, "name").as_deref() != Some(name.as_str()) {
            return false;
        }
    }

    if let Some(child_selector) = &selector.has_child {
        let has_match = tree
            .children(syntax_node)
            .iter()
            .any(|child| matches_selector(tree, child, child_selector));
        if !has_match {
            return false;
        }
    }

    if let Some(pattern) = &selector.text_pattern {
        let regex = match Regex::new(pattern) {
            Ok(regex) => regex,
            Err(_) => return false,
        };
        if !regex.is_match(&tree.text(syntax_node)) {
            return false;
        }
    }

    true
}
```

`query_all` 在 `within` 找不到父节点时返回空集合而不是 panic；调用方必须显式处理“未匹配”和“匹配不唯一”两种状态。实际 tree-sitter 绑定可以直接使用 `Tree::root_node()`、节点字段查询和 `QueryCursor`，但对外仍应暴露稳定的内部选择器，避免把 grammar 细节泄漏到 RPC。

### 6.2 使用示例

```text
1. 查找唯一函数：
   NodeSelector::new("function_item").with_name("handle_request")

2. 查找结构体中的方法：
   NodeSelector::new("function_item")
       .within(NodeSelector::new("impl_item").with_name("RequestHandler"))

3. 查找带 return 表达式且包含 TODO 注释的函数：
   组合 has_child 与 text_pattern，并要求结果唯一后才自动替换

4. 查找 TODO/FIXME：
   NodeSelector::new("line_comment").with_text_matches(r"TODO|FIXME")
```

**约束**：

- 自动语义替换只接受唯一匹配。
- 选择器必须携带语言与 grammar 版本，跨语言不能复用节点类型字符串。
- 查询失败、匹配为空、匹配多个和解析错误必须返回不同诊断。
- 任何 AST 修改都要保留原始字节范围、内容哈希和验证证据。

---

## 总结

本文档给出 Rust Harness 编码增强的算法骨架，覆盖：

1. **Coding Loop Orchestrator**：复用 128 步通用循环的编码计划与有限修复轮次。
2. **Smart Editor**：tree-sitter 语法定位、唯一性检查、最小补丁与编辑后校验（提案）。
3. **Error Analyzer**：规则归一化、模式优先级、模型辅助诊断与结构化修复建议（提案）。
4. **Context Manager**：目标文件收集、只读并行读取、预算控制与现有压缩器复用。
5. **Tool Executor**：只读并行基线之上的依赖图与分层调度（提案）。
6. **AST Query**：内部声明式选择器与安全的查询边界（提案）。

所有实现都应以现有 Rust Harness 为唯一运行路径，以验证结果作为成功证据，并以能力状态表区分已实现与未实现功能。

---

**版本**：2.0  
**最后更新**：2026-10-21
