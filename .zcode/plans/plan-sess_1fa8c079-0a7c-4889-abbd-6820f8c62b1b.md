# 背景

- `run_workspace_command`（Rust 共享引擎 `run_managed_command`）在 stdout 超 20k / stderr 超 10k 字符时**直接杀掉进程树**并报 failed（"Command output exceeded the capture limit and was terminated."）。老 TS 版的落盘机制（ToolResultStorage：超 100k 全文写入 tool-results 目录、模型拿到路径+预览）其实已移植到 Rust（`agent.rs` 的 `bound_tool_result`，30k/100k 阈值），但命令工具在 20k 就被杀，永远到不了那一层。
- 工具面只有一个严格白名单的 `run_workspace_command`，模型按普通 shell 习惯调用（`cd x && …`、管道）被大量拒绝 —— 即本次要解决的"大量报错"。

# 改动一：输出超限改为落盘，不再杀进程

共享引擎改动，`run_workspace_command` 和 `run_project_command` 同时受益。均在 `harness-rs/crates/tools/src/compat_tools.rs`：

1. **捕获侧**（`capture_command_output` 973-1003 / `update_command_output` 926-971）：超限时不再 `output_limit_notify` + `terminate_process_tree`，继续读到 EOF；内联缓冲仍截断在 20k/10k；从超限起把完整输出（含已缓冲前缀）追加写入落盘文件，目录复用 `Store::default_dir()/tool-results/`（agent 循环已有 24h 清理覆盖该目录），命名 `command-{command_id}.stdout.log` / `command-{command_id}.stderr.log`；落盘文件设 10MB 上限防失控，超限记 `outputFileTruncated`。
2. **结果侧**（`run_managed_command` 1226-1277 区域）：记录新增 `outputFile`（stdout/stderr 路径）与 `tail` / `stderrTail`（各留最后约 4k 字符，让模型直接看到结尾的报错）；按真实 exit code 定状态：exit 0 → completed + warning"输出超限已落盘到 <path>"，非 0 → failed "Command exited with code N; full output saved to <path>"；删除 1246/1250 的 "terminated" 分支。
3. **工具描述**（2397）同步更新：超限不终止、完整输出落盘、内联保留开头+结尾。
4. **测试**：重写 `output_limit_terminates_command_and_marks_failure`（2693-2714）为落盘断言（进程不被杀、exit code 保留、落盘文件内容完整、`outputTruncated: true`）。

# 改动二：新增普通 shell 工具 `run_shell_command`（工作区）

1. **compat_tools.rs** 新增 `WorkspaceShellCommandTool`（以 `WorkspaceCommandTool` 2390-2433 为模板）：
   - schema `{command (必填), cwd?, timeout_seconds?}`；`permission "ask"`、`electron_native true`、`domain desktop`。
   - 校验只保留 `is_dangerous_command` 破坏类 deny list + `MAX_COMMAND_CHARS` 长度上限；**允许** `&&` `|` `;` 重定向、换行、`$()`/反引号 —— 就是一个普通 shell（底层同为 `sh -c`）。
   - 复用 `run_managed_command`：command_id、超时后台化、`get_workspace_command_status` 轮询、改动一的落盘全部继承。
   - 权限策略（你未选择，采用推荐方案）：加入 `permissions.rs` 的 `is_command_tool`（161-166），走安全分类器 —— 只读安全命令自动放行、有风险弹确认卡、破坏类（rm -rf/sudo/mkfs 等）直接阻止，与现有命令工具一致。
2. **注册**（`harness-rs/crates/tools/src/lib.rs`）：`builtin_tools()`（~652）注册；`is_tool_allowed_in_plan_mode` deny list（~214）加入；不加入 mobile 白名单（桌面 only）。
3. **可见性**（`harness-rs/crates/core/src/agent.rs` 3763-3777）：加入 `is_folder_workspace_tool`，选中文件夹工作区时才可见，与 `run_workspace_command` 同进退。
4. **描述分工**：`run_shell_command` 描述写明"一般命令用本工具"；`run_workspace_command` 描述补充"链式/其他解释器请改用 run_shell_command"，从源头减少那类拒绝报错。
5. **Electron 侧**：`tool-run-summary.ts:82-85` 加名字（工具行显示命令摘要）；`ipc.ts` `buildFolderWorkspacePromptSection`（87-100）提示两工具分工；`windows.ts:541` 顺带。`electron-tool-contracts.json` 不动（Rust 原生工具无需条目），UI 其余组件自然降级，无需改。
6. **测试**：compat_tools 校验测试（链式命令通过、`rm -rf` 拒绝、`$()` 通过）；lib.rs 现有唯一名/`electron_native` 测试自动覆盖；`tool-run-summary.test.mjs` 加断言。

# 验证

- `cargo test`（harness-rs workspace，重点 tools/core 两个 crate）
- `pnpm --dir apps/electron test`（tool-run-summary 等相关文件）
- 手动起一个大输出命令验证落盘文件与结果字段。

注：git status 里的 .tmp_* / tmp/ 扫描脚本是之前排查用的，本次不碰。