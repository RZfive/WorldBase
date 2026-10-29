# 网页能力路由设计：内置优先、外部 MCP 兜底（Web Capability Router）

> 状态：P0 与 P1 主体已实现（拦截信号 / 策略段 / 阅读模式 / 富卡片；稳定 ref、batch/find/wait_for、视口/整页 screenshot、diagnostics（console/错误/fetch/XHR/resource）、真实键盘/鼠标输入、navigate/reload/back/forward、viewport resize、emulate（media / color scheme / reduced motion / user agent / mobile viewport）、search_results 预设、`tab_id` 定向路由、`manage_workspace_tabs`、内置优先策略；`aiDriving` 操作角标除外）。运行时硬化（加载就绪、点击后导航等待、诊断跨导航隔离、调试器并发）仍在进行中，不计入已完成。P2（工具内自动降级、MCP 面板浏览器预设、evaluate 域白名单、`project_smoke_check`）待实施。仍必须交给 Chrome/Playwright MCP 的缺口：CDP 网络拦截、性能 trace、CI/多浏览器矩阵。
> 范围：harness-rs（web 工具与策略）、apps/electron（工作区浏览器、宿主工具、UI）
> 关联文档：`docs/rust-harness-architecture.md`、`HARNESS.md`、`docs/ai-agent-tools.md`

## 1. 背景与目标

当前 AI 联网检索是 Rust 侧纯静态抓取（`harness-rs/crates/tools/src/web.rs`：Bing RSS + DuckDuckGo HTML + GitHub API，固定 UA `WorldBase AI Agent/1.0`），不执行 JS、无会话、无反爬处理。目标站点一旦返回 403/429、验证码质询、JS 壳页或要求登录会话，检索直接失败。

与此同时，应用内部已有一套完整的内嵌浏览器与页面自动化基建，但没有与 web 检索工具打通：

- `<webview>` 工作区浏览器（`src/renderer/components/app/BrowserWebView.vue`，`partition="persist:the-world-browser"` 持久会话，可复用用户登录态）；
- 页面自动化协议（`src/shared/page-automation-types.ts` + IPC `pageAutomation:request/response`）；
- 宿主工具 `read_current_page` / `interact_current_page` / `fill_current_page_form` / `save_current_page_as_document` / `open_workspace_tab` / `open_project_app`。

于是出现"被拦截就死、内部能力闲置、外部 Chrome MCP 缺位"的问题。

### 目标

1. `web_search` / `web_fetch` 被拦截或抓不到内容时，AI **优先降级到基座自带的工作区浏览器**完成抓取，过程与结果对用户可见；
2. 内嵌浏览器为 AI 提供更快捷的网页操作与信息检索方法（阅读模式正文提取、搜索结果提取预设、批量动作、语义定位等）；
3. 内部应用（用户开发中的项目）的测试走查**复用同一套控制基建**；
4. 外部浏览器类 MCP（chrome-devtools-mcp、playwright-mcp 等）定位为 **L2 兜底**：仅在内置能力不足时使用，并天然经过 permission=ask 弹窗，从而减少对外部 MCP 的依赖与暴露面。

### 非目标（本期不做）

- 无头后台抓取集群、多浏览器并发池；
- CDP 级网络拦截 / 性能 trace（外部 playwright MCP 已覆盖该场景）；
- 在外部 MCP 之上再做一层封装或代理。

## 2. 现状盘点（设计依据）

### 2.1 已具备的能力

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 内嵌浏览器 | `src/renderer/components/app/BrowserWebView.vue` | `<webview>` + 持久 partition；地址栏/下载/弹窗 dock 化/右键菜单 |
| 页面自动化 | 同上 `captureAutomationSnapshot()` / `runAutomationAction()`；`src/shared/page-automation-types.ts` | 动作集：click/input/select/scroll/extract/evaluate/hover/focus/press_key/fill_form/wait |
| Tab 体系 | `src/renderer/components/workspace/tab-registry.ts`、`workspace-store.ts` | 5 种内置 tab（folder/document/browser/terminal/project）；`workspaceBrowserSurfaces` 持有组件句柄 |
| AI 页面工具 | `src/main/ai-host/agent/tools/tool-active-page.ts` | read/interact/fill/save 四个宿主工具，经 `services.ts` → `windows.ts requestPageAutomationFromRenderer()` → renderer 执行 |
| 打开页面 | `src/main/ai-host/agent/tools/tool-open-workspace-tab.ts`、`tool-open-project-app.ts` | kind: browser/project 等五种 |
| 上下文注入 | `electron/main-process/windows.ts buildActivePagePromptSection()` | 当前页 URL/标题注入提示词；已禁止对内嵌页使用 `fetch_webpage` |
| 富结果卡片 | `renderer/components/chat/panel/message-sender.ts` + `chat/blocks/WebSearchBlock.vue` / `WebFetchBlock.vue` | 消费 `web_search_result` / `web_fetch_result` 事件；**当前无发射方（Rust 未发），通道就绪** |
| 外部 MCP | harness-rs `McpManager`（stdio/http/sse）+ `mcp__<server>__<tool>__<hash>` 动态工具，permission=ask；Electron `src/main/mcp/mcp-service.ts` + MCPSettingsPanel | 每轮 `allowedMcpServerIds` 白名单；无浏览器 MCP 预设 |
| 内部应用 | `ActivePageAutomationContext.kind: 'project'`；项目生命周期 `project_dev_start/start_server/status/logs`；`open_project_app`（embed/window） | 内部应用与网页共用同一自动化抽象 |

### 2.2 缺口

1. Rust web 工具无拦截检测、无降级信号；
2. `read_current_page` 只有"活跃页"语义，只返回交互快照（interactiveElements），无阅读模式正文提取；
3. 动作无批量（batch）、语义定位（find）、等待文本、截图；快照 ref 不稳定（token 浪费）；
4. 搜索结果页无快捷提取预设；
5. `web_search_result` / `web_fetch_result` 富卡片无事件源；
6. 多个 browser tab 并存时，自动化请求按"活跃页"路由，存在落错页风险；
7. 无"AI 正在操作浏览器"的用户可见指示；
8. 策略层没有"内置优先、外部 MCP 兜底"的路由规则；MCP 面板无浏览器 MCP 预设。

## 3. 总体架构：三级能力阶梯 + 路由

```
            ┌────────────────────────────────────────────────────────┐
            │                网页能力路由（策略层）                      │
            │  提示词策略 + 工具描述 + 结构化降级信号（三处同一规则）        │
            └───────────────┬────────────────────────────────────────┘
                            │
   L0 静态通道               │ 拦截/内容不足              L1 内置浏览器通道
   harness-rs web.rs  ──────┼──────────────────────▶  工作区浏览器 webview
   web_search/web_fetch      │                          open_workspace_tab(browser)
   快·静默·SSRF防护           │                          read_current_page(mode=article)
                            │ ▼ 仍不足 / 缺能力              + interact(batch/find/…)
                            │                          用户全程可见·复用登录会话
                            │
                            │                L2 外部 MCP 通道
                            └────────────▶  mcp__chrome_devtools__* / mcp__playwright__*
                                            多标签·CDP·trace·CI；permission=ask
```

**路由原则（写进三处：系统提示词策略段、工具 description、web 工具返回的 `fallback` 字段）：**

1. 默认 L0（快、静默、零 UI）；
2. L0 明确被拦截或内容不足 → L1：`open_workspace_tab(kind=browser, url)` → `read_current_page(mode=article)`；需要交互时 `interact_current_page`。用户全程可见、可随时接管；
3. L1 尝试后仍不足，或需要 L1 不具备的能力（多标签编排、网络层拦截、trace、CI/e2e）→ L2（仅当用户已配置外部浏览器 MCP）；调用天然经过 permission=ask；
4. 全链路对用户透明：富结果卡片 + 浏览器 tab"AI 正在操作"角标。

### 内置浏览器 vs Chrome/Playwright MCP 决策表

| 场景 | 首选 | 说明 |
| --- | --- | --- |
| 公共网页静态抓取 | `web_search` / `web_fetch`（L0） | 快、静默、无 UI；不执行 JS、无登录态 |
| 被 403/429/验证码/JS 壳页拦截，或需要用户登录态 | 工作区浏览器 + `read_current_page(mode=article)`（L1） | 复用 `persist:the-world-browser` 会话，用户可见 |
| 页面导航、重载、前进/后退 | `interact_current_page` 的 navigate/reload/back/forward（L1） | 不再启动外部浏览器 |
| DOM 检查、点击/键盘、表单、异步脚本 | `read_current_page(mode=interactive)` + `interact_current_page` / `fill_current_page_form`（L1） | 稳定 `e1/e2/...` ref；`evaluate` 支持 async |
| 批量动作、等待条件、语义查找 | `interact_current_page` 的 batch/wait_for/find（L1） | 单次 IPC 往返，减少轮次 |
| 截图、视觉验收 | `read_current_page(mode=screenshot)`（L1） | 支持视口/整页、png/jpeg |
| console、运行时错误、网络、viewport | `read_current_page(mode=diagnostics)`（L1） | 项目页测试走查同样适用 |
| 页面仿真（深色/浅色、reduced motion、print media、移动端 viewport） | `interact_current_page(action="emulate")` + `read_current_page` screenshot/diagnostics（L1） | 支持 media/color_scheme/reduced_motion/user_agent/mobile/device_scale_factor；`reset=true` 还原 |
| 新建页面 / 多 tab 并存 | `open_workspace_tab(kind="browser")` 新建；`manage_workspace_tabs(action="list")` + `tab_id` 定位（L1） | 同一 URL 会复用已有 tab；页面工具按 `tab_id` 精确路由 |
| CDP 网络拦截、性能 trace、CI/多浏览器矩阵 | chrome-devtools-mcp / playwright-mcp（L2） | 仅在内置能力确实缺失且已配置时使用；permission=ask |

**截图与页面仿真（emulate）均由内置工具完成，不需要外部浏览器 MCP。** 外部 MCP 仅用于 CDP 网络拦截、性能 trace、CI/多浏览器矩阵等内置确实缺失的能力。

**一次典型降级检索的数据流：**

```
web_fetch(url) → { access:"blocked", reason:"captcha" }
  → 模型依策略: open_workspace_tab(kind=browser, url)
  → read_current_page(mode=article, query="…") → 正文 markdown
  → (可选) interact_current_page(batch=[click ref:e3, wait_for{text:"…"}])
  → (可选) save_current_page_as_document() 留档
```

## 4. 模块设计

### 4.1 拦截检测与降级信号（harness-rs `crates/tools/src/web.rs`）

在 `fetch_public_webpage()` 与三个搜索源的解析结果上增加统一判定 `classify_access()`：

| 信号 | 判定 |
| --- | --- |
| HTTP 403 / 429 / 503 | `http_blocked`（429 读取 Retry-After） |
| 响应头 `cf-mitigated`、`server: cloudflare` + 质询页；正文含 captcha / just a moment / access denied / datadome 特征 | `challenge` |
| 正文提取后 < 200 字符且 script 标签密度高（正文/HTML 比过低） | `js_shell` |
| 超时（现 10s 默认/30s 上限）、TLS 失败 | `timeout` / `network` |
| web_search 中 bing 与 ddg 源均失败（`source_errors` 全非空） | `search_sources_failed` |

产出：ToolResult JSON 增加字段（不破坏现有 `ok` / `content` 语义）：

```json
{
  "ok": false,
  "access": "blocked",
  "access_detail": { "reason": "challenge", "signals": ["http_403", "cf_challenge"] },
  "fallback": {
    "suggested_tools": ["open_workspace_tab", "read_current_page"],
    "hint": "静态抓取被拦截。请用 open_workspace_tab(kind=browser) 在工作区浏览器打开该 URL，再 read_current_page(mode=article) 提取正文。"
  }
}
```

P0 阶段不改控制流（失败仍是 `ok:false`），只补信号与 hint，由模型按策略显式降级；工具内自动降级见 §4.7（P2）。

### 4.2 策略注入（提示词层，单一来源）

- 新增"网页能力策略段"，内容包括：三级阶梯与优先级、降级触发条件（引用 §4.1 信号）、L2 使用条件、当前活跃页面上下文（并入现有 `buildActivePagePromptSection()`，`electron/main-process/windows.ts`）。
- **单一来源**：策略文本由 Electron 每轮经 `chat.send` 新增可选字段 `policy_sections.web` 下发给 Rust，拼进系统提示词；避免 Rust/TS 双份文本漂移。Rust 侧只在收到该字段时拼接，不内嵌副本。
- 动态列出已配置的浏览器类外部 MCP（`mcp_list_servers` 结果按名称/标签筛 chrome/playwright/browser），提示模型"L1 不足时可用这些 mcp__ 工具"。

### 4.3 工作区浏览器抓取管线（`BrowserWebView.vue` + `page-automation-types.ts`）

1. **阅读模式提取** `captureArticleSnapshot()`：注入 Readability 式打分提取，返回 `{ title, byline, publishedAt?, textMarkdown, wordCount, links[] }`；与现有 `captureAutomationSnapshot()` 并列，`defineExpose` 一并暴露。输出上限 24k 字符 + 可选 `query` 聚焦（复用 L0 `query_snippets` 的裁剪思路，在提取侧完成）。
2. **稳定 ref**：interactiveElements 分配 `e1/e2/…` 稳定编号，两次快照间增量保持；动作可写 `{ref:"e3"}` 简写，显著减少重复 selector 的 token 消耗。
3. **动作集扩展**（`page-automation-types.ts`）：
   - `batch { actions[] }`：单次 IPC 往返顺序执行，遇错即停，返回已完成部分 + 首个错误位；
   - `find { role|name|text }`：语义定位，内部映射到元素后再执行目标动作（减少 AI 数元素负担）；
   - `wait_for { text|selector, timeout }`；
   - `emulate { media | colorScheme | reducedMotion | userAgent | width/height/mobile/deviceScaleFactor | reset }`：内置页面仿真，覆盖 print/screen media、prefers-color-scheme、prefers-reduced-motion、user agent 与移动端 viewport，是 chrome-devtools-mcp `emulate` 的本地替代；
   - `screenshot {}`：`webview.capturePage()`，返回本地图片路径/缩略图（给 AI 视觉反馈 + 展示）。
4. **诊断环形缓冲**（为内部应用测试）：监听 webview `console-message` / `did-fail-load` / `render-process-gone`，并在页内捕获 error/unhandledrejection、fetch/XHR 与 resource timing，保留最近 120 条；`read_current_page(mode=diagnostics)` 返回 console/errors/network/viewport/history。
5. **AI 操作状态**：surface 增加 `aiDriving` 标志（`pageAutomation:request` 到达置位，response/timeout 复位），存入 `workspaceBrowserSurfaces`（`workspace-store.ts`）。

### 4.4 AI 工具面（`tool-active-page.ts` + 新增）

**增强现有四个工具：**

- `read_current_page`：新增 `mode: "interactive" | "article" | "search_results" | "screenshot" | "diagnostics"`（默认 interactive，兼容现状）与可选 `tab_id`；`search_results` 使用预设选择器提取 `{title,url,snippet}[]`（预设表放 `src/shared/search-extract-presets.ts`：bing `#b_results li`、ddg `.result`、google `div[g]` 等）；`screenshot` 返回视口/整页截图，`diagnostics` 返回 console/错误/网络/视口快照；
- `interact_current_page`：动作集同 §4.3（含 `navigate`/`reload`/`back`/`forward`/`resize`/`emulate`），支持 `tab_id`；`fill_current_page_form` / `save_current_page_as_document` 保持各自专用参数。

**新增工具（P1）：**

- `manage_workspace_tabs`：`action: list | activate | close`，从工作区 tab 注册表返回 `[{tab_id, kind, title, active}]`；AI 用 `action="list"` 发现 `tab_id`，再传给页面工具定向操作（取代原计划的 `list_page_tabs` / `focus_page_tab`）。

**路由修正：** `App.vue handlePageAutomationRequest()` 的 `getActiveBrowserAutomationHandle()` 增加按 payload 中 `tab_id` 精确路由；无 `tab_id` 时维持"活跃页"语义（向后兼容）。

工具注册同步更新：`tools/index.ts`、`electron-tool-registry.ts`、`harness-rs/crates/tools/electron-tool-contracts.json`（宿主工具 description/schema 快照）。

### 4.5 用户可见性

1. **富卡片接通（P0）**：Rust web 工具执行时下发 progress 事件，payload 复用 renderer 已消费的 `web_search_result` / `web_fetch_result` 结构（`rust-harness-engine.ts frameToStreamEvent` 已映射，`message-sender.ts` 无需改动）；`web_fetch_result` 增透传 `access` 字段，被拦截降级时卡片显示"已切换内置浏览器抓取"徽标。顺带修复"`ProgressEvent` 有类型无发射方"的历史缺口。
2. **AI 操作角标（P1）**：BrowserWorkspaceTab 的 tab 条与页面顶部在 `aiDriving` 时显示"AI 正在操作"角标；连续自动化合并为一次提示，避免闪烁。
3. **权限文案**：interact/evaluate 的 ask 弹窗说明"AI 将在你可见的内置浏览器中执行动作，可随时接管"。

### 4.6 内部应用测试复用（kind=project）

- **流程策略（写进 §4.2 策略段）**：`project_dev_start` / `start_server` → `open_project_app(embed)` → `read_current_page`（article 看内容、interactive 看控件）→ `interact_current_page(batch)` 模拟用户路径 → 读取 snapshot 附带的 `diagnostics`（console 错误/加载失败）→ 汇总报告给用户。
- 不新造测试框架；需要 e2e 套件、多浏览器矩阵、CI、trace 时 → 建议外部 playwright MCP（L2）。
- （P2 可选）`project_smoke_check` 宿主工具：一键对当前页面做快照 + 诊断采集 + 基本可交互性走查，输出结构化报告。

### 4.7 工具内自动降级（P2，进阶可选）

P0/P1 的"模型显式降级"稳定后，再考虑让 `web_fetch` 内部经 host bridge 一步完成渲染抓取：

- 新增 host_request kind `webview.fetch_rendered(url, query?)`：主进程复用 `requestPageAutomationFromRenderer`，打开（或复用已有的）browser tab，等待加载后取 article 快照返回；
- 收益：模型一次调用拿到正文，省 2–3 轮往返；
- 代价：Rust 工具需持有宿主通道访问权；失败语义与用户打扰控制更复杂；
- 触发限制：仅单页 `web_fetch`；受设置项"自动浏览器降级"开关约束（默认开、可关）；搜索内联补抓（`auto_fetch_top_n`）**不**自动降级，避免批量弹 tab。

### 4.8 外部浏览器 MCP 收口（L2）

- `MCPSettingsPanel.vue` 增加"浏览器 MCP"预设模板（chrome-devtools-mcp / playwright-mcp / browser-use 一键填充 command+args），文案标注"仅当内置浏览器能力不足时使用"；
- 策略段（§4.2）动态列出已配置浏览器类 server，指导模型 L1 不足时才调用 `mcp__*`；调用天然 permission=ask；
- `docs/user-manual.md` 增补"网页能力分级"章节，向用户说明优先级与配置外部 MCP 的时机。

## 5. 权限与安全

### 5.1 权限矩阵（建议档位）

| 工具 / 动作 | 档位 | 说明 |
| --- | --- | --- |
| `web_search` / `web_fetch` / `read_current_page`（interactive/article/search_results/screenshot/diagnostics） | safe | 沿用 `ALWAYS_SAFE_TOOLS`（`permission-engine.ts`），只读 |
| `open_workspace_tab`（browser/project） | safe | 打开用户可见页面本身无害；页面内动作另计 |
| `manage_workspace_tabs`（list/activate/close）/ `screenshot` 动作 | safe | 本地只读/展示 |
| `interact_current_page` / `fill_current_page_form` | **ask** | 可按域记忆 allow（P2 优化：只读型动作 click/hover/scroll safe 化） |
| `evaluate` 动作 | **ask** | 每次；域白名单机制放 P2 |
| `mcp__*`（外部浏览器 MCP） | ask | 现状不变 |

### 5.2 安全要点

- **SSRF**：L0 沿用 `validate_public_target`（禁 localhost/私网/CGNAT）。L1 是用户可见的真实浏览器，不受此限，但 **AI 发起的** browser 类 tab 导航 localhost/内网地址时，`open_workspace_tab` 工具侧校验并提示（防止 AI 借浏览器读内网管理页后静默提取；用户手动导航不受限）。内部应用走 `kind=project`，天然豁免。
- **登录态**：`persist:the-world-browser` 与用户会话共享 → AI 读到的是"用户自己的会话"。策略段明确约束：登录态下的写操作（发帖/支付/删除类）必须走 ask；permission engine 按 `action.kind` 细分只读/写型动作是 P2 项。
- **上下文膨胀**：article/search_results 输出上限 + `query` 聚焦裁剪（§4.3），防止单页正文撑爆上下文。
- 下载与弹窗：已有 dock 化与下载处理（`windows.ts`），不变。

## 6. 分期实施

### P0 —— 策略与信号（最小可用）

1. `web.rs`：`classify_access()` + `access`/`access_detail`/`fallback` 字段；
2. 策略注入：`chat.send` 增 `policy_sections.web`，`buildActivePagePromptSection()` 扩展；
3. `read_current_page` 增 `mode=article`（renderer 阅读提取）；
4. Rust web 工具 progress 事件 → 接通 `WebSearchBlock` / `WebFetchBlock` 富卡片；
5. 权限核对：article 读取纳入 safe，interact 维持 ask。

### P1 —— 工具面增强

6. 稳定 ref + `batch` / `find` / `wait_for`、视口/整页 `screenshot`、真实键盘/鼠标输入、`navigate` / `reload` / `back` / `forward`、`resize` 动作；
7. `tab_id` 定向路由 + `manage_workspace_tabs`（list/activate/close）；
8. `search_results` 预设提取（bing/ddg/google）；
9. 内部应用测试：snapshot `diagnostics`（console/加载失败）+ 测试流程策略段；
10. `aiDriving` 操作角标 UI；
11. `emulate` 动作：media / prefers-color-scheme / prefers-reduced-motion / user agent / 移动端 viewport / device scale / reset。

### P2 —— 收口与进阶

12. `web_fetch` 工具内自动浏览器降级（`webview.fetch_rendered`，含设置开关）；
13. MCP 面板浏览器预设 + L2 动态指导；
14. evaluate 域白名单、只读型页面动作 safe 化；
15. `project_smoke_check` 一键走查工具。

## 7. 开放决策点

1. P2 自动降级的触发边界：每会话次数上限？仅 https？
2. `evaluate` 是否永久 ask，或按域 allow 记忆；
3. `search_results` 预设选择器的维护方式：内置常量 vs 可热更配置；
4. AI 导航 localhost 的管控强度：仅提示 vs 阻止；
5. 策略文本单一来源通道：`chat.send` 字段（推荐）vs initialize capabilities 常量。

## 8. 附录：改动面清单

**harness-rs**

- `crates/tools/src/web.rs`：classify_access、字段、progress 事件发射
- `crates/core/src/dispatcher.rs` / `agent.rs`：`chat.send` 接收 `policy_sections` 并拼入系统提示词
- `crates/tools/electron-tool-contracts.json`：宿主工具 description/schema 快照更新

**apps/electron**

- `electron/main-process/windows.ts`：`buildActivePagePromptSection()` 扩展为策略段
- `electron/main-process/ipc.ts`：`pageAutomation:request/response` payload 透传 `tab_id`
- `src/shared/page-automation-types.ts`：动作/模式扩展；新增 `src/shared/search-extract-presets.ts`
- `src/renderer/components/app/BrowserWebView.vue`：article 提取、稳定 ref、batch/find/wait_for/screenshot、诊断缓冲、`aiDriving`
- `src/renderer/components/workspace/tabs/BrowserWorkspaceTab.vue`：操作角标
- `src/renderer/components/workspace/workspace-store.ts`：surface `aiDriving` 状态
- `src/App.vue`：`tab_id` 路由
- `src/main/ai-host/agent/tools/tool-active-page.ts`（mode/tab_id）、`tool-open-workspace-tab.ts`（localhost 校验）、`tool-manage-workspace-tabs.ts`（tab 编排）
- `src/main/ai-host/agent/tools/index.ts`、`electron-tool-registry.ts`：注册
- `src/main/ai-host/agent/permissions/permission-engine.ts`：safe 清单核对
- `src/main/ai-harness/types.ts`：`policy_sections` 通道与 web 事件 payload 类型
- `src/renderer/components/settings/MCPSettingsPanel.vue`：浏览器 MCP 预设
- `src/locales/en-US` / `zh-CN`：新文案
- `docs/user-manual.md`：网页能力分级章节
