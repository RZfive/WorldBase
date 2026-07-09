# Agent 编码能力优化 · 文档集

把 WorldBase 内置编码 Agent（[src/main/ai-engine/](../../src/main/ai-engine/)）与官方 **Claude Code v2.1.88**（反编译源码）逐层对比，定位「同一个模型在 WorldBase 下编码能力更弱」的根因，并给出可落地的优化方案。

## 文档

1. [01-架构对比.md](01-架构对比.md) —— **事实基础**。两套系统的分层、主循环、模型层、工具系统、系统提示词、上下文管理、子 agent、权限逐项对比，末尾是按影响排序的差距总表。
2. [02-编码能力优化指南.md](02-编码能力优化指南.md) —— **行动方案**。根因诊断、优先级矩阵、工具改造（含可直接用的代码与 description）、系统提示词重构骨架、模型层/上下文优化、分阶段路线图、评测方法。

## 30 秒结论

骨架两边一致，WorldBase 工具覆盖也不窄。真正拉开编码能力的是三件「内功」：

1. **改文件用「行号补丁」而非「精确字符串匹配」**，且**读文件不返回行号** → 编辑频繁错位。（最大单点，先修这个）
2. **系统提示词没有「软件工程方法论」**，95% 在讲「怎么生成 Next.js 项目」 → 模型缺工作方法引导。
3. **模型层粗糙**：无 prompt caching、温度写死 0.7、token 用字符/4 估算。

> 优先级：先做优化指南「阶段一」（Read 带行号 + Edit 精确匹配 + 提示词补软件工程方法论 + 工具描述写全），经验上这一步就能把「明显不如」拉到「基本接近」。

## 对比基准

Claude Code v2.1.88 源码：`/Users/tanyafang/Downloads/claude-code-source-code-main`
- 系统提示词：`src/constants/prompts.ts`
- 工具描述：`src/tools/{FileEditTool,FileReadTool,BashTool,GrepTool,AgentTool,TodoWriteTool}/prompt.ts`
