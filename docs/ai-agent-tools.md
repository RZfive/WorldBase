# The World — AI Agent 工具文档

## 概述

主 AI 作为 Agent 运行，通过 LLM 的 function calling 能力调用一组工具来操作子项目。每个工具是一个独立的模块，注册到 Agent 系统中。工具执行受多层权限引擎控制，大输出通过 ToolResultStorage 自动处理。

---

## 工具列表

### 1. `read_project_file` — 读取项目文件

读取指定项目的文件内容，用于 AI 理解代码结构。大文件支持按行分段读取。

| 参数 | 类型 | 说明 |
|------|------|------|
| `project_id` | string | 项目 ID |
| `file_path` | string | 相对于项目根目录的路径 |
| `start_line` | integer? | 起始行号，从 1 开始 |
| `max_lines` | integer? | 最多读取的行数，默认 200，最大 400 |

**返回**: 包含 `content`、`total_lines`、`start_line`、`end_line`、`has_more`、`next_start_line` 等字段的对象。

---

### 2. `write_project_file` — 修改项目文件

修改指定项目的文件内容。自动创建 git commit。

| 参数 | 类型 | 说明 |
|------|------|------|
| `project_id` | string | 项目 ID |
| `file_path` | string | 相对路径 |
| `content` | string | 完整文件内容 |

---

### 3. `call_project_api` — 调用项目 API

调用指定项目正在运行的后端 HTTP API。

| 参数 | 类型 | 说明 |
|------|------|------|
| `project_id` | string | 项目 ID |
| `method` | string | HTTP 方法: GET/POST/PUT/DELETE |
| `path` | string | API 路径 (如 `/api/records`) |
| `body` | object? | 请求体 |

---

### 4. `query_project_database` — 查询项目数据库

对指定项目的数据库执行只读 SQL 查询。

| 参数 | 类型 | 说明 |
|------|------|------|
| `project_id` | string | 项目 ID |
| `sql` | string | SELECT 查询语句 |

**安全限制**: 仅允许 SELECT 语句。

---

### 5. `run_project_command` — 执行项目命令

在指定项目目录执行 shell 命令。

| 参数 | 类型 | 说明 |
|------|------|------|
| `project_id` | string | 项目 ID |
| `command` | string | shell 命令 |
| `cwd` | string? | 子目录 (默认项目根目录) |
| `timeout_seconds` | integer? | 超时时间 |

**安全限制**: 白名单命令 (npm, node, git 等)。

**返回补充**: 当命令因超时或输出截断被终止时，会返回 `reason`（如 `timeout` / `output_limit`）、`stdout`、`stderr`，并附带 `observedReadySignal` 帮助 Agent 判断服务是否已成功启动。

---

### 6. `start_project_server` — 后台启动项目服务

启动指定项目的后端服务，等待服务就绪后立即返回运行信息和最近启动日志。

| 参数 | 类型 | 说明 |
|------|------|------|
| `project_id` | string | 项目 ID |

**返回**: 包含 `status`、`port`、`pid`、`started_at`、`startup_logs`。

---

### 7. `list_projects` — 列出所有项目

返回所有已创建项目的列表及其运行状态。

无参数。

---

### 8. `analyze_project_data` — 分析项目数据

分析指定项目的数据，返回统计结果。

| 参数 | 类型 | 说明 |
|------|------|------|
| `project_id` | string | 项目 ID |
| `analysis_type` | string | summary / trend / distribution / comparison |
| `options` | object? | 分析选项 |

---

### 9. `create_project` — 创建新项目

根据 AI 生成的代码创建新项目。

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | string | 项目名称 |
| `type` | string | frontend / fullstack |
| `files` | object | 文件内容映射 `{path: content}` |
| `meta` | object | .world-meta.json 内容 |

---

### 10. `glob_search` — 文件模式搜索

按 glob 模式搜索项目中的文件，快速定位文件名或扩展名匹配的文件。

| 参数 | 类型 | 说明 |
|------|------|------|
| `project_id` | string | 项目 ID |
| `pattern` | string | Glob 模式 (如 `**/*.ts`, `src/**/index.*`, `*.{js,ts}`) |
| `dir_path` | string? | 搜索起始目录，默认项目根目录 |
| `max_results` | integer? | 最大结果数，默认 100，最大 500 |

**返回**: 包含 `matches` (文件路径、大小、类型数组)、`total_matches`、`truncated` 等字段。

**自动排除**: `node_modules/`, `.next/`, `.git/`, `dist/`, `build/`, `.cache/` 等。

---

### 11. `grep_search` — 代码内容搜索

在项目源代码中搜索文本或正则模式，返回匹配行及上下文。

| 参数 | 类型 | 说明 |
|------|------|------|
| `project_id` | string | 项目 ID |
| `pattern` | string | 搜索文本或正则表达式 |
| `dir_path` | string? | 搜索目录，默认项目根目录 |
| `include_pattern` | string? | 仅搜索匹配的文件 (如 `*.ts`) |
| `is_regexp` | boolean? | 是否为正则表达式，默认 false |
| `max_results` | integer? | 最大匹配行数，默认 50，最大 200 |
| `context_lines` | integer? | 匹配行前后的上下文行数，默认 2，最大 5 |

**返回**: 包含 `matches` (文件、行号、内容、上下文)、`files_searched`、`files_matched`、`truncated` 等字段。

**安全限制**: 自动跳过二进制文件和超过 2MB 的文件。

---

### 12. `fetch_webpage` — 获取公共网页内容

抓取一个或多个公共 `http(s)` 网页，并提取可读正文或 JSON 内容，用于读取外部文档、更新日志、API 说明等参考资料。

| 参数 | 类型 | 说明 |
|------|------|------|
| `urls` | string[] | 要抓取的公共网页 URL，单次最多 5 个 |
| `query` | string? | 可选，关注的主题或关键词，用于优先提取相关片段 |
| `max_chars` | integer? | 每个页面最多返回字符数，默认 12000，最大 40000 |
| `timeout_ms` | integer? | 单个请求超时时间，默认 10000ms，最大 30000ms |

**返回**: 包含每个 URL 的 `status`、`content_type`、`title`、`description`、提取后的 `content`、命中的 `query_snippets`、是否截断、以及错误信息。

**安全限制**: 仅允许公共 `http(s)` 地址；自动阻止 `localhost`、环回地址、私有网段和解析到内网 IP 的目标。

---

### 13. `web_search` — 搜索公开网页

按关键词搜索公开网页结果，返回标题、URL、摘要和来源域名。适用于“知道主题但不知道具体文档地址”的场景，也支持在同一次调用里自动继续抓取前 N 个搜索结果页面。当前会使用多搜索源（默认 `bing` + `duckduckgo`，技术类查询会额外补 `github` 仓库搜索），并按查询相关性重排结果。

| 参数 | 类型 | 说明 |
|------|------|------|
| `query` | string | 搜索关键词 |
| `limit` | integer? | 最大返回条数，默认 6，最大 10 |
| `sources` | string[]? | 可选搜索源，支持 `bing` / `duckduckgo` / `github` |
| `allowed_domains` | string[]? | 仅保留这些域名及其子域名的结果 |
| `blocked_domains` | string[]? | 排除这些域名及其子域名的结果 |
| `auto_fetch_top_n` | integer? | 自动继续抓取前 N 个搜索结果页面，最大 5 |
| `fetch_max_chars` | integer? | 启用自动抓取时，每个页面最多返回字符数，默认 12000，最大 40000 |
| `fetch_timeout_ms` | integer? | 启用自动抓取时，每个页面的超时时间，默认 10000ms，最大 30000ms |

**返回**: 包含 `query`、`engine`、`sources_used`、`results`、`fetched_at`。启用自动抓取时，还会返回 `auto_fetched_count` 与 `fetched_results`。每条搜索结果含 `rank`、`title`、`url`、`snippet`、`source`、`published_at`。

**质量增强**: 会自动扩展常见技术缩写（如 `MCP`）、根据查询语言设置搜索语言、合并多搜索源结果、过滤低相关度结果，并优先提升文档站、规范页、仓库 README 等结果。

**建议搭配**: 如果要快速做一轮外部资料收集，可直接对 `web_search` 传 `auto_fetch_top_n`；如果只想精确挑选页面，再单独调用 `fetch_webpage`。

---

## Agent 执行流程示例 (增强版)

```
用户: "给记账应用加一个按分类统计的接口"

Agent 执行:
1. list_projects()
   → 找到 proj_accounting

2. glob_search("proj_accounting", "**/*.{ts,js}")
   → 快速了解项目文件结构

3. grep_search("proj_accounting", "router\\.get|router\\.post", is_regexp=true, include_pattern="*.ts")
   → 定位所有现有路由定义

4. read_project_file("proj_accounting", "backend/routes/records.ts")
   → 理解现有路由结构

5. write_project_file("proj_accounting", "backend/routes/records.ts", newContent)
   → 添加 GET /api/records/stats 路由

6. run_project_command("proj_accounting", "node -c backend/routes/records.js")
   → 语法检查

7. call_project_api("proj_accounting", "GET", "/api/records/stats")
   → 验证新接口正常工作

8. 返回: "已添加分类统计接口 /api/records/stats"
```

---

## 权限系统

Agent 工具执行受 **PermissionEngine** 多层权限引擎控制:

| 层级 | 机制 | 说明 |
|------|------|------|
| 1. 安全工具白名单 | 自动放行 | `read_project_file`, `glob_search`, `grep_search`, `web_search`, `fetch_webpage` 等只读工具 |
| 2. 用户规则匹配 | allow/deny/ask | 用户可配置的工具+参数匹配规则 |
| 3. 命令安全分类 | 自动分析 | 对 `run_project_command` 等命令工具进行安全等级分类 |
| 4. 高危工具检查 | 强制确认 | `local_file_read`, `local_file_write`, `local_run_command` |
| 5. 默认规则 | 放行 | 项目范围内的工具默认允许 |

### 命令安全等级

| 等级 | 示例 | 处理 |
|------|------|------|
| 安全 | `ls`, `cat`, `npm list`, `git status` | 自动放行 |
| 需确认 | `npm install`, `git push`, `npm run build` | 弹窗确认 |
| 禁止 | `rm -rf`, `curl | sh`, `chmod 777` | 直接拒绝 |

---

## 工具结果处理

Agent 工具返回的结果通过 **ToolResultStorage** 智能处理:

| 结果大小 | 策略 | 说明 |
|---------|------|------|
| < 30 KB | 内联 | 直接添加到对话消息 |
| 30 KB ~ 100 KB | 截断 | 保留头+尾预览，标注截断信息 |
| > 100 KB | 持久化 | 写入临时文件，返回路径+摘要 |
