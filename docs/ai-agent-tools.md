# The World — AI Agent 工具文档

## 概述

主 AI 作为 Agent 运行，通过 LLM 的 function calling 能力调用一组工具来操作子项目。每个工具是一个独立的模块，注册到 Agent 系统中。

---

## 工具列表

### 1. `read_project_file` — 读取项目文件

读取指定项目的文件内容，用于 AI 理解代码结构。

| 参数 | 类型 | 说明 |
|------|------|------|
| `project_id` | string | 项目 ID |
| `file_path` | string | 相对于项目根目录的路径 |

**返回**: 文件内容 (string)

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

**安全限制**: 白名单命令 (npm, node, git 等)。

---

### 6. `list_projects` — 列出所有项目

返回所有已创建项目的列表及其运行状态。

无参数。

---

### 7. `analyze_project_data` — 分析项目数据

分析指定项目的数据，返回统计结果。

| 参数 | 类型 | 说明 |
|------|------|------|
| `project_id` | string | 项目 ID |
| `analysis_type` | string | summary / trend / distribution / comparison |
| `options` | object? | 分析选项 |

---

### 8. `create_project` — 创建新项目

根据 AI 生成的代码创建新项目。

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | string | 项目名称 |
| `type` | string | frontend / fullstack |
| `files` | object | 文件内容映射 `{path: content}` |
| `meta` | object | .world-meta.json 内容 |

---

## Agent 执行流程示例

```
用户: "给记账应用加一个按分类统计的接口"

Agent 执行:
1. list_projects()
   → 找到 proj_accounting

2. read_project_file("proj_accounting", "backend/routes/records.js")
   → 理解现有路由结构

3. read_project_file("proj_accounting", "backend/models/Record.js")
   → 理解数据模型

4. write_project_file("proj_accounting", "backend/routes/records.js", newContent)
   → 添加 GET /api/records/stats 路由

5. run_project_command("proj_accounting", "node -c backend/routes/records.js")
   → 语法检查

6. call_project_api("proj_accounting", "GET", "/api/records/stats")
   → 验证新接口正常工作

7. 返回: "已添加分类统计接口 /api/records/stats"
```
