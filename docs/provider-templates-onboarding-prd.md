# 供应商模板与一键接入：内置 DeepSeek 模板，三步完成 Key 配置

> **状态** Draft v0.2 · **日期** 2026-09-19 · **范围** `apps/electron/src/main/settings/settings-store.ts`（`AIProvider` / `AIProvidersConfig`）、新增 `apps/electron/src/shared/provider-templates.ts`、`apps/electron/src/renderer/components/settings/ProviderPanel.vue`、`apps/electron/src/renderer/components/chat/messages/EmptyStateSuggestions.vue`、`apps/electron/electron/main-process/ipc.ts`、`apps/electron/electron/preload.ts`、`apps/electron/src/env.d.ts`、`apps/electron/src/locales/**`
> **平台** 仅 Electron 桌面端。
> **v0.2 变更** 预设改称「内置模板」并在列表中与用户自建供应商分区展示；首批只内置 DeepSeek 一个模板；无供应商时的聊天空态引导卡提升为 P0。

## 摘要

新用户打开供应商设置时看到的是一张空列表和一个「+ 添加」按钮。点进去要自己填名称、API 地址、协议、Key、模型列表，其中「API 地址填什么」「去哪里拿 Key」两个问题对非开发者用户没有答案。

本 PRD 引入 **内置供应商模板（Provider Template）**：应用自带一组只读模板，首批只有 **DeepSeek**。模板在供应商列表里单独分区展示，与用户自己添加的供应商明确区分；模板自带地址、协议、默认模型、定价与官网 / 控制台 / Key 管理页 / 充值页链接。用户点「使用模板」即复制出一个属于自己的供应商，只剩 Key 一项要填；点「去官网获取 Key」打开对应页面，注册、充值、复制 Key，回到应用后自动识别剪贴板并一键填入，保存即可用。

当用户一个供应商都没有时，**聊天页空态**（与每日推荐同一区域）直接出现一张引导卡，把用户带到 DeepSeek 模板的编辑态。

---

## § 01 现状评估

### 已有链路（已验证）

- **数据结构**：`AIProvider`（`settings-store.ts:31`）包含 `id / name / baseUrl / apiKey / apiProtocol / detectedApiProtocol / models / modelContextWindows / modelPricing / modelCapabilities / activeModel / enableThinking / temperature`。没有「来自哪个模板」的标识，也没有外部链接字段。
- **新增流程**：`ProviderPanel.vue` 的 `startAdd()` 生成 `provider_<ts>` id，`baseUrl` 硬编码为 `https://api.openai.com/v1`，其余全空。用户必须逐项手填。
- **协议探测与模型拉取已经存在**：`settings:detectProviderProtocol` 与 `settings:fetchProviderModels` 两个 IPC 在 `baseUrl + apiKey` 填好后自动触发（`ProviderPanel.vue:138-170`）。模板只需要把地址与协议填对，这两条链路即可接上。
- **默认配置为空**：`getAIProvidersConfig()` 在无旧配置时返回 `{ providers: [], activeProviderId: '', enabledProviderIds: [] }`（`settings-store.ts:971`）。空态文案是「先在左侧选择一个模型平台，或新建一个供应商」。
- **左侧列表是单一平铺**：`filteredProviders` 直接渲染 `providers` 数组，每项带「已启用 / 默认」徽标，没有分组概念。
- **外链能力**：主进程有 `shell.openExternal`（`ipc.ts:242`），但 preload 只暴露了 `openAppUpdateWebsite(kind)` 这一个带白名单的开站接口，**没有通用的 openExternal**。应用内还有 `browser:openUrlInDock`，可以在内置浏览器打开页面。
- **剪贴板**：渲染进程已直接使用 `navigator.clipboard.readText()`（`BrowserWebView.vue:213`），无需新 IPC。
- **聊天空态**：`EmptyStateSuggestions.vue` 已有卡片网格与 `providerMissing` 状态（来自每日推荐快照），是放引导卡的自然位置。
- **Key 只存本地**：`apiKeyHint` 文案「仅保存在本地，不会上传」，本 PRD 不改变这一承诺。

### 保留的部分

多供应商模型、协议自动探测、远程模型拉取、定价与预算、导入导出--全部复用。模板只是给这套机制一个「填好的表单」。

---

## § 02 问题诊断

1. **零到一的门槛在「填表」而不在「理解」**。用户知道自己要用 DeepSeek，但不知道 `baseUrl` 是 `https://api.deepseek.com` 还是带 `/v1`，不知道协议选 `openai-chat` 还是自动。这些都是可以预填的确定信息。
2. **拿 Key 的路径断在应用外**。用户需要自己搜索「deepseek api key」，找到控制台，注册、充值、创建 Key、复制、切回应用。中间任何一步走神就流失。应用应当直接给出正确的页面链接。
3. **复制回来还要找输入框**。切回应用后要重新定位到编辑态的 Key 输入框并粘贴。剪贴板里就是 Key，应用应当主动识别。
4. **没有默认推荐，也没有在用户最需要的地方提醒**。用户打开聊天页发现不能用，要自己猜去哪里配置。空列表和空聊天页都应当直接给出「用 DeepSeek，三步搞定」的路。
5. **内置内容与用户内容混在一起会出问题**。如果把模板直接塞进 `providers` 数组，用户会困惑「这个我没加过」，删掉之后又找不回来，导入导出也会带着它走。模板必须是只读、独立分区、可反复使用的。
6. **模板需要可更新**。供应商的地址、模型、定价会变。硬编码在渲染层意味着每次变更都要发版；模板应当放在主进程可读的单一来源，并预留远程覆盖的位置。

---

## § 03 目标与非目标

### 目标

1. 内置只读模板列表，首批只有 DeepSeek；在供应商列表中以独立分区「内置模板」展示，与「我的供应商」明确区分。
2. 「使用模板」一键复制出用户自己的供应商，地址、协议、默认模型、上下文窗口、定价、能力标记全部预填，只剩 Key。
3. 编辑态提供「去官网获取 Key」按钮，打开该供应商的 Key 管理页；同时提供注册、充值、定价链接。
4. 打开官网后回到应用，若剪贴板内容匹配该供应商的 Key 格式，提示一键填入。
5. 用户没有任何供应商时，聊天页空态出现引导卡，直达 DeepSeek 模板编辑态。
6. 由模板创建的供应商在详情页显示模板徽标与官网快捷入口。

### 非目标（本期不做）

- 不内置 DeepSeek 以外的模板（数据结构支持多个，后续按需追加，见 § 09）。
- 不做 OAuth / 设备码等免复制授权流程。
- 不做模板的远程下发（本期内置在安装包，但数据结构预留 `source: 'builtin' | 'remote'`）。
- 不在应用内代购 token、不集成任何支付。
- 不改动移动端。

---

## § 04 模板数据模型 `P0`

### R1 · `ProviderTemplate` 定义

新文件 `apps/electron/src/shared/provider-templates.ts`，主进程与渲染进程共用：

```ts
export interface ProviderTemplateLinks {
  /** 品牌官网，必填。 */
  homepage: string
  /** 注册页。缺省时用 homepage。 */
  signup?: string
  /** 控制台首页。 */
  console?: string
  /** API Key 管理页。「去官网获取 Key」优先打开此链接。 */
  apiKeys?: string
  /** 充值 / 计费页。 */
  billing?: string
  /** 模型与定价文档。 */
  pricing?: string
}

export interface ProviderTemplateModel {
  id: string
  contextWindow: number
  pricing?: { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number }
  capabilities?: { imageGeneration?: boolean; imageEditing?: boolean }
}

export interface ProviderTemplate {
  /** 稳定 id，如 'deepseek'。发布后不可改。 */
  id: string
  name: string
  baseUrl: string
  apiProtocol: ConcreteApiProtocol
  models: ProviderTemplateModel[]
  defaultModel: string
  links: ProviderTemplateLinks
  /** 用于剪贴板识别的 Key 正则源码，如 '^sk-[A-Za-z0-9]{32,}$'。缺省时用通用规则。 */
  apiKeyPattern?: string
  /** Key 输入框 placeholder，如 'sk-…'。 */
  apiKeyPlaceholder?: string
  /** 是否在空态与引导卡中作为首选推荐。同一时间只能有一个为 true。 */
  recommended?: boolean
  order: number
  source: 'builtin' | 'remote'
  /** 文件头注明的核对日期，YYYY-MM-DD，仅供维护者参考。 */
  verifiedAt: string
}

export const PROVIDER_TEMPLATES: readonly ProviderTemplate[]
export function getRecommendedTemplate (): ProviderTemplate
```

模板的一句话卖点走 i18n：`settings.provider.templates.<id>.tagline`。

### R2 · 首批内置模板：DeepSeek

| 字段 | 值 |
| --- | --- |
| id | `deepseek` |
| name | DeepSeek |
| baseUrl | `https://api.deepseek.com` |
| apiProtocol | `openai-chat` |
| models / defaultModel | 以实现当天 DeepSeek 官方文档为准（2026-09-20 核对：`deepseek-flash` 与 `deepseek-v4-pro`，旧名 `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 下线），`defaultModel` 取官方示例使用的 `deepseek-flash` |
| links.homepage | `https://www.deepseek.com` |
| links.console | `https://platform.deepseek.com` |
| links.apiKeys | `https://platform.deepseek.com/api_keys` |
| links.billing | `https://platform.deepseek.com/top_up` |
| links.pricing | `https://api-docs.deepseek.com/zh-cn/quick_start/pricing` |
| apiKeyPattern | `^sk-[A-Za-z0-9]{20,}$` |
| apiKeyPlaceholder | `sk-…` |
| recommended | `true` |
| tagline（zh-CN） | 「国内直连、价格低、注册即送额度，配置最省事的选择」（措辞由产品最终确认，不得出现无法核实的承诺） |

- 上下文窗口与定价在实现时按官方文档填入，并写入 `verifiedAt`；本文档不锁定数值。
- 模板文件是唯一数据源；渲染层不得再出现硬编码的 `https://api.openai.com/v1`（`startAdd()` 与 template placeholder 一并改为留空，placeholder 文案改为「例如 https://api.example.com/v1」）。

### R3 · `AIProvider` 扩展

```ts
export interface AIProvider {
  // ...现有字段不变
  /** 由哪个模板创建；手工创建的供应商无此字段。 */
  templateId?: string
  /** 创建时模板的快照链接，避免模板升级后旧供应商链接丢失。 */
  links?: ProviderTemplateLinks
}
```

- **模板本身永远不进入 `providers` 数组**。它只存在于 `provider-templates.ts`，不能被启用、设为默认、编辑或删除；导入导出、Rust harness 同步都不会看到它。
- `normalizeAIProvider()` 接受 `templateId / links`；`templateId` 不在内置列表中时保留原值不报错（为远程模板预留）。
- 导入 / 导出配置（`ConfigTransferPanel`）随同带出这两个字段。
- Rust harness 同步（`settings:saveProviders` 内的 sync）忽略这两个字段，不影响运行。

---

## § 05 外链与剪贴板能力 `P0`

### R4 · 通用外链 IPC（带白名单）

新增 `shell:openExternal`：

- preload 暴露 `openExternalUrl(url: string): Promise<{ ok: boolean; error?: string }>`。
- 主进程只允许 `https:` 协议，且 host 必须命中**模板链接的 host 集合**（从 `provider-templates.ts` 收集）或已有 `appUpdate` 白名单；其他一律拒绝并返回 `error: 'url-not-allowed'`。这样渲染层无法把它当作任意开站入口。
- 默认在**系统浏览器**打开（用户的登录态与密码管理器都在那里，注册充值体验最好）。
- 编辑态按钮旁提供次级选项「在应用内打开」，走 `browser:openUrlInDock`；内置浏览器无法通过人机验证时用户可退回系统浏览器。

### R5 · 剪贴板 Key 识别

- 触发条件：用户在编辑态点过「去官网获取 Key」之后（会话内标记 `awaitingKeyFromWeb = true`），窗口重新获得焦点（`window` 的 `focus` 事件）。
- 读取 `navigator.clipboard.readText()`；读取失败或为空则静默。
- 匹配规则：优先用模板的 `apiKeyPattern`；无模板时用通用规则「无空白、长度 20～200、以 `sk-` / `sk-ant-` / `gsk_` 等常见前缀开头或整体为 base62」。不匹配则静默。
- 匹配成功且当前 Key 输入框为空（或与剪贴板不同）时，在 Key 输入框上方显示内联提示条：「检测到剪贴板里有一个 API Key，填入？」+ **填入** / **忽略** 两个按钮；不自动填入，避免误把别的东西写进去。
- 填入后清除 `awaitingKeyFromWeb`，触发现有的协议探测与模型拉取。
- 剪贴板内容不写日志、不发送到任何地方；「忽略」后同一段内容不再提示。

---

## § 06 供应商面板 UI `P0`

### R6 · 左侧列表分区

`ProviderPanel.vue` 左侧列表改为两个分区：

```
┌ 搜索框 ─────────────────────┐
│ 我的供应商                   │
│   OpenAI 自建     已启用 默认 │
│   DeepSeek        已启用     │   ← 由模板创建，名称旁有小徽标「模板」
│   （为空时）还没有供应商      │
│                             │
│ 内置模板                     │
│   DeepSeek   推荐   [使用]   │   ← 只读，不可启用/设默认
│                             │
│ [+ 自定义供应商]             │
└─────────────────────────────┘
```

- 「我的供应商」渲染 `providers`，行为与现在一致（点击选中、徽标显示启用与默认）。为空时显示一行占位文案。
- 「内置模板」渲染 `PROVIDER_TEMPLATES`，每行：名称、`recommended` 时显示「推荐」徽标、右侧「使用」按钮。**行本身可点击**，在右侧展示模板的只读详情（见 R8），但不会出现在启用 / 默认相关的任何操作里。
- 搜索框同时过滤两个分区。
- 「+ 添加」改名为「+ 自定义供应商」，走原 `startAdd()` 流程，`baseUrl` 留空。
- 已由某模板创建过供应商时，模板行仍然保留并可再次使用（用户可能想用第二个 Key）；「使用」按钮不禁用，只在 tooltip 提示「你已有 1 个由此模板创建的供应商」。

### R7 · 右侧空态改为推荐引导

`selectedProvider` 为空、未选中模板、不在编辑态时，右侧由一句提示改为 **推荐引导卡**：

- 标题「还没有供应商？用 DeepSeek 三步开始」，下方三步图示：① 使用模板 ② 去官网拿 Key ③ 粘贴保存。
- 主按钮「使用 DeepSeek 模板」= 等价于点击模板行的「使用」。
- 次级文字链「自定义供应商」。
- 引导卡的推荐对象来自 `getRecommendedTemplate()`，不硬编码 DeepSeek。

### R8 · 模板只读详情与「使用」

点击模板行时，右侧展示只读详情：名称、tagline、API 地址、协议、模型列表（含上下文窗口与定价）、官网 / 控制台 / 定价链接、核对日期。顶部一个主按钮「使用此模板」。

点击「使用」后进入编辑态，草稿为：

```ts
{
  id: `${template.id}_${Date.now().toString(36)}`,   // 允许同一模板创建多个（不同 Key / 不同额度）
  name: template.name,                                 // 已有同名供应商时自动追加 " 2"
  baseUrl: template.baseUrl,
  apiProtocol: template.apiProtocol,
  models: template.models.map(m => m.id),
  modelContextWindows / modelPricing / modelCapabilities: 由模板展开,
  activeModel: template.defaultModel,
  apiKey: '',
  templateId: template.id,
  links: { ...template.links }
}
```

进入编辑态后 Key 输入框自动聚焦。

### R9 · 编辑态

- 顶部标题旁显示模板徽标（品牌名 chip）；名称、地址、协议字段**仍可改**，改动地址或协议后显示一行提示「已偏离模板默认值」，并提供「恢复模板」文字链。
- Key 输入框下方的 hint 区改为一组按钮：
  - **去官网获取 Key**（主）：打开 `links.apiKeys ?? links.console ?? links.homepage`，并置 `awaitingKeyFromWeb`。
  - **注册** / **充值** / **定价**（次级文字链，仅当对应链接存在时显示）。
  - 现有「仅保存在本地，不会上传」文案保留在按钮下方。
- Key 输入框 placeholder 使用 `template.apiKeyPlaceholder`。
- 保存条件不变（地址 + Key + 至少一个模型），模板已满足前两项之外的所有条件，用户填完 Key 即可保存。保存后该供应商自动加入 `enabledProviderIds`；若此前 `activeProviderId` 为空则同时设为默认，让用户回到聊天页就能用。

### R10 · 详情态（用户供应商）

- 名称旁显示模板徽标。
- 「API 地址」行右侧增加「官网」「控制台」图标链接（有链接时显示）。
- 新增一行「快捷操作」：**管理 Key** / **充值**，跳转对应链接。
- 手工创建的供应商没有这些元素，界面与现在完全一致。

---

## § 07 聊天页空态引导卡 `P0`

### R11 · 无供应商时的引导卡

`EmptyStateSuggestions.vue` 在 `providers` 为空时（通过现有 `settings:getProviders` 与 `settings:providersChanged` 订阅判断，不依赖每日推荐的 `providerMissing`），在卡片网格**最前面**插入一张引导卡：

- 标题「还没有配置模型，先接一个供应商」；正文「推荐 DeepSeek：使用模板 → 官网拿 Key → 粘贴保存，三步完成」；主按钮「用 DeepSeek 开始」；次级文字链「其他供应商」。
- 主按钮：跳转到设置 → 供应商面板，并直接以推荐模板进入编辑态（等价于 R8 的「使用」）。需要一个新的跨面板导航参数，如 `openSettings({ pane: 'providers', useTemplate: 'deepseek' })`，复用现有打开设置面板的机制。
- 次级文字链：跳转到供应商面板空态（R7）。
- 引导卡**不可 dismiss**（这不是推荐，是阻塞性状态），配置任一供应商后自动消失。
- 与每日推荐的 `providerMissing` 提示（daily 组因缺少模型无法生成）合并展示：有引导卡时不再单独显示那条提示，避免两处说同一件事。
- 此时输入框底部若有「未配置模型」的现有提示，保留不动。

---

## § 08 i18n

新增 key（zh-CN / en-US 同步）：

- `settings.provider.sections.{mine,templates}`、`settings.provider.mineEmpty`、`settings.provider.customProvider`
- `settings.provider.templates.badge`（模板）、`templates.recommended`（推荐）、`templates.use`、`templates.useThis`、`templates.alreadyCreated`（`你已有 {count} 个由此模板创建的供应商`）、`templates.verifiedAt`
- `settings.provider.templates.<id>.tagline`
- `settings.provider.guide.{title,step1,step2,step3,useRecommended,custom}`（R7）
- `settings.provider.links.{homepage,signup,console,apiKeys,billing,pricing}`
- `settings.provider.getKeyFromWebsite`、`openInApp`、`openInBrowser`、`driftedFromTemplate`、`restoreTemplate`
- `settings.provider.clipboardKeyDetected`、`clipboardKeyFill`、`clipboardKeyIgnore`
- `settings.provider.openExternalFailed`
- `chatUi.onboarding.noProvider.{title,body,cta,other}`（R11）

---

## § 09 分期与验收

### P0

- R1～R11、§ 08 i18n。
- DeepSeek 模板的链接与模型数据核对到实现当天的官方文档。

### P1

- 追加模板：Moonshot Kimi、智谱 GLM、OpenAI、Anthropic、OpenRouter（数据结构已支持，只需补数据与 tagline）。
- 模板远程覆盖：主进程启动时读取 `userData/provider-templates.override.json`（若存在）合并内置列表。
- 引导卡与推荐引导按系统语言选择不同的 `recommended` 模板（zh-CN 推荐 DeepSeek，其余推荐 OpenAI）。

### P2（候选）

- 供应商额度 / 余额查询（各家 API 不统一，需逐家适配）。
- OAuth / 设备码授权。

### 验收标准

- 新装、空配置：打开聊天页，第一张卡是引导卡；点「用 DeepSeek 开始」跳到供应商面板并直接处于 DeepSeek 模板的编辑态，Key 输入框已聚焦，地址 / 协议 / 模型已填好。
- 供应商面板左侧「我的供应商」为空并显示占位文案，「内置模板」下有 DeepSeek 一行带「推荐」徽标；右侧为三步引导卡。
- 点模板行：右侧为只读详情，没有编辑、删除、启用、设默认的任何入口。
- 点「去官网获取 Key」：系统浏览器打开 DeepSeek 的 Key 管理页；切回应用时若剪贴板为 `sk-` 开头的 20 位以上字符串，出现「填入？」提示；点「填入」后 Key 进入输入框、模型列表自动刷新；点「忽略」后同一内容不再提示。
- 剪贴板为普通文本（如一段中文）切回应用：无任何提示。
- 填 Key 保存后：该供应商出现在「我的供应商」并已启用、已设为默认；聊天页引导卡消失；模板行仍在「内置模板」下可再次使用。
- 用 `openExternalUrl` 传入非白名单地址（如 `https://example.com`）：返回 `url-not-allowed`，不打开任何页面。
- 由模板创建的供应商详情页显示模板徽标与「管理 Key / 充值」；手工创建的供应商界面不变。
- 修改模板供应商的地址后出现「已偏离模板默认值」；点「恢复模板」后地址与协议回到模板值，Key 不受影响。
- 导出配置再导入：`templateId` 与 `links` 完整保留；导出文件中**不包含**模板本身。
- 删除由模板创建的供应商后，模板行仍在，可重新使用。
- 旧版本配置升级：无 `templateId` 的供应商正常加载，功能不受影响。

### 测试

- `provider-templates.ts`：每个模板的 `baseUrl`、所有 `links` 均为合法 `https` URL；`defaultModel` 存在于 `models`；`id` 唯一；`apiKeyPattern` 可编译；有且只有一个 `recommended`。
- `normalizeAIProvider`：`templateId / links` 的接收、非法值裁剪、缺省兼容。
- 外链白名单：模板 host 全部放行，`http:`、`file:`、非白名单 host 全部拒绝。
- 剪贴板匹配函数（纯函数抽出）：DeepSeek 正则的正反例、通用规则的边界长度。
- 同名模板重复创建时的自动编号。
- 保存首个供应商后 `enabledProviderIds` 与 `activeProviderId` 的自动设置。

---

## § 10 风险与开放问题

- **官方地址与定价会变**。模板文件头写明 `verifiedAt`；P1 的本地覆盖文件是过渡方案，长期需要远程配置。每次发版前由负责人跑一遍链接可达性脚本。
- **在应用内打开官网**可能被人机验证拦截。因此默认走系统浏览器，应用内打开只作为次选。
- **剪贴板读取权限**：macOS 上 `navigator.clipboard.readText()` 在窗口聚焦时可用；若某平台拒绝，功能静默降级为手动粘贴，不弹错。
- **只推荐一家的中立性**：tagline 只描述「配置最简单、国内可直连」等可核实的事实，不做性能或质量背书；P1 按语言区分推荐对象。
- **开放问题**：引导卡跳转到设置面板并自动进入编辑态，需要现有「打开设置」机制支持携带参数。`App.vue` 已有 `openSettingsCategory(category)` 可定位到分类（`App.vue:549`），但没有「进入某模板编辑态」的参数；实现时在此基础上扩展一个可选的 `useTemplate` 参数，由 `ProviderPanel` 挂载后消费一次。
