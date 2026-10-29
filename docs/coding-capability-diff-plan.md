# 代码对比功能实现规划（code diff capability）

**版本**: 1.0  
**日期**: 2026-10-23  
**范围**: 代码对比与 diff 生成能力完整实现  
**目标**: 使 Agent 和用户能清晰看到编辑前后的代码变化，支持结构化 diff、上下文、冲突检测

---

## 执行摘要

当前实现状态：
- ✅ **内核数据已就位**：`SemanticEdit` 结构体含 `original_snippet` + `replacement`
- ✅ **工具层已返回**：`coding_edit` 工具响应包含 `before`、`after`、`preview`、`byteRange`
- ❌ **展示层未激活**：Agent 看不到、用户看不到结构化 diff
- ❌ **对比分析缺失**：无 unified diff、split diff、syntax highlight
- ❌ **冲突检测缺失**：多文件编辑时无跨文件冲突预警

核心缺口：**代码对比数据存在于 Rust 后端，但未被展示层、Agent 推理和用户界面所消费。**

---

## 一、当前实现的数据流

### 1.1 编码链路（已实现）

```
Request (coding_edit)
  ↓
parse_file() → tree-sitter 解析
  ↓
build_proposal() → SemanticEdit {
    file_path,
    byte_range,
    original_snippet,  ← 修改前
    replacement,       ← 修改后
    edited_source      ← 整个文件修改后
  }
  ↓
write to disk
  ↓
Response JSON {
    operation, filePath, byteRange,
    bytesWritten, preview,
    before,        ← original_snippet
    after,         ← replacement
    changed: true
}
```

### 1.2 现有响应格式

```json
{
  "changed": true,
  "operation": "replace",
  "filePath": "src/utils.ts",
  "byteRange": {
    "start": 1024,
    "end": 1248
  },
  "bytesWritten": 8192,
  "preview": "function getValue() {\n  return process.env.API_KEY;\n}\n…",
  "before": "function getValue() {\n  return process.env.secret;\n}",
  "after": "function getValue() {\n  return process.env.API_KEY;\n}",
  "changed": true
}
```

**问题**：`before` 和 `after` 是纯文本，没有：
- 行号映射
- 语法高亮信息
- Unified Diff 格式
- 上下文行（context lines）
- 差异统计（+5 行 -3 行）

---

## 二、代码对比功能的 7 层缺口

### 缺口 1：统一 Diff 生成（基础）

**现象**：工具返回 `before` / `after` 但无法对齐、定位差异

**需求**：
- 生成 unified diff（`@@` 标记，context lines）
- 生成 split diff（左侧原文、右侧修改）
- 计算 diff 统计（+行数、-行数、变化行数）

**工作项**：
```rust
// worldbase_coding 新增模块
pub mod diff {
    pub struct DiffLine {
        pub kind: DiffLineKind,    // Added / Removed / Unchanged / Context
        pub line_number_before: Option<usize>,
        pub line_number_after: Option<usize>,
        pub content: String,
    }
    
    pub enum DiffLineKind {
        Added,      // 新增行 (++)
        Removed,    // 删除行 (--)
        Unchanged,  // 不变行（context）
        Context,    // 上下文行
    }
    
    pub struct DiffBlock {
        pub before_start: usize,
        pub before_count: usize,
        pub after_start: usize,
        pub after_count: usize,
        pub lines: Vec<DiffLine>,
    }
    
    pub fn unified_diff(before: &str, after: &str, context_lines: usize) 
        -> Vec<DiffBlock>;
    
    pub fn diff_stats(blocks: &[DiffBlock]) -> DiffStats {
        pub additions: usize,      // + 行数
        pub deletions: usize,      // - 行数
        pub unchanged: usize,      // 不变行数
        pub total_lines: usize,
    }
}
```

**估算**：2-3 天（引入 `similar` crate 或手写 Myers diff 算法）

---

### 缺口 2：Syntax-aware Diff（语义增强）

**现象**：diff 无法识别语言特性，e.g. 括号移动、缩进变化

**需求**：
- 为 diff 行附加语言类型、AST 节点类型
- 识别"纯格式变化"vs"逻辑变化"
- 生成语言特定的 diff 输出（Python 缩进、Rust 花括号等）

**工作项**：
```rust
pub struct LanguageAwareDiffLine {
    pub base: DiffLine,
    pub language: LanguageId,
    pub node_kind: Option<String>,  // tree-sitter 节点类型
    pub is_formatting_only: bool,   // 仅格式变化？
    pub syntax_highlight: Vec<Token>,  // [{ kind: Keyword, range: 0..6 }, ...]
}
```

**估算**：3-4 天（复用 tree-sitter 已有解析）

---

### 缺口 3：Diff API 与工具响应扩展

**现象**：当前工具只返回 `before` / `after`，未提供结构化 diff

**需求**：
- `coding_edit` 扩展返回 `diff` 字段
- 支持 `unified_diff` / `split_diff` / `raw` 三种格式选择
- 返回差异统计和行号映射

**工作项**：
```rust
// harness-rs/crates/tools/src/coding_edit.rs 扩展

// 请求参数新增（可选）
{
  "diffFormat": "unified" | "split" | "raw",  // 默认 "raw"
  "contextLines": 3                           // 默认 3
}

// 响应扩展
{
  "changed": true,
  "operation": "replace",
  "filePath": "src/utils.ts",
  // ... 现有字段 ...
  
  // 新增字段
  "diff": {
    "format": "unified",
    "blocks": [
      {
        "beforeStart": 5,
        "beforeCount": 3,
        "afterStart": 5,
        "afterCount": 4,
        "lines": [
          { "kind": "context", "lineNumberBefore": 4, "lineNumberAfter": 4, "content": "function getValue() {" },
          { "kind": "removed", "lineNumberBefore": 5, "lineNumberAfter": null, "content": "  return secret;" },
          { "kind": "added", "lineNumberBefore": null, "lineNumberAfter": 5, "content": "  return process.env.API_KEY;" },
          { "kind": "context", "lineNumberBefore": 6, "lineNumberAfter": 6, "content": "}" }
        ]
      }
    ],
    "stats": {
      "additions": 1,
      "deletions": 1,
      "unchanged": 2,
      "totalLines": 5
    }
  }
}
```

**估算**：2-3 天（调用缺口 1 的 diff 函数，扩展 JSON 响应）

---

### 缺口 4：Agent 推理层的 Diff 消费

**现象**：Agent 收到 diff 数据后不知道该如何理解和决策

**需求**：
- Agent 能读取 diff，理解"修改了什么"
- 在验证失败时，对比预期 diff 和实际 diff
- 在写冲突时，检测多个编辑的冲突区间

**工作项**：
```rust
// worldbase_coding 新增模块：coding/src/diff_analyzer.rs

pub struct DiffAnalysis {
    pub affected_symbols: Vec<String>,      // ["getValue", "SECRET_KEY", ...]
    pub change_severity: Severity,          // Cosmetic / Minor / Major
    pub cross_file_impact: Vec<String>,     // ["src/config.ts", ...] (通过语义索引推测)
    pub potential_breaks: Vec<String>,      // ["callers of getValue", ...]
}

pub fn analyze_diff_impact(
    before_edit: &SemanticEdit,
    language: LanguageId,
    project_context: &ProjectIndex
) -> Result<DiffAnalysis>;

pub enum Severity {
    Cosmetic,  // 注释、格式
    Minor,     // 单个函数内部改动
    Major,     // 签名、公开 API 改动
}
```

**估算**：3-4 天（复用 `ProjectIndex` 和符号表）

---

### 缺口 5：写冲突检测（多文件编辑）

**现象**：多文件并行编辑时，无法检测是否有冲突

**需求**：
- 在并行写入前检测冲突（同一行？同一符号？）
- 返回冲突报告和合并建议
- 支持冲突解决（merge strategies）

**工作项**：
```rust
pub struct WriteConflict {
    pub file: PathBuf,
    pub conflict_type: ConflictType,
    pub edits: Vec<SemanticEdit>,
    pub resolution: Option<ResolutionStrategy>,
}

pub enum ConflictType {
    SameLineModified,           // 两个编辑改同一行
    SameSymbolModified,         // 两个编辑改同一符号
    DependencyOrderUnclear,     // 编辑顺序不确定
}

pub fn detect_conflicts(edits: &[SemanticEdit], project: &ProjectIndex) 
    -> Result<Vec<WriteConflict>>;
```

**估算**：4-5 天（需要符号依赖图）

---

### 缺口 6：UI 展示层（Desktop / Web）

**现象**：即使 diff 数据完善，用户看不到

**需求**：
- Desktop：编辑器中并排显示原文 / 修改后
- Web 文档：unified diff 视图，红/绿 highlight
- 行号、列号对齐，支持点击跳转

**工作项**：
```typescript
// 假设前端组件
<CodeDiff
  before={proposal.before}
  after={proposal.replacement}
  language="typescript"
  diffFormat="split"
  contextLines={3}
  onLineClick={(line, kind) => {/* 跳转 */}}
/>
```

**估算**：3-5 天（基于现有编辑器集成）

---

### 缺口 7：Diff 历史与对标（可选增强）

**现象**：单个编辑的 diff 看得到，但跨多轮编辑的累积变化看不到

**需求**：
- 记录任务中所有 `coding_edit` 的 diff
- 生成"任务前后"的总体 diff
- 计算编辑轮次、重复编辑率、无用编辑

**工作项**：
```rust
pub struct TaskDiffSummary {
    pub edits: Vec<(usize, SemanticEdit)>,  // (轮次, 编辑)
    pub cumulative_diff: Vec<DiffBlock>,    // 最终 diff
    pub stats: TaskDiffStats {
        total_edits: usize,
        rounds_to_success: usize,
        repeated_edit_rate: f32,  // 同文件编辑次数 / 总编辑数
        unchanged_edits: usize,   // 被后续编辑覆盖的
    },
}
```

**估算**：2-3 天（汇总工作，不需新增能力）

---

## 三、实施路线图

### Phase 1：基础 Diff 生成（Week 1）

```
缺口 1 → 缺口 2 → 缺口 3
统一 diff → 语义 diff → API 扩展
  2d        3d        3d
```

**交付**：
- `worldbase_coding::diff` 模块可用
- `coding_edit` 工具支持 `diffFormat` 参数
- 内部测试通过（对比工具与参考实现）

---

### Phase 2：Agent 推理与冲突检测（Week 2）

```
缺口 4 → 缺口 5
Diff 分析 → 冲突检测
  3d        4d
```

**交付**：
- Agent 能从 diff 理解编辑影响
- 并行编辑冲突检测可用
- 编码循环中集成冲突报告

---

### Phase 3：UI 与历史（Week 3）

```
缺口 6 → 缺口 7
展示层   历史汇总
  4d      2d
```

**交付**：
- Desktop 可视化 diff
- 任务级 diff 汇总
- 对标数据（编辑轮次、重复率）

---

## 四、优先级与范围

| 缺口 | 优先级 | 工作量 | 直接价值 | 依赖 |
|------|--------|--------|----------|------|
| 1. 统一 Diff | P0 | 2-3d | 基础功能 | 无 |
| 2. 语义 Diff | P0 | 3-4d | 编码质量 | 缺口 1 |
| 3. API 扩展 | P0 | 2-3d | 工具链就位 | 缺口 1-2 |
| 4. Diff 分析 | P1 | 3-4d | 编码循环增强 | 缺口 1-3 |
| 5. 冲突检测 | P1 | 4-5d | 并行安全 | 缺口 4 |
| 6. UI 展示 | P1 | 3-5d | 用户体验 | 缺口 3 |
| 7. 历史汇总 | P2 | 2-3d | 对标分析 | 缺口 3 |

**建议立即启动**：缺口 1-3（P0，5-10 天，打通整条链路）

---

## 五、验收标准（P0）

### 缺口 1-3 验收

- ✅ `unified_diff` 函数可对标 GNU `diff -u` 输出
- ✅ 每个 `coding_edit` 响应包含 `diff.blocks` 和 `diff.stats`
- ✅ 对 100+ 语言和编辑类型做回归测试
- ✅ diff 数据量 < 原文本 20%（压缩率检查）
- ✅ 生成 diff 时间 < 50ms（性能基线）

### 缺口 4-5 验收（P1）

- ✅ Agent 能从 diff 推测"我改了什么"准确率 ≥90%
- ✅ 多文件冲突检测覆盖率 ≥95%，误报率 ≤5%
- ✅ 冲突发现时间点在"写入前"

### 缺口 6 验收（P1）

- ✅ Desktop diff 视图响应 < 200ms
- ✅ 用户点击行号能跳转到编辑器

---

## 六、实施检查清单

- [ ] Week 1 Day 1：Pull `similar` crate，实现 `unified_diff` 函数
- [ ] Week 1 Day 1：编写 100+ 单元测试（各语言、编辑类型）
- [ ] Week 1 Day 2：集成 tree-sitter，标注 AST 节点到 diff 行
- [ ] Week 1 Day 3：扩展 `coding_edit` 工具响应，集成测试
- [ ] Week 1 Day 4：性能优化（缓存、流式处理）
- [ ] Week 2 Day 1-2：实现 `DiffAnalysis` 和符号追踪
- [ ] Week 2 Day 3-5：实现冲突检测
- [ ] Week 3 Day 1-4：UI 展示（Desktop 并排视图）
- [ ] Week 3 Day 5：历史汇总和对标报告
- [ ] Week 4：集成测试、文档、代码审查

---

## 七、已知约束与兼容性

- ✅ **Rust-only 后端**：所有 diff 生成在 Rust 中完成
- ✅ **跨端一致**：Desktop、CLI、Mobile 用同一套 diff 模块
- ✅ **增量集成**：可在 `coding_loop` 和 `verify` 阶段按需调用
- ✅ **不破坏现有 API**：`diffFormat` 参数可选，默认不返回
- ⚠️ **性能基线**：大文件（>100KB）diff 可能超时，需流式处理
- ⚠️ **冲突定义**：跨文件冲突需语义索引，暂时保守（同行冲突）

---

## 八、后续迭代（Phase 4+）

### Phase 4：高级 Diff 特性
- 3-way diff（三向合并）
- 渐进式 diff 生成（流式响应）
- Diff 缓存与增量计算
- 支持 `git diff` 格式输出

### Phase 5：Diff 驱动的工具
- "仅显示 diff 影响的符号"索引
- "一键回滚到任意编辑前"功能
- "预测下一步编辑"基于 diff 历史

---

## 九、结论

**现状**：代码对比数据已在 Rust 后端完整生成（`SemanticEdit`），但未被展示、分析和消费。

**建议**：按 P0（缺口 1-3）→ P1（缺口 4-6）→ P2（缺口 7）的顺序，用 10-15 天完成整条链路，使 Agent 和用户都能清晰看到编码的每一步变化。

**关键成功因素**：
1. Diff 生成与参考实现对标（不重新造轮子）
2. Agent 推理层整合 diff 分析
3. 用户界面实时展示编辑对比

---

**文档作者**：WorldBase 编码能力团队  
**下一步**：Week 1 启动缺口 1-3 实施，提交初版代码审查
