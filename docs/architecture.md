# WorldBase — 系统架构文档

## 概述

**WorldBase** 是一个基于 Electron + Vue 3 的桌面应用，核心能力是通过 AI 对话生成完整的 Web 应用项目，并对这些生成的子项目进行持续管理、修改和数据分析。

### 核心理念

子项目不是"独立运行的小应用"，而是**主 AI 管理范围内的受控服务**。主 AI 既是它们的创造者，也是持续的管理者和分析者。

---

## 系统架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│                      WorldBase (Electron 主进程)                  │
│                                                                   │
│  ┌──── AI Agent (主 AI) ─────────────────────────────────────┐   │
│  │                                                            │   │
│  │  tools:                                                    │   │
│  │  ├── read_project_file ──────┐                             │   │
│  │  ├── write_project_file ─────┤                             │   │
│  │  ├── search_project_code ────┤── ProjectFS                 │   │
│  │  ├── run_project_command ────┘    (文件系统直接操作)         │   │
│  │  │                                     │                   │   │
│  │  ├── call_project_api ────── ProjectApiClient              │   │
│  │  │                              │ (HTTP 调用子项目API)      │   │
│  │  ├── query_project_database ─── ProjectDataAccess          │   │
│  │  │                              │ (直接读取数据库)          │   │
│  │  └── analyze_project_data ──── DataAnalyzer                │   │
│  │                                                            │   │
│  └────────────────────────────────────────────────────────────┘   │
│         │                    │                     │               │
│    文件读写              HTTP请求              SQLite直读          │
│         │                    │                     │               │
│  ┌──────▼────────────────────▼─────────────────────▼──────────┐   │
│  │                    子项目进程池                               │   │
│  │  proj_accounting/    proj_todo/     proj_notes/             │   │
│  │  ├── frontend/       ├── src/       ├── src/               │   │
│  │  ├── backend/        ├── backend/   └── dist/              │   │
│  │  └── data/           └── data/                              │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──── LAN Server (:19527) ─────────────────────────────────────┐  │
│  │  反向代理: /tool/proj_*/* → 子项目端口                        │  │
│  │  主 API:   /api/projects, /api/ai/chat                       │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面壳 | Electron |
| 前端 | Vue 3 + Vite |
| 主进程后端 | Node.js (Electron main process) |
| LAN 服务 | Express.js + http-proxy-middleware |
| 数据库 | SQLite（Electron `node:sqlite` + Rust bundled `rusqlite`） |
| AI | OpenAI-compatible API (function calling) |
| 进程管理 | Node.js child_process |

---

## 模块详细设计

### 1. ProjectFS — 项目文件系统访问层

**路径**: `apps/electron/src/main/project-fs/`

主 AI 通过此层读写子项目的任何文件，是实现"直接修改后端"的基础。

| 文件 | 职责 |
|------|------|
| `project-fs.js` | 核心文件系统操作 (read/write/list/delete) |
| `project-analyzer.js` | 分析项目结构和技术栈 |
| `safe-write.js` | 安全写入 (先备份再写，支持回滚) |

**核心接口**:

```javascript
class ProjectFS {
  readFile(projectId, relativePath)       // 读取项目中的任意文件
  writeFile(projectId, relativePath, content)  // 写入/覆盖文件
  deleteFile(projectId, relativePath)
  listDir(projectId, relativePath, recursive)  // 列出目录结构
  getFileTree(projectId)                  // 获取完整文件树
  searchInProject(projectId, pattern)     // 在项目中搜索代码
  createSnapshot(projectId)               // 修改前快照
  rollback(projectId, snapshotId)         // 回滚到快照
}
```

---

### 2. ProjectApiClient — 子项目 API 桥接

**路径**: `apps/electron/src/main/project-api-bridge/`

主 AI 调用运行中子项目的 HTTP API，用于测试、调试、获取运行时数据。

| 文件 | 职责 |
|------|------|
| `api-registry.js` | API 注册表 (元数据: 路由/参数/返回值) |
| `api-client.js` | 主进程调用子项目 API 的 HTTP 客户端 |
| `api-discovery.js` | 自动发现子项目暴露的 API |

**核心接口**:

```javascript
class ProjectApiClient {
  call(projectId, method, path, data)     // 通用调用
  get(projectId, path, params)            // GET 请求
  post(projectId, path, body)             // POST 请求
  put(projectId, path, body)
  delete(projectId, path)
}
```

---

### 3. ProjectDataAccess — 统一数据访问层

**路径**: `apps/electron/src/main/project-data-access/`

主应用通过此层统一访问子项目的数据，支持多种存储格式。

| 文件 | 职责 |
|------|------|
| `data-access.js` | 统一数据访问入口 |
| `adapters/sqlite-adapter.js` | 读取 SQLite 数据库 |
| `adapters/json-adapter.js` | 读取 JSON 文件数据 |
| `schema-registry.js` | 数据模式注册 |
| `data-analyzer.js` | 数据分析工具 (统计/聚合/趋势) |

**两种数据访问路径**:

| 路径 | 说明 | 适用场景 |
|------|------|---------|
| 通过宿主标准数据接口 | 生成项目 → WorldBase `/api/projects/:projectId/data/*` → SQLite | 应用运行时标准读写 |
| 直接访问 | 主 AI → DataAccess → 直接打开数据库文件 | AI 数据分析（只读） |

**生成项目的数据接口约定**:
- 生成项目不能自行管理 SQLite 驱动或自行建库
- 必须在 `.world-meta.json` 的 `dataSchema` 中声明 `database: "sqlite"`、`dbPath` 和 `tables`
- WorldBase 在创建项目时自动初始化 SQLite 表
- 运行中的项目通过环境变量获取接口地址：
  - `THE_WORLD_PROJECT_ID`
  - `THE_WORLD_LAN_BASE_URL`
  - `THE_WORLD_PROJECT_DATA_BASE_URL`
- 标准接口：
  - `POST /api/projects/:projectId/data/records/save`
  - `POST /api/projects/:projectId/data/records/query`
  - `GET /api/projects/:projectId/data/schema`
  - `GET /api/projects/:projectId/data/tables`

---

### 4. ProjectRuntime — 项目运行时管理

**路径**: `apps/electron/src/main/project-runtime/`

| 文件 | 职责 |
|------|------|
| `runtime-manager.js` | 进程生命周期管理 (启动/停止/重启) |
| `port-manager.js` | 端口分配与管理 |
| `process-monitor.js` | 进程健康监控 |

---

### 5. AI Engine — AI 引擎与 Agent 系统

**路径**: `apps/electron/src/main/ai-engine/`

主 AI 从"代码生成器"升级为"项目感知的全栈 Agent"。

| 文件/目录 | 职责 |
|-----------|------|
| `ai-engine.js` | AI 引擎入口，管理对话与 function calling |
| `providers/openai-provider.js` | OpenAI 兼容 API 提供者 |
| `agent/agent-core.js` | Agent 核心循环 (思考→行动→观察) |
| `agent/tools/` | Agent 可用的工具集 |
| `agent/prompts/` | Agent 系统 prompt |
| `agent/permissions/` | 多层权限决策引擎 |
| `agent/tool-result-storage.js` | 大输出智能处理 (截断/文件化) |

**Agent 工具集**:

| 工具 | 描述 |
|------|------|
| `read_project_file` | 读取指定项目的文件内容 |
| `write_project_file` | 修改指定项目的文件 |
| `call_project_api` | 调用指定项目的后端 API |
| `query_project_database` | 对指定项目的数据库执行只读 SQL |
| `run_project_command` | 在指定项目目录执行 shell 命令 |
| `list_projects` | 列出所有项目及状态 |
| `analyze_project_data` | 分析指定项目的数据 |
| `create_project` | 创建新项目 |
| `glob_search` | 按 glob 模式搜索项目文件 |
| `grep_search` | 在项目代码中搜索文本/正则模式 |

**权限引擎 (PermissionEngine)**:

5 层决策链保障工具执行安全:
1. 安全工具白名单 → 只读工具直接放行
2. 用户规则匹配 → 自定义 allow/deny/ask 规则
3. 命令安全分类 → 正则规则自动分析命令安全等级
4. 高危工具检查 → 本地系统操作强制用户确认
5. 默认放行 → 项目范围内工具默认允许

**工具结果存储 (ToolResultStorage)**:

按大小智能处理工具返回值: < 30KB 内联、30-100KB 截断预览、> 100KB 持久化到文件。

---

### 6. LAN Server — 局域网服务

**路径**: `apps/electron/src/main/lan-server/`

| 文件 | 职责 |
|------|------|
| `server.js` | Express 服务器入口 |
| `routes/` | API 路由 |
| `proxy.js` | 反向代理到子项目 |

---

## 数据分析能力层级

| 层级 | 示例 | 实现方式 |
|------|------|---------|
| 层级1: 单项目查询 | "记账应用最近一周的记录" | SQL 查询 |
| 层级2: 深度分析 | "分析消费趋势" | SQL + AI 推理 |
| 层级3: 跨项目关联 | "对比记账和 TODO 数据" | 多项目查询 + AI 分析 |
| 层级4: 全局洞察 | "所有应用使用情况汇总" | 遍历所有项目 + AI 报告 |

---

## 安全模型

### 权限引擎 (PermissionEngine)

工具执行由 `PermissionEngine` 多层决策链控制:

```
工具调用 → 安全白名单检查 → 用户规则匹配 → 命令安全分类 → 高危工具检查 → 默认放行
```

| 决策层 | 机制 | 覆盖工具 |
|--------|------|---------|
| 安全工具白名单 | 自动放行 | `read_project_file`, `list_projects`, `glob_search`, `grep_search`, `query_project_database` 等只读工具 |
| 用户规则匹配 | allow/deny/ask | 所有工具 (支持工具名+参数模式匹配) |
| 命令安全分类 | 正则规则分析 | `run_project_command`, `local_run_command` |
| 高危工具检查 | 强制用户确认 | `local_file_read`, `local_file_write`, `local_run_command` |
| 默认规则 | 放行 | 其余项目范围内工具 |

### 命令安全等级

| 等级 | 示例 | 处理 |
|------|------|------|
| 安全 (safe) | `cat`, `ls`, `npm list`, `git status`, `node -c` | 自动放行 |
| 需确认 (risky) | `npm install`, `git push`, `npm run build` | 弹窗确认 |
| 禁止 (deny) | `rm -rf`, `curl|sh`, `chmod 777` | 直接拒绝 |

### 传统安全边界

| 权限类别 | 允许 | 需确认 | 禁止 |
|---------|------|--------|------|
| 文件系统 | 项目内读写 | - | 项目外访问 |
| API 调用 | 子项目 API | - | 外部网络 (LLM除外) |
| 数据库 | SELECT | INSERT/UPDATE/DELETE | DROP 等破坏性操作 |
| 命令执行 | 安全命令 | 需确认命令 | 危险命令 |

---

## .world-meta.json 项目元数据格式

每个子项目根目录包含此文件，描述项目的运行时信息、API 和数据模式：

```json
{
  "id": "proj_accounting",
  "name": "记账应用",
  "type": "fullstack",
  "createdAt": "2026-03-30T06:00:00Z",
  "runtime": {
    "frontend": { "port": 3001, "command": "npm run dev" },
    "backend": {
      "port": 3002,
      "command": "node server.js",
      "apis": [
        {
          "method": "GET",
          "path": "/api/records",
          "description": "获取记录列表",
          "params": { "month": "string?" }
        }
      ]
    }
  },
  "dataSchema": {
    "database": "sqlite",
    "dbPath": "data/app.sqlite",
    "tables": [
      {
        "name": "records",
        "columns": [
          { "name": "id", "type": "INTEGER", "primaryKey": true },
          { "name": "amount", "type": "REAL" },
          { "name": "category", "type": "TEXT" }
        ]
      }
    ]
  }
}
```
