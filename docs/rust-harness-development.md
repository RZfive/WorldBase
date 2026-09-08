# Rust Harness 开发指南

本文档定义 WorldBase Agent Harness 的新增功能入口和提交门禁。自 2026-09-08 起，Rust 是默认且唯一持续开发的 Harness；Node/TypeScript Agent Loop 只保留显式旧配置兼容。Electron 的窗口、renderer、IPC 和平台服务仍正常维护，但它们是宿主层，不是第二套 Agent Loop。

## 1. 先判断功能归属

| 功能 | 权威实现 | Electron / Flutter 的职责 |
|---|---|---|
| provider、消息转换、流式解析、重试与用量 | `harness-rs/crates/providers` + `core` | 配置 UI、密钥输入、状态展示 |
| Agent Loop、上下文、tool-call、权限、Plan、取消、续传 | `harness-rs/crates/core` + `protocol` | 发送请求、渲染事件、回答权限/宿主请求 |
| 通用 Agent 工具、Memory、Skill、MCP、群组/子 Agent | 对应 Rust crate + `crates/tools` | 只实现确实依赖平台 API 的 adapter |
| 文档解析、结构化模型、基础编辑 | `harness-rs/crates/docs` + Rust artifact 层 | 高级预览、打开原文件、Office/UI 工作台 |
| 窗口、托盘、菜单、通知、文件选择、WebView、页面自动化 | Electron 或 Flutter 宿主 | 通过 host request / platform channel 接入 Rust |
| renderer 页面、交互和视觉状态 | Vue / Flutter | 不迁移到 Rust |
| 既有 68 项 Electron 工具 handler | Electron host adapter | 冻结契约兼容；Rust 通过 `tool.execute` 调用 |

禁止在 `apps/electron/src/main/ai-engine` 的 `AIEngine`、AgentCore 或 Node provider 中添加新的 Harness 能力。旧 TS 路径只修复会阻断显式旧配置的严重兼容问题。一个新能力如果既包含 Agent 逻辑又包含平台调用，应把策略、schema 和状态机放在 Rust，只把最窄的平台操作留给宿主。

## 2. 新增 Rust 工具

1. 在 `harness-rs/crates/tools/src/` 的对应领域实现 `Tool`，并在 `builtin_tools()` 注册。工具名一旦进入持久化消息或公开协议就视为稳定 API。
2. 给出完整、严格的 JSON Schema；在执行函数中仍要验证类型、边界和路径，不能把模型输入视为可信输入。
3. 明确 `domain()`、`permission()` 和副作用。修改文件、执行命令、外部写入等工具不能沿用无条件 `allow`。
4. 若工具应在 Electron 的 Rust Agent Loop 中直接执行，实现 `electron_native() -> true`。这会让工具通过 `initialize.availableTools` 进入 Electron，并阻止 Node placeholder、旧 handler 或同名 custom override 覆盖它。
5. 不要把新 Rust 原生工具加入 `electron-tool-contracts.json`。该文件及生成脚本中的 68 项断言是旧 Electron host catalog 的冻结兼容快照。
6. 移动端不会自动获得新工具。只有确认依赖和权限适合移动端后，才把名称加入 `mobile_tool_supported()` 的显式白名单，并补 iOS/Android capability 测试。

典型定义：

```rust
#[async_trait]
impl Tool for ExampleTool {
    fn name(&self) -> &str { "example" }
    fn description(&self) -> &str { "..." }
    fn input_schema(&self) -> Value { json!({ /* strict schema */ }) }
    fn permission(&self) -> &str { "ask" }
    fn electron_native(&self) -> bool { true }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        // Validate input, honor services.abort, then execute.
        Ok(json!({ "ok": true }))
    }
}
```

若工具需要 Electron API，Rust 工具仍可作为执行 owner，在 `execute` 中通过 `ToolServices`/`HostBridge` 发起窄化的 host request；Electron 只新增 callback adapter。不要为了访问一个平台 API，把整套工具策略和 schema 放回 Node Agent Loop。

### 工具必须同时检查

- **权限**：默认策略、参数敏感规则和宿主确认是否一致；`electronNative` 不是安全标记。
- **Plan 模式**：mutation 工具必须加入 Rust 的 Plan guard；若经过 Electron host，还要保持 Electron 侧防线一致。
- **取消**：长任务和 host request 必须监听 `ToolServices.abort`，停止后不能继续写入或再次启动进程。
- **能力过滤**：`domain`、握手 capabilities、移动白名单和 MCP allow-list 都要覆盖。
- **结果大小**：大文本/二进制走既有分页、artifact 或 tool-result storage，不直接塞入事件帧。
- **路径**：使用 workspace containment/canonicalization helper；禁止仅用字符串前缀判断路径。

## 3. 新增 provider

1. 在 `harness-rs/crates/providers/src/` 实现 `Provider`，把协议选择和配置入口接入 `entry.rs`。
2. 消息转换必须保留 tool call ID、tool result、图片块，以及 provider 私有的 thinking/signature 数据。
3. 流解析必须覆盖任意网络 chunk 边界、多个 choice/content block、usage、错误响应、取消和非 2xx 响应。
4. 在 `core` 使用 mock/capturing provider 补完整 Agent Loop 回归，不只测试请求 JSON。
5. Electron 只增加 provider 配置和模型展示字段，并通过现有设置同步给 Rust；不要实现新的 Node provider 执行路径。

## 4. 新增 RPC 或事件

RPC 的规范来源是 Rust：

1. 在 `harness-rs/crates/protocol/src/method.rs` 添加方法常量，在 `types.rs` 添加 serde DTO。线协议字段统一使用 `camelCase`，兼容 alias 只能显式声明。
2. 在 `harness-rs/crates/core/src/dispatcher.rs` 添加分发和参数校验，给错误选择稳定的 JSON-RPC code。
3. Electron stdio 与 mobile loopback 共用这套 dispatcher；分别更新必要的 TS/Dart adapter 和跨端测试。
4. 流式状态在 `protocol/src/event.rs` 定义 `EventKind`，由 core 发布。传输通知固定为 `method: "event"`，并保留单调 `seq`。
5. 可恢复事件必须验证 `chat.resume { streamId, afterSeq }`；取消必须验证 `chat.abort` 后不再产生副作用。

不要在 Electron IPC 中先发明一套与 Rust 不同的业务 DTO。UI 私有事件可以留在 Electron，但一旦跨 app-server/mobile-ffi，就先定义 Rust protocol。

## 5. 新增宿主或 UI 能力

纯展示功能直接在 Electron/Vue 或 Flutter 实现，不需要迁移。需要被 Agent 调用的平台能力采用以下顺序：

1. Rust 定义工具/RPC 的稳定输入、输出和策略。
2. Rust 发出最小 host request，避免把本机绝对路径、密钥或大块二进制暴露给 renderer。
3. Electron 在 host callback/registry 中实现窗口、文件选择、WebView、Office 或数据存储操作。
4. 为 callback 增加超时、取消、一次应答和进程退出测试。

既有 68 项工具继续在 Electron 修复平台语义，但不要借此扩展 Node Agent Loop。新增纯 Rust 工具使用 `electron_native()`；新增平台工具优先采用“Rust owner + host callback”，而不是扩大冻结快照。

## 6. 文档能力

- 解析器和基础 writer 放在 `harness-rs/crates/docs`，格式识别、Unicode、损坏文件、大小限制和 round-trip 都要有 fixture 测试。
- artifact 的内部模型可保存 canonical source path 和 render cache path，供 Rust 与可信 host callback 打开文件。
- `doc.import`、`doc.get`、`doc.list`、`doc.preview.ensure` 等公开 DTO 只能返回 workspace 相对路径；workspace 外部来源只返回 basename。
- 预览二进制通过 `doc.preview.read` 或 host payload 传输，并执行大小与 containment 检查；不能让公开 `assetPath` 变成任意文件读取入口。
- Electron 的高级预览、打开原文件、Office/PDF 复杂操作和工作台 UI 可以继续留在宿主层。

## 7. 测试与提交门禁

最小测试范围按改动选择：

| 改动 | 必须覆盖 |
|---|---|
| Tool/schema/ownership | tools 单元测试、Electron catalog/host callback 测试、Plan/permission/cancel |
| Provider/Agent Loop | provider parser/request 测试、core mock E2E、上下文与 tool continuation |
| Protocol/RPC/event | serde round-trip、dispatcher E2E、Electron 与 Flutter adapter |
| 文档 | docs fixture、artifact 内外路径、core RPC E2E、Flutter document FFI |
| Electron host adapter | typecheck、目标 Node test、进程退出/超时/权限路径 |

提交前主门禁：

```bash
pnpm harness:check
```

Pull request 和 `main` 分支上的同类改动还会由 `.github/workflows/harness.yml` 自动执行该门禁。

它依次运行：

```bash
cargo fmt --manifest-path harness-rs/Cargo.toml --all -- --check
cargo test --manifest-path harness-rs/Cargo.toml --workspace
pnpm electron:typecheck
pnpm electron:test
```

涉及 FFI、协议或文档时再运行较慢门禁：

```bash
pnpm test:flutter
pnpm harness:test:android-build
```

真机生命周期、后台恢复、系统权限或打包资源变化不能只用单元测试替代，必须记录对应平台验证结果。

## 8. 完成定义

一个 Harness 新功能只有在以下条件都满足时才算完成：Rust 是行为权威；Electron/Flutter 只含必要 adapter/UI；schema、权限、Plan、取消、能力和路径边界已定义；跨端 DTO 没有隐私路径或无界 payload；目标测试与 `pnpm harness:check` 通过；相关架构和使用文档已同步。
