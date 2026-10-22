# WorldBase 编码能力升级 - 实施检查清单

**版本**：2.2
**最后更新**：2026-10-22
**使用说明**：逐项勾选，并把 ✅ 当前能力回归与 🧩 提案交付分开验收。

> **文档导航**：[索引](./coding-capability-enhancement-index.md) · [快速开始](./coding-capability-enhancement-quick-start.md) · [Rust 实施](./coding-capability-enhancement-rust-implementation.md) · [架构](./coding-capability-enhancement-architecture.md) · [算法](./coding-capability-enhancement-algorithms.md) · [检查清单](./coding-capability-enhancement-checklist.md) · [缺口分析](./coding-capability-enhancement-gap-analysis.md) · [详细对标](./coding-capability-enhancement-benchmark-detailed.md) · [执行摘要](./coding-capability-enhancement-executive-summary.md)

## MVP 实施状态（2026-10-22）

- [x] 新增 `worldbase-coding` 纯策略 crate，依赖方向为 `protocol/tools/coding → core`。
- [x] `chat.send` 增加 `codingMode`，未验证修改会阻止 `finish_task: completed` 和普通文本结束。
- [x] 前端验证 profile：pnpm/npm/yarn/bun、typecheck/lint/test/build。
- [x] 前端诊断归一化：TypeScript、ESLint、Jest/Vitest。
- [x] Rust 原生 `coding_verify` 工具：按 profile 顺序执行并返回结构化 evidence。
- [x] 多语言 tree-sitter 解析：TS/JS/TSX、Python、Go、Rust、Java；唯一节点定位与语法错误检测。
- [x] 多语言验证 profile：Cargo、Go modules、pyproject/requirements/uv/poetry、Maven/Gradle。
- [x] 多语言错误归一化：Python（ruff/mypy/pytest）、Go（go test/vet）、Rust（rustc/cargo test）、Java（javac/Maven/Gradle/JUnit）。
- [x] 语义替换提案与符号索引；`coding_edit` 支持 replace/insert_after/delete/rename，落盘前校验文件未变化。
- [x] `coding_verify` JSON evidence 解析为 `VerificationEvidence`；支持 `changed_files` 最小验证集，core 自动注入 dirty files。
- [x] `coding_apply` 批量语义编辑工具：按依赖分批、批内并发、同文件串行、写入前 stale 检查。
- [x] `coding_diagnose` 统一诊断工具：合并编译器日志、LSP publishDiagnostics、包管理器输出与修复计划。
- [x] 依赖诊断：package.json 四类依赖、packageManager/lockfile 检测、缺失包/@types/peer/版本冲突/lockfile 修复命令建议。
- [x] TOP 20+ 前端错误模式、结构化诊断与修复计划，并接入 core 修复门禁。
- [x] 显式 Verify → Diagnose → Repair 状态转换与 E2E 测试（含重复失败和轮次耗尽）。
- [x] 50 项离线前端基准：两套 fixture + 真实仓库 TS/TSX 文件，覆盖符号、编辑、诊断、修复、格式与延迟指标。
- [x] P2 能力层：LSP publishDiagnostics/符号/定义解析、依赖诊断与修复命令建议。
- [x] live LSP 客户端：`LspClient` 管理真实 server 生命周期；`coding_lsp` 按文件拉起已安装 server 并返回归一化诊断。
- [x] 并行写调度：core `tool_scheduler` + `plan_write_batches` 支持 allow-list 独立文件并行、同文件串行、依赖排序和权限回退。
- [x] 依赖修复工具：`coding_fix_dependencies` 默认 dry-run，`confirm=true` 才执行 allow-list 包管理器命令。
- [x] 100 任务离线基准：`tests/benchmark_100.rs`，含 20+ 真实仓库文件读取和逐任务延迟。
- [x] UI 一期：内联编码状态条、编码诊断 tab、代码差异 tab；结构化 coding_status/coding_diff 事件。
- [ ] 真实模型 E2E、真实包管理器写入式测试、live server CI 覆盖、完整 Plan/Inspect 编排。

---

## 阶段 0：基线与约束（Week 1）

### 架构约束
- [x] 确认只维护 `harness-rs/` 一套 Rust 后端。
- [x] 确认不新增第二语言实现或并行运行时。
- [x] 确认提案模块以 Rust crate/模块形式实现。
- [x] 确认移动端使用手写 `dart:ffi` 绑定 C ABI。
- [x] 确认 coding crate 不依赖 core，避免 Cargo 循环依赖。

### 当前能力回归
- [ ] 记录并测试单执行段最多 128 步的循环行为。
- [ ] 记录并测试达到 128 步后的续跑与终止行为。
- [ ] 记录并测试上下文压缩的触发条件。
- [ ] 验证压缩后保留用户目标、最近消息、关键路径、命令和错误证据。
- [ ] 验证同一轮连续只读工具可并行执行。
- [ ] 验证写操作、命令执行和未知工具保持串行。
- [ ] 验证 `spawn_subagents` 并行执行、状态汇总和嵌套限制。

### 基线工具链
- [ ] `cargo fmt --all -- --check` 通过。
- [ ] `cargo check -p worldbase-core` 通过。
- [ ] `cargo test -p worldbase-core` 通过。
- [ ] 建立失败日志、耗时和 token 的采集方式。
- [ ] 建立 50-100 个内部编码任务的基线集。
- [ ] 固定任务仓库、模型参数、超时和评分脚本。

### 阶段 0 验收
- [ ] 现有能力有可重复的回归证据。
- [ ] 已明确 ✅ 当前能力与 🧩 提案的边界。
- [ ] 已确定可独立关闭提案模块的特性开关。
- [ ] 基线报告通过评审。

---

## 阶段 1：Rust 基础设施（Week 1-2）

### 工作区
- [ ] 在 `harness-rs/` 工作区评估新增 `coding-loop`、`code-index`、`diagnostics` 等 crate 的边界。
- [ ] 复用现有 `worldbase-protocol` 类型，避免复制协议定义。
- [ ] 复用现有持久化与错误处理设施。
- [ ] 为提案模块定义稳定接口和版本策略。

### 数据模型
- [x] 定义 `CodingPhase`、`VerificationProfile`、`VerificationCommand`。
- [x] 定义 `Diagnostic`、`DiagnosticSeverity`、`CommandOutcome`、`VerificationEvidence`。
- [x] 定义修复轮次、预算和停止原因。
- [ ] 定义 `SemanticTarget`、`EditPlan`、`FixSuggestion` 的稳定公开形状。
- [ ] 为所有持久化结构添加 serde 兼容性测试。

### 观测与安全
- [ ] 记录每次编码任务的阶段、工具调用、验证结果和停止原因。
- [ ] 对敏感内容做脱敏，不把凭据写入日志或基准数据。
- [ ] 为提案模块增加超时、取消和资源上限。
- [ ] 对所有新增外部依赖做许可证和安全评审。

### 阶段 1 验收
- [ ] 新 crate/模块边界评审通过。
- [ ] 数据模型有单元测试。
- [ ] 观测数据可用于计算成功率、耗时和 token。
- [ ] 现有核心测试无回归。

---

## 阶段 2：🧩 `coding_loop` 提案（Week 3-6）

> 当前通用 Agent 循环已经存在。本阶段不是“从零实现循环”，而是增加编码任务专用策略，并明确与现有循环的集成点。

### 状态机
- [x] 实现 `Verify → Diagnose → Repair` 显式状态转换；`Plan/Edit` 已使用，`Inspect` 仍由通用循环侦察隐式完成。
- [x] 定义 `Complete`、`Blocked`、`BudgetExhausted`、`Cancelled` 等终止原因。
- [ ] 每次状态转换记录原因和证据（当前记录 stop reason 与诊断，未覆盖每次转换）。
- [x] 禁止跳过验证门禁直接进入完成状态。
- [x] 为非法状态转换编写测试。

### 上下文与计划
- [ ] 从现有上下文压缩结果中提取当前目标、已改文件、验证结果和未解决问题。
- [ ] 生成最小文件侦察计划。
- [ ] 复用只读工具并行执行无依赖侦察任务。
- [ ] 对独立调查任务评估是否使用 `spawn_subagents`。
- [ ] 限制重复读取和重复工具调用。

### 验证门禁
- [x] 定义项目验证配置：格式、构建、测试、lint、类型检查。
- [x] 支持按改动范围选择最小验证集（已接入 `coding_verify`，core 自动注入 dirty files）。
- [x] 全部验证命令通过 `run_project_command` 或现有命令工具执行。
- [x] 记录每条命令、退出码、耗时和关键输出。
- [x] 验证失败时生成结构化诊断，而不是只拼接日志。

### 修复控制
- [x] 设置最大修复轮次。
- [ ] 设置总时间和 token 上限（当前仅有单命令超时与命令数上限）。
- [x] 检测重复失败和无效循环。
- [x] 不可恢复错误进入 `Blocked` 并给出人工动作。
- [x] 修复后重新执行完整门禁。
- [ ] 特性开关关闭时完全恢复现有通用循环行为。

### 测试
- [x] 单元测试覆盖状态转换。
- [x] 集成测试覆盖验证失败、修复成功、修复耗尽和重复失败。
- [ ] 回归测试确认 128 步上限语义未被破坏。
- [ ] 对比关闭/开启 `coding_loop` 的任务成功率、耗时和 token。

### 阶段 2 验收
- [x] 编码任务有确定性验证门禁。
- [x] 失败后最多执行配置的修复轮次。
- [x] 终止原因清晰可审计。
- [ ] 现有循环回归全部通过。

---

## 阶段 3：🧩 tree-sitter 语义编辑提案（Week 7-10）

> 当前支持 TypeScript、JavaScript、TSX、Python、Go、Rust、Java；更多语言按真实项目收益继续扩展。

### 解析与索引
- [x] 在 `worldbase-coding` 中引入 tree-sitter 与 TS/JS/TSX/Python/Go/Rust/Java grammar。
- [x] 解析文件并记录语法错误节点。
- [x] 实现按节点 kind + name 的唯一匹配。
- [x] 建立声明符号索引：模块、类型、函数、方法、导入、导出（引用索引尚未实现）。
- [x] 记录符号的字节范围、行号范围和父节点路径。
- [ ] 缓存解析结果，并用文件哈希或修改时间校验。
- [ ] 大文件设置解析上限，避免阻塞主循环。

### 语义定位
- [x] 实现按符号路径定位。
- [x] 实现按父节点和名称定位。
- [ ] 实现修改目标与候选节点的匹配评分。
- [x] 多个候选冲突时返回歧义错误，不自动选择。
- [ ] 记录定位证据：文件、范围、符号路径和置信度。

### 编辑计划
- [x] 定义 `semantic_replace`、`insert_after`、`delete_symbol`、`rename_symbol`。
- [ ] 先生成 `EditPlan`，再转换为现有文本 patch。
- [x] 保留缩进、换行、注释和未修改区域。
- [ ] 拒绝跨越不安全语法边界的编辑。
- [x] 写入前检查文件是否在读取后发生变化。
- [ ] 写入失败时保证原文件不变（当前非原子写入）。

### 测试
- [x] 为每种编辑策略建立正例和反例。
- [x] 测试语法错误文件和多候选场景（超大文件尚未覆盖）。
- [x] 测试格式保留与 diff 最小性。
- [ ] 与纯文本 patch 做成功率、耗时和无关改动对比。
- [ ] 覆盖至少一个真实项目的端到端修改。

### 阶段 3 验收
- [ ] 语义定位可解释、可拒绝、可测试。
- [ ] 所有写入仍经过现有文件工具和权限层。
- [ ] 无关改动率相对基线显著下降。
- [ ] 无法解析时安全退化到普通文本工具，并明确提示原因。

---

## 阶段 4：🧩 Error Analyzer 提案（Week 11-13）

### 诊断规范化
- [x] 解析构建、测试、lint 和类型检查输出。
- [x] 提取文件、行、列、错误码、消息、严重级别和原始片段。
- [x] 合并重复诊断。
- [x] 保留原始日志引用，便于审计。
- [x] 对无法解析的输出保留原文并标记低置信度。

### 规则库
- [x] 收集 TOP 20 常见前端项目错误模式（当前 28 个），再扩展 Rust/Python/Go。
- [x] 为模式定义匹配条件、解释和修复模板。
- [x] 每条建议附带置信度和证据。
- [x] 低置信度建议只展示，不自动应用。
- [ ] 为规则库建立版本和回归用例。

### 依赖诊断
- [x] 解析 package.json 的 dependencies/devDependencies/peerDependencies/optionalDependencies。
- [x] 识别 packageManager 字段与 pnpm/npm/yarn/bun lockfile。
- [x] 从包管理器输出识别缺失包、缺失 @types、peer 依赖、版本冲突和 lockfile 过期。
- [x] 生成安装、更新、重建 lockfile 的命令建议。
- [x] 受控执行依赖修复命令（`coding_fix_dependencies`，默认 dry-run，`confirm=true` 才执行；仅允许 add/install）。
- [ ] 失败回滚与包管理器状态快照（当前命令失败即停止，不回滚已执行命令）。

### 修复建议
- [ ] 将建议转换为 `EditPlan` 或明确的人工步骤（当前输出 `RepairPlan` 文本建议）。
- [x] 修复前评估影响范围（`targeted_files`）；验证命令由 `coding_verify` profile 决定。
- [x] 修复后交给 `coding_loop` 的 Verify 状态。
- [ ] 记录建议是否被采纳、是否通过验证。
- [ ] 失败建议进入负例库，避免重复误判。

### 测试
- [ ] 用真实失败日志构建解析测试集。
- [ ] 测量诊断解析率、分类准确率和修复成功率。
- [ ] 测试多错误、级联错误和截断日志。
- [ ] 测试不含路径或行号的日志。
- [ ] 测试超大日志的截断与摘要。

### 阶段 4 验收
- [ ] 结构化诊断覆盖真实项目的主要失败类型。
- [ ] 自动修复只作用于高置信度、可验证的问题。
- [ ] 所有修复都经过后续验证。
- [ ] 诊断失败不会阻塞用户查看原始日志。

---

## 阶段 5：集成、并行与性能（Week 14-15）

### 模块集成
- [ ] 将 `coding_loop` 接入现有 Agent 循环的编码任务入口。
- [x] 将 tree-sitter 定位接入编辑计划生成（`coding_edit` / `coding_apply`）。
- [x] 将 Error Analyzer 接入验证失败流程。
- [x] 将 LSP 诊断作为可选输入接入 Error Analyzer（`coding_diagnose` + `analyze_lsp_diagnostics`）。
- [ ] 保持各模块可独立关闭。

### 并行调度
- [ ] 回归当前只读工具并行行为。
- [ ] 回归 `spawn_subagents` 并行行为。
- [x] 为写任务构建文件级依赖图并接入 `coding_apply` 执行层。
- [x] core 工具调度接入并行安全写批次：独立文件并行、同文件串行、结果恢复调用顺序。
- [x] 权限提示可能出现的写批次回退为串行；`coding_apply`、命令、删除和未知工具仍是串行屏障。
- [x] 未知/不可解析依赖不参与并行计划。
- [ ] 并行失败时停止依赖任务并保留已完成结果。
- [ ] 对并发上限、取消和超时做压力测试。

### 上下文与性能
- [ ] 测量压缩前后任务成功率和 token 消耗。
- [ ] 验证压缩保留当前错误、目标符号和验证结果。
- [ ] 测量语义索引缓存命中与内存占用。
- [ ] 测量最小验证集与完整门禁的耗时差异。
- [ ] 设定任务耗时、token 和内存预算。
- [ ] 回归长任务在 128 步分段边界的行为。

### 端到端测试
- [x] 100 个确定性离线任务基准（策略、语义编辑、诊断、依赖/LSP 数据解析；非真实模型 E2E）。
- [ ] 简单任务：新增函数并通过验证。
- [ ] 中等任务：修复编译错误并通过测试。
- [ ] 复杂任务：跨文件重构并通过质量门禁。
- [ ] 失败任务：不可恢复错误能明确停止。
- [ ] 取消任务：资源被释放，无悬挂子任务。
- [ ] 并行任务：只读侦察和子智能体结果正确汇总。

### 阶段 5 验收
- [ ] 编码闭环端到端可运行。
- [ ] 现有能力和提案能力均可独立观测。
- [ ] 无 P0 级回归。
- [ ] 性能、上下文和并行指标达到评审阈值。

---

## 阶段 6：跨端、FFI 与发布（Week 16）

### Rust 后端
- [ ] Desktop 与 CLI 使用同一 Rust Harness 路径。
- [ ] 所有新增能力通过现有协议暴露。
- [ ] 错误码、取消和进度事件语义一致。
- [ ] 特性开关可通过配置控制。

### Mobile FFI
- [ ] Dart 侧使用手写 `dart:ffi` 绑定。
- [ ] C ABI 保持向后兼容。
- [ ] Rust `extern "C"` 入口不跨边界泄漏 Rust 类型。
- [ ] Panic 被捕获并转换为错误码。
- [ ] 字符串、缓冲区和内存所有权明确。
- [ ] iOS 静态链接与 macOS/Android 动态库分别冒烟测试。
- [ ] 移动端端到端任务可完成并正确释放资源。

### UI 与反馈
- [x] 展示编码阶段：计划、侦察、编辑、验证、诊断、修复。
- [x] 展示修复轮次、当前验证命令和停止原因。
- [x] 展示结构化诊断和原始日志入口。
- [x] 提供查看 diff 的操作；取消和重试待后续接入。
- [ ] 低置信度建议明确标记为“建议”。

### 发布准备
- [ ] 版本号和特性开关默认值确定。
- [ ] Release Notes 区分 ✅ 改进与 🧩 实验能力。
- [ ] 基准报告与回滚方案完成。
- [ ] 内部 Alpha 用户测试完成。
- [ ] 关键 P0/P1 问题清零。

### 阶段 6 验收
- [ ] Desktop、CLI、Mobile 冒烟测试通过。
- [ ] FFI ABI 与资源释放检查通过。
- [ ] 文档、基准和回滚方案齐全。
- [ ] Alpha 评审通过。

---

## 最终质量门禁

```bash
pnpm coding:check
# 等价于 scripts/verify-coding.sh，依次执行：
# cargo test --manifest-path harness-rs/Cargo.toml -p worldbase-coding
# cargo test --manifest-path harness-rs/Cargo.toml -p worldbase-core
# cargo test --manifest-path harness-rs/Cargo.toml -p worldbase-tools
# cargo clippy --manifest-path harness-rs/Cargo.toml -p worldbase-coding --all-targets --no-deps -- -D warnings
# pnpm --dir apps/electron typecheck
# pnpm --dir apps/electron test:rust-harness-host-callbacks
# pnpm --dir apps/electron test:message-render-blocks
# pnpm --dir apps/electron test:message-segments
# pnpm --dir apps/electron test:renderer-navigation
```

常规检查还可单独运行 `cargo fmt --manifest-path harness-rs/Cargo.toml --all -- --check`。

- [ ] 所有命令通过，或对无法运行的平台测试有明确豁免记录。
- [ ] 128 步循环、上下文压缩、只读并行、子智能体回归通过。
- [x] 完整 `coding_loop` 编排仍标记为提案；tree-sitter、Error Analyzer、LSP 客户端/工具、并行写调度、依赖修复工具和 100 任务基准标记为 MVP。
- [ ] 未引入第二语言后端或并行运行时。
- [ ] 移动端仍使用手写 `dart:ffi`。
