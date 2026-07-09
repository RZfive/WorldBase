# WorldBase / worldbase — 在线更新双仓接口契约

更新时间：2026-05-17  
状态：实施契约草案（可直接进入开发拆分）

## 1. 文档目标

本文档约束 `the-world` 桌面端仓库与 `worldbase` 官网仓库在“关于页 + 在线检查更新 + 下载更新”场景下的边界、接口、发布产物和验收标准，避免出现以下问题：

- 官网版本信息与桌面构建版本各自维护，导致版本不一致。
- 官网下载页可用，但桌面端自动更新拿不到正确清单。
- 渲染进程直接处理安装包，产生安全与权限风险。
- Windows、macOS、Linux 一次性一起做，导致首期无法落地。

## 2. 适用范围

### 2.1 本期范围（P1）

- `the-world` 新增“关于与更新”页面。
- 桌面端可显示当前版本、更新渠道、最近检查状态。
- 桌面端可从官网检查是否有新版本。
- Windows x64 支持“检查更新 -> 下载更新 -> 校验 -> 启动安装包”。
- `worldbase` 提供统一的发布信息、下载跳转和客户端更新接口。
- `the-world` CI 产物成为唯一发布真相。

### 2.2 本期非目标

- macOS 自动后台更新。
- Linux 自动后台更新。
- 多渠道灰度发布控制台。
- 增量补丁自研协议。
- 官网继续手工维护真实版本号和真实安装包 URL。

## 3. 关键原则

### 3.1 单一真相源

真实版本信息、安装包、哈希、`latest.yml` 只能来自 `the-world` 的构建产物。  
`worldbase` 只能读取、聚合、展示和分发，不能再手工定义“真实最新版是什么”。

### 3.2 双仓职责固定

`the-world` 负责：

- 生成发布产物。
- 提供机器可读的 canonical release manifest。
- 在桌面端展示关于页、检查更新、下载更新、校验并执行安装。

`worldbase` 负责：

- 托管发布产物。
- 提供官网页面和 API。
- 将官网展示和桌面端更新都绑定到同一份发布数据。
- 负责下载统计与 Cloudflare 缓存控制。

### 3.3 主进程独占更新能力

安装包下载、哈希校验、启动安装程序只能在 Electron 主进程执行。  
Renderer 只负责显示状态和触发按钮，不允许直接下载并执行安装文件。

### 3.4 Windows First

首期只承诺 Windows x64 完整更新闭环。  
macOS / Linux 首期只需要在 About 页内显示“有更新”并跳转官网更新页或下载页。

## 4. 双仓边界

| 主题 | the-world | worldbase |
|------|-----------|-----------|
| 版本号真相 | 是 | 否 |
| 安装包构建 | 是 | 否 |
| `latest.yml` 生成 | 是 | 否 |
| 发布产物上传 | 是（CI 负责） | 否 |
| 官网展示 | 否 | 是 |
| 下载跳转 | 否 | 是 |
| 客户端检查更新 API | 消费方 | 提供方 |
| 更新 UI（About 页） | 是 | 否 |
| 下载统计 | 否 | 是 |

## 5. 发布产物契约

## 5.1 发布目录约定

Cloudflare 侧的最终产物必须落在统一路径结构下：

```text
/desktop/{channel}/{platform}/{arch}/{version}/release.json
/desktop/{channel}/{platform}/{arch}/{version}/latest.yml
/desktop/{channel}/{platform}/{arch}/{version}/WorldBase-Setup-{version}.exe
/desktop/{channel}/{platform}/{arch}/{version}/WorldBase-Setup-{version}.exe.blockmap

/desktop/{channel}/{platform}/{arch}/current/release.json
/desktop/{channel}/{platform}/{arch}/current/latest.yml
```

说明：

- `{channel}`：`stable` 或 `beta`
- `{platform}`：P1 固定为 `win32`
- `{arch}`：P1 固定为 `x64`
- `{version}`：语义化版本号，例如 `0.1.1`
- `current/` 是最新稳定别名，便于客户端获取最新 manifest

## 5.2 P1 必需产物

Windows x64 必需包含：

- NSIS 安装包 `.exe`
- `.exe.blockmap`
- `latest.yml`
- `release.json`

其中：

- `latest.yml` 用于兼容后续 `electron-updater` generic provider。
- `release.json` 用于官网展示与桌面端统一更新 API。

## 5.3 Canonical Release Manifest 契约

`release.json` 是跨仓库共享的标准发布清单。它由 `the-world` 构建流程生成，`worldbase` 原样读取或做轻量转换，不允许人工再维护一份重复真相。

示例：

```json
{
  "schemaVersion": 1,
  "appId": "com.theworld.app",
  "productName": "WorldBase",
  "channel": "stable",
  "platform": "win32",
  "arch": "x64",
  "version": "0.1.1",
  "publishedAt": "2026-05-17T10:30:00.000Z",
  "minimumSupportedVersion": "0.1.0",
  "notes": {
    "zh": [
      "修复应用运行时日志采集。",
      "新增关于与更新页面。"
    ],
    "en": [
      "Fixed runtime log collection.",
      "Added About & Updates page."
    ]
  },
  "website": {
    "downloadsUrl": "https://worldbase.example.com/downloads",
    "updatesUrl": "https://worldbase.example.com/updates"
  },
  "assets": [
    {
      "kind": "installer",
      "fileName": "WorldBase-Setup-0.1.1.exe",
      "relativePath": "desktop/stable/win32/x64/0.1.1/WorldBase-Setup-0.1.1.exe",
      "downloadUrl": "https://downloads.example.com/desktop/stable/win32/x64/0.1.1/WorldBase-Setup-0.1.1.exe",
      "sha512": "base64-sha512",
      "sha256": "hex-sha256",
      "size": 147176880,
      "contentType": "application/vnd.microsoft.portable-executable"
    },
    {
      "kind": "blockmap",
      "fileName": "WorldBase-Setup-0.1.1.exe.blockmap",
      "relativePath": "desktop/stable/win32/x64/0.1.1/WorldBase-Setup-0.1.1.exe.blockmap",
      "downloadUrl": "https://downloads.example.com/desktop/stable/win32/x64/0.1.1/WorldBase-Setup-0.1.1.exe.blockmap",
      "sha256": "hex-sha256",
      "size": 123456,
      "contentType": "application/octet-stream"
    },
    {
      "kind": "updater_manifest",
      "fileName": "latest.yml",
      "relativePath": "desktop/stable/win32/x64/0.1.1/latest.yml",
      "downloadUrl": "https://downloads.example.com/desktop/stable/win32/x64/0.1.1/latest.yml",
      "sha256": "hex-sha256",
      "size": 680,
      "contentType": "text/yaml"
    }
  ]
}
```

### 5.3.1 字段要求

- `schemaVersion`：契约版本，P1 固定为 `1`
- `channel`：`stable` / `beta`
- `platform`：P1 为 `win32`
- `arch`：P1 为 `x64`
- `version`：必须与桌面端 `package.json` 版本一致
- `notes.zh` / `notes.en`：官网与桌面端展示使用
- `minimumSupportedVersion`：预留字段，用于未来强制升级策略

### 5.3.2 禁止事项

- `worldbase` 不得继续把 `lib/releases.ts` 作为唯一真实版本源。
- `worldbase` 不得人工改写 `version`、`sha512`、`size`。
- `the-world` 不得在 renderer 内直接使用第三方下载链接绕过主进程。

## 6. 官网 HTTP 接口契约

## 6.1 `GET /api/releases`

用途：官网页面展示版本列表和更新日志。  
消费方：`worldbase` 页面组件、可选的公开网页数据消费方。  
说明：这是“展示接口”，不是桌面端更新判定的唯一接口。

请求示例：

```text
GET /api/releases
GET /api/releases?channel=stable
GET /api/releases?channel=stable&latest=1
```

响应示例：

```json
{
  "items": [
    {
      "version": "0.1.1",
      "channel": "stable",
      "publishedAt": "2026-05-17T10:30:00.000Z",
      "headline": {
        "zh": "修复日志采集并补齐更新链路。",
        "en": "Fixed runtime logging and completed the update path."
      },
      "summary": {
        "zh": "本次版本主要补齐关于页和在线更新能力。",
        "en": "This release focuses on the About page and online updates."
      },
      "notes": {
        "zh": ["修复应用日志采集。", "新增关于与更新页面。"],
        "en": ["Fixed runtime log collection.", "Added About & Updates page."]
      },
      "assets": [
        {
          "slug": "windows-x64",
          "platform": "Windows",
          "arch": "x64",
          "format": "exe",
          "version": "0.1.1",
          "url": "https://worldbase.example.com/api/download/windows-x64"
        }
      ]
    }
  ]
}
```

## 6.2 `GET /api/app-update/latest`

用途：桌面端专用更新检查接口。  
消费方：`the-world` 主进程更新服务。

请求：

```text
GET /api/app-update/latest?channel=stable&platform=win32&arch=x64&current=0.1.0
```

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `channel` | string | 是 | `stable` 或 `beta` |
| `platform` | string | 是 | P1 固定为 `win32` |
| `arch` | string | 是 | P1 固定为 `x64` |
| `current` | string | 是 | 当前客户端版本 |

### 6.2.1 有更新响应

```json
{
  "status": "update_available",
  "currentVersion": "0.1.0",
  "latestVersion": "0.1.1",
  "channel": "stable",
  "publishedAt": "2026-05-17T10:30:00.000Z",
  "notes": {
    "zh": ["修复应用日志采集。", "新增关于与更新页面。"],
    "en": ["Fixed runtime log collection.", "Added About & Updates page."]
  },
  "asset": {
    "fileName": "WorldBase-Setup-0.1.1.exe",
    "downloadUrl": "https://downloads.example.com/desktop/stable/win32/x64/0.1.1/WorldBase-Setup-0.1.1.exe",
    "sha512": "base64-sha512",
    "sha256": "hex-sha256",
    "size": 147176880
  },
  "feed": {
    "provider": "generic",
    "latestYmlUrl": "https://downloads.example.com/desktop/stable/win32/x64/current/latest.yml"
  },
  "website": {
    "downloadsUrl": "https://worldbase.example.com/downloads",
    "updatesUrl": "https://worldbase.example.com/updates"
  }
}
```

### 6.2.2 已是最新响应

```json
{
  "status": "up_to_date",
  "currentVersion": "0.1.1",
  "latestVersion": "0.1.1",
  "channel": "stable",
  "publishedAt": "2026-05-17T10:30:00.000Z"
}
```

### 6.2.3 不支持平台响应

```json
{
  "status": "unsupported_platform",
  "channel": "stable",
  "platform": "darwin",
  "arch": "x64",
  "website": {
    "downloadsUrl": "https://worldbase.example.com/downloads",
    "updatesUrl": "https://worldbase.example.com/updates"
  }
}
```

### 6.2.4 错误语义

| 状态码 | 场景 |
|--------|------|
| `200` | 正常返回 `update_available` / `up_to_date` / `unsupported_platform` |
| `400` | 缺少参数或参数非法 |
| `404` | 指定渠道不存在 |
| `503` | 发布源未准备完成（如 manifest 或产物缺失） |

## 6.3 `GET /api/download/:slug`

用途：官网下载按钮跳转。  
消费方：官网页面、浏览器用户。  
非目标：桌面端更新流程不依赖该接口。

契约要求：

- `slug` 对应“当前展示版本的推荐下载入口”，而非桌面端更新唯一依据。
- 接口内部必须从 canonical release manifest 派生，不允许手工写死真实包 URL。
- 返回 302 跳转到真实包地址，并在跳转前记录下载统计。

## 7. 桌面端内部 IPC 契约

以下 IPC 属于 `the-world` 内部接口，但它们决定了 About 页和主进程更新服务的边界，因此纳入本契约。

## 7.1 `app:getAboutInfo`

返回当前应用基础信息。

响应：

```json
{
  "productName": "WorldBase",
  "version": "0.1.0",
  "appId": "com.theworld.app",
  "platform": "win32",
  "arch": "x64",
  "channel": "stable",
  "website": {
    "downloadsUrl": "https://worldbase.example.com/downloads",
    "updatesUrl": "https://worldbase.example.com/updates"
  }
}
```

## 7.2 `appUpdate:check`

入参：

```json
{
  "channel": "stable"
}
```

出参直接复用 `GET /api/app-update/latest` 的响应结构。

## 7.3 `appUpdate:download`

用途：在主进程下载安装包到本地更新目录，并执行哈希校验。

响应：

```json
{
  "ok": true,
  "version": "0.1.1",
  "filePath": "C:\\Users\\<user>\\AppData\\Local\\WorldBase\\updates\\0.1.1\\WorldBase-Setup-0.1.1.exe",
  "verified": true
}
```

## 7.4 `appUpdate:install`

用途：启动已下载的安装程序。  
约束：只能由主进程触发，并在触发前完成哈希校验。

## 7.5 `appUpdate:getState`

返回当前状态机快照：

```json
{
  "status": "idle",
  "lastCheckedAt": null,
  "currentVersion": "0.1.0",
  "latestVersion": null,
  "downloadedFilePath": null,
  "progress": null,
  "error": null
}
```

## 7.6 `appUpdate:onStateChanged`

事件推送，供 About 页实时更新下载进度与失败状态。

## 8. 桌面端状态机契约

```text
idle
  -> checking
  -> up_to_date
  -> update_available
  -> downloading
  -> downloaded
  -> installing
  -> install_triggered

任意状态
  -> failed
```

状态语义：

| 状态 | 说明 |
|------|------|
| `idle` | 初始状态，尚未检查 |
| `checking` | 正在请求官网更新接口 |
| `up_to_date` | 当前已是最新 |
| `update_available` | 发现新版本但尚未下载 |
| `downloading` | 主进程正在下载更新包 |
| `downloaded` | 文件已下载且校验通过 |
| `installing` | 正在触发安装程序 |
| `install_triggered` | 安装程序已启动，等待用户完成 |
| `failed` | 检查、下载、校验或启动安装失败 |

## 9. 缓存与分发契约

Cloudflare 必须按文件类型设置缓存策略：

| 对象 | 缓存策略 |
|------|----------|
| `latest.yml` | `no-cache` 或 `max-age=60` |
| `release.json` | `no-cache` 或 `max-age=60` |
| `.exe` / `.blockmap` | 长缓存，`immutable` |
| `/api/app-update/latest` | 动态响应，不得长缓存 |
| `/api/download/:slug` | 动态跳转，不得长缓存 |

如果 `latest.yml` 和 `release.json` 被 CDN 长缓存，客户端会持续拿到旧版本，这属于发布阻塞故障。

## 10. 安全契约

- 所有更新相关 URL 必须为 HTTPS。
- `appUpdate:download` 完成后必须执行哈希校验。
- 校验失败必须删除本地损坏文件，并进入 `failed` 状态。
- About 页不得暴露任意 URL 安装能力，只能消费官网返回的官方更新地址。
- 渲染进程不得直接执行安装包。

## 11. 兼容与演进

### 11.1 P1

- Windows x64 走 `GET /api/app-update/latest` + 主进程下载/校验/执行安装包。
- `latest.yml` 只作为兼容未来自动更新的发布产物，P1 不要求必须接入 `electron-updater`。

### 11.2 P2

- Windows 可切换到 `electron-updater` generic provider。
- macOS 补齐签名、公证和平台专属更新清单。
- Linux 维持跳官网策略，除非后续明确支持 AppImage 更新。

## 12. P1 验收标准

以下全部满足，才算本期“关于页 + 官网更新链路”完成：

- `the-world` About 页能显示当前版本、平台、架构、渠道。
- Windows x64 运行中的客户端能从官网检查到新版本。
- 下载后主进程完成哈希校验。
- 用户可从 About 页启动安装程序。
- 官网 `/downloads`、`/updates`、`/api/releases` 与桌面端 `/api/app-update/latest` 指向同一版本。
- `worldbase` 不再用手工静态数据维护真实版本号。
- `the-world` 渲染进程不直接处理安装执行。
