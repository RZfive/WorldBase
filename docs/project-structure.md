# WorldBase — 项目目录结构

```
the-world/
├── docs/                              # 📖 架构文档
│   ├── architecture.md                # 系统架构总览
│   ├── project-structure.md           # 本文件 - 目录结构说明
│   └── ai-agent-tools.md             # AI Agent 工具说明
│
├── electron/                          # ⚡ Electron 主进程入口
│   ├── main.js                        # Electron 主进程启动
│   └── preload.js                     # 预加载脚本 (IPC 桥接)
│
├── src/
│   ├── main/                          # 🖥️ 主进程业务逻辑
│   │   ├── project-fs/                # 项目文件系统访问层
│   │   │   ├── project-fs.js          # 核心文件系统操作
│   │   │   ├── project-analyzer.js    # 项目结构分析
│   │   │   └── safe-write.js          # 安全写入 (备份+回滚)
│   │   │
│   │   ├── project-api-bridge/        # 子项目 API 桥接
│   │   │   ├── api-registry.js        # API 注册表
│   │   │   ├── api-client.js          # HTTP 客户端
│   │   │   └── api-discovery.js       # API 自动发现
│   │   │
│   │   ├── project-data-access/       # 统一数据访问层
│   │   │   ├── data-access.js         # 统一入口
│   │   │   ├── adapters/              # 存储适配器
│   │   │   │   ├── sqlite-adapter.js  # SQLite 适配器
│   │   │   │   └── json-adapter.js    # JSON 文件适配器
│   │   │   ├── schema-registry.js     # 数据模式注册
│   │   │   └── data-analyzer.js       # 数据分析工具
│   │   │
│   │   ├── project-runtime/           # 项目运行时管理
│   │   │   ├── runtime-manager.js     # 进程生命周期管理
│   │   │   ├── port-manager.js        # 端口分配
│   │   │   └── process-monitor.js     # 进程健康监控
│   │   │
│   │   ├── ai-engine/                 # AI 引擎
│   │   │   ├── ai-engine.js           # AI 引擎入口
│   │   │   ├── providers/             # LLM 提供者
│   │   │   │   └── openai-provider.js # OpenAI 兼容 API
│   │   │   └── agent/                 # AI Agent 系统
│   │   │       ├── agent-core.js      # Agent 核心循环
│   │   │       ├── tool-result-storage.js # 大输出智能处理
│   │   │       ├── permissions/       # 权限引擎
│   │   │       │   └── permission-engine.js # 多层权限决策链
│   │   │       ├── tools/             # Agent 工具集
│   │   │       │   ├── index.js       # 工具注册入口
│   │   │       │   ├── tool-read-file.js
│   │   │       │   ├── tool-write-file.js
│   │   │       │   ├── tool-call-api.js
│   │   │       │   ├── tool-query-db.js
│   │   │       │   ├── tool-run-command.js
│   │   │       │   ├── tool-list-projects.js
│   │   │       │   ├── tool-analyze-data.js
│   │   │       │   ├── tool-create-project.js
│   │   │       │   ├── tool-glob-search.js  # 文件模式搜索
│   │   │       │   └── tool-grep-search.js  # 代码内容搜索
│   │   │       └── prompts/
│   │   │           └── system-prompt.js
│   │   │
│   │   └── lan-server/               # 局域网服务
│   │       ├── server.js              # Express 服务器
│   │       ├── routes/
│   │       │   ├── projects.js        # 项目管理 API
│   │       │   └── ai.js             # AI 对话 API
│   │       └── proxy.js              # 反向代理
│   │
│   ├── renderer/                      # 🎨 前端 (Vue 3)
│   │   ├── App.vue                    # 根组件
│   │   ├── main.js                    # 前端入口
│   │   ├── components/                # 通用组件
│   │   ├── views/                     # 页面视图
│   │   └── stores/                    # 状态管理
│   │
│   ├── assets/                        # 静态资源
│   └── style.css                      # 全局样式
│
├── index.html                         # Vite 入口 HTML
├── package.json                       # 依赖与脚本
├── vite.config.js                     # Vite 配置
└── electron-builder.json              # Electron 打包配置
```

## 运行时目录 (不在代码仓库中)

```
~/.the-world/                          # 用户数据目录 (运行时生成)
├── projects/                          # 所有子项目文件
│   ├── proj_accounting/               # 子项目: 记账应用
│   │   ├── .world-meta.json           # 项目元数据
│   │   ├── frontend/
│   │   ├── backend/
│   │   └── data/
│   └── proj_todo/
├── snapshots/                         # 项目快照 (用于回滚)
├── config.json                        # 主应用配置
└── app.sqlite                         # 主应用数据库
```
