# 🌍 WorldBase

AI 驱动的项目生成器与管理平台。通过自然语言对话创建完整的 Web 应用，并持续管理、修改和分析项目数据。

## 核心特性

- **AI 驱动的项目生成** — 通过对话创建完整的前端/全栈 Web 应用
- **代码直接修改** — 主 AI 可以读写子项目的任何文件，直接修改后端代码
- **API 调用与测试** — 主 AI 调用运行中子项目的 API，自动验证修改效果
- **数据分析** — 直接查询子项目数据库，进行统计分析和趋势分析
- **进程管理** — 自动管理子项目的启停和端口分配
- **局域网访问** — 通过 LAN Server 在局域网内访问所有项目

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面壳 | Electron |
| 前端 | Vue 3 + Vite |
| 主进程后端 | Node.js (Electron main process) |
| LAN 服务 | Express.js + http-proxy-middleware |
| 数据库 | better-sqlite3 |
| AI | OpenAI-compatible API (function calling) |

## 项目结构

```
the-world/
├── docs/                      # 架构文档
├── electron/                  # Electron 主进程入口
├── src/
│   ├── main/                  # 主进程业务逻辑
│   │   ├── project-fs/        # 项目文件系统访问层
│   │   ├── project-api-bridge/ # 子项目 API 桥接
│   │   ├── project-data-access/ # 统一数据访问层
│   │   ├── project-runtime/   # 项目运行时管理
│   │   ├── ai-engine/         # AI 引擎 + Agent 系统
│   │   └── lan-server/        # 局域网服务
│   └── renderer/              # 前端 UI (Vue 3)
├── package.json
└── vite.config.js
```

详细架构文档请查看 [`docs/`](./docs/) 目录。

重点方案文档：

- [`docs/custom-agent-memory-im-architecture.md`](./docs/custom-agent-memory-im-architecture.md) — 自定义 Agent、长期记忆、群协作与未来 IM 接入的整体升级方案

## 开发

```bash
# 安装依赖
pnpm install

# 启动开发服务器 (仅前端)
pnpm dev

# 启动 Electron 开发
pnpm electron:dev

# 构建应用
pnpm electron:build
```

当前打包流程会将 Electron 主进程编译为 V8 字节码 (`.jsc`) 并通过 loader 启动；preload 产物保留为压缩后的普通 JS，以避免安装包中的 `contextBridge`/IPC 桥接在字节码模式下失效。开发态 `pnpm electron:dev` 仍使用普通 JS 产物，便于调试。

> Windows 下如果生成/打包 Next.js standalone 应用时触发 symlink 权限错误，WorldBase 会在构建阶段自动拉起管理员授权。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `OPENAI_API_KEY` | OpenAI API 密钥 | - |
| `OPENAI_BASE_URL` | API 基础 URL | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | 模型名称 | `gpt-4o` |

## 许可证

MIT
