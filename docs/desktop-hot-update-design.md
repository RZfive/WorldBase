# WorldBase 桌面端热更新设计（the-world + worldbase-admin）

更新时间：2026-09-28
状态：已实施（Windows / macOS / Linux 三平台；见第 10 节实施记录与上线前清单）
前置文档：`docs/desktop-update-dual-repo-contract.md`（安装包更新契约）

## 1. 目标与非目标

### 1.1 目标

- Windows x64 用户在不重新跑安装器的前提下拿到新版本：下载、校验、下次启动即生效，全程不弹 UAC、不弹向导。
- 绝大多数发版（渲染层、主进程、Rust harness 的改动）都能走热更新；只有 Electron 升级或原生模块变化才发完整安装包。
- 服务端可以随时停掉某个热更新包（kill switch）、按比例灰度，并能看到应用成功率和回滚率。
- 客户端任何一步失败都自动退回：要么继续用安装版本，要么退回到完整安装包流程。

### 1.2 非目标

- 不做运行时不重启的"真正热替换"。热更新指"下载后重启生效"，重启耗时 2 到 3 秒。
- 不做增量二进制补丁（bsdiff 之类）。先做整包，按文件哈希去重留到 P2。
- macOS、Linux 首期不做。设计上留口子，macOS 需要先解决签名与公证。

## 2. 为什么可以热更新：分层

安装目录里 `resources/` 下的内容按"是否能脱离安装器替换"分成三层。

| 层 | 内容 | 可热更 | 原因 |
|---|---|---|---|
| A | `app.asar`：渲染层 `dist/`、主进程 `dist-electron/`（bytenode 字节码）、`node_modules` | 是，条件是 Electron 版本一致 | Electron 的 `require` 能加载任意路径下的 asar；字节码绑定 V8 版本 |
| A' | `app.asar.unpacked/`：sharp、@img、pnpm 等 asarUnpack 内容 | 是 | 纯文件，随 A 一起替换 |
| B | `harness/worldbase-app-server.exe` | 是 | 独立子进程，由 `RustHarnessClient` spawn，路径可配置 |
| C | Electron 运行时（`WorldBase.exe`、`*.dll`、`locales/`） | 否 | 这就是安装器存在的意义 |

结论：热更新包 = 构建产物 `release/win-unpacked/resources/` 目录，去掉 Electron 自带文件。CI 已经在产这个目录，不需要新的打包链路，只需要打包并签名。

## 3. 热更新包（Hot Payload）格式

### 3.1 文件布局

```text
WorldBase-hot-1.5.2-win32-x64.zip
├── manifest.json
├── manifest.sig                 # ed25519 签名，对 manifest.json 原始字节签
├── app.asar
├── app.asar.unpacked/**
└── harness/worldbase-app-server.exe
```

### 3.2 manifest.json

```json
{
  "schemaVersion": 1,
  "kind": "hot_payload",
  "appId": "com.theworld.app",
  "version": "1.5.2",
  "channel": "stable",
  "platform": "win32",
  "arch": "x64",
  "electronVersion": "40.8.0",
  "minBaseVersion": "1.5.0",
  "builtAt": "2026-09-23T08:00:00.000Z",
  "gitSha": "353b2a0",
  "files": [
    { "path": "app.asar", "sha256": "…", "size": 61234567 },
    { "path": "app.asar.unpacked/node_modules/sharp/…", "sha256": "…", "size": 1234 },
    { "path": "harness/worldbase-app-server.exe", "sha256": "…", "size": 23456789 }
  ]
}
```

字段说明：

- `electronVersion`：客户端必须与 `process.versions.electron` 完全相等才允许应用。这是字节码安全的唯一保证。
- `minBaseVersion`：允许应用该热更新包的最低安装版本。同一个 Electron 大版本内可以跨多个小版本。
- `files`：白名单。解压后目录里多出任何不在清单里的文件，视为校验失败。
- 签名私钥只存在 GitHub Actions secret 里，公钥硬编码在客户端 bootstrap 中。管理台或 R2 被拿下也无法伪造可被客户端接受的包。

### 3.3 CI 产出（the-world）

在 `.github/workflows/build.yml` 的 Windows job 里新增一步，脚本 `apps/electron/scripts/build-hot-payload.mjs`：

1. 遍历 `release/win-unpacked/resources/`，排除 Electron 自带文件，逐文件算 sha256。
2. 从 `node_modules/electron/package.json` 读 `electronVersion`，从 `package.json` 读 `version`。
3. 写 `manifest.json`，用 secret 里的 ed25519 私钥签名生成 `manifest.sig`。
4. 打成 zip，连同 zip 的 sha256 一起作为 artifact 上传（与现有 `.exe`、`latest.yml` 并列）。

## 4. 服务端设计（worldbase-admin）

### 4.1 数据模型

对 `release_assets` 加列，不新建表，这样管理台现有的"一行一个产物"模型可以直接复用：

```sql
-- 000N_hot_payload.sql
ALTER TABLE release_assets ADD COLUMN kind TEXT NOT NULL DEFAULT 'installer';
ALTER TABLE release_assets ADD COLUMN electron_version TEXT;
ALTER TABLE release_assets ADD COLUMN min_base_version TEXT;
ALTER TABLE release_assets ADD COLUMN manifest_json TEXT;
ALTER TABLE release_assets ADD COLUMN manifest_sig TEXT;
ALTER TABLE release_assets ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE release_assets ADD COLUMN rollout_percent INTEGER NOT NULL DEFAULT 100;

CREATE TABLE app_update_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id_hash TEXT,
  platform TEXT NOT NULL,
  arch TEXT,
  channel TEXT NOT NULL DEFAULT 'stable',
  kind TEXT NOT NULL,                 -- installer | hot_payload
  from_version TEXT NOT NULL,
  to_version TEXT NOT NULL,
  phase TEXT NOT NULL,                -- downloaded | verified | applied | boot_ok | rolled_back | failed
  error TEXT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE app_update_daily_stats (
  stat_date TEXT NOT NULL,
  to_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  phase TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (stat_date, to_version, kind, phase)
);
```

`kind` 取值：`installer`（现有全部行，默认值）、`hot_payload`。

### 4.2 现有接口的兼容改动

- `GET /api/releases`：默认只返回 `kind = 'installer'` 的 asset。官网下载页和 1.5.x 老客户端因此看不到热更新包，行为不变。加 `?kinds=installer,hot_payload` 时返回全部并带 `kind` 字段。
- `GET /api/downloads`、`GET /api/download/:slug`：统计口径不变，`/downloads` 列表过滤 `kind = 'installer'`。热更新包也通过 `/api/download/:slug` 下发，计数进 `download_totals` 但不出现在官网。
- 管理台 `releasesApi.create/update` 的 zod schema 增加 `kind`、`electronVersion`、`minBaseVersion`、`manifestUrl`、`enabled`、`rolloutPercent`。

### 4.3 新接口：桌面端专用更新判定

契约文档 6.2 节预留的 `GET /api/app-update/latest`，现在正式落地，判定逻辑放到服务端。

请求：

```text
GET /api/app-update/latest
  ?channel=stable&platform=win32&arch=x64
  &current=1.5.1          # 生效版本（可能已是热更新版本）
  &installed=1.5.0        # 安装器版本，即 app.getVersion()
  &electron=40.8.0        # process.versions.electron
  &device=<sha256(deviceId)>
```

判定顺序：

1. 取该 channel 下 `published_at` 最新的 release。若 `version <= current`，返回 `up_to_date`。
2. 在该 release 的 asset 中挑 `kind='installer'` 且平台架构匹配的一条，作为 `asset`。
3. 再挑 `kind='hot_payload'`，要求同时满足：
   - `enabled = 1`
   - `electron_version === query.electron`
   - `compare(query.installed, min_base_version) >= 0`
   - `bucket(device) < rollout_percent`，bucket 取 device 哈希前 4 字节模 100，同一设备结果稳定
   命中则作为 `hotPayload` 一并返回。
4. 没有任何可用 asset 时返回 `unsupported_platform`。

响应：

```json
{
  "status": "update_available",
  "latestVersion": "1.5.2",
  "publishedAt": "…",
  "notes": { "zh": [], "en": [] },
  "asset": {
    "kind": "installer",
    "fileName": "WorldBase-Setup-1.5.2.exe",
    "downloadUrl": "https://api.worldbase.world/api/download/windows-x64",
    "sha256": "…",
    "size": 147176880
  },
  "hotPayload": {
    "kind": "hot_payload",
    "fileName": "WorldBase-hot-1.5.2-win32-x64.zip",
    "downloadUrl": "https://api.worldbase.world/api/download/windows-x64-hot",
    "sha256": "…",
    "size": 98765432,
    "electronVersion": "40.8.0",
    "minBaseVersion": "1.5.0",
    "manifest": { "…manifest.json 原文…" },
    "manifestSig": "base64"
  }
}
```

响应头 `Cache-Control: no-store`。该路径加入 `middleware/auth.ts` 的 `isPublicRequest` 白名单。

### 4.4 新接口：更新事件上报

```text
POST /api/app-update/events
{ "deviceId", "platform", "arch", "channel", "kind", "fromVersion", "toVersion", "phase", "error"? }
```

实现方式照抄 `routes/appStarts.ts`：deviceId 服务端 sha256 后落 `app_update_events`，同时 upsert `app_update_daily_stats`。加入公开 POST 白名单。

### 4.5 管理台改动

- 版本发布页新增产物类型选择：安装包 / 热更新包。选热更新包时：
  - 上传 zip（复用现有 multipart 上传与浏览器端 sha256）。
  - 再上传 `manifest.json` 与 `manifest.sig`（两个小文件，走单文件上传）。
  - 保存时 Worker 从 R2 读 manifest，校验 `version`、`platform`、`arch` 与表单一致，落 `electron_version`、`min_base_version`、`manifest_json`、`manifest_sig`。
- 每行热更新包增加两个控件：启用开关、灰度百分比。这是 kill switch，运维不需要发新版就能止损。
- Dashboard 新增一块：各版本热更新 `applied` / `boot_ok` / `rolled_back` 数，回滚率超过阈值高亮。

### 4.6 P2：CI 直发

签名本来就在 CI 里做，长期应由 CI 直接调 `POST /api/admin/releases` 发布，管理台只负责开关和灰度。认证用 Cloudflare Access service token（`CF-Access-Client-Id` / `CF-Access-Client-Secret` 请求头），`auth.ts` 需要识别 service token 的 JWT。

## 5. 客户端设计（the-world）

### 5.1 目录

```text
%LOCALAPPDATA%\WorldBase\hot\
├── current.json            # { "version": "1.5.2", "dir": "1.5.2" }
├── boot-state.json         # { "version": "1.5.2", "attempts": 0, "lastOkAt": "…" }
├── 1.5.2\                  # 解压并校验通过的 payload
│   ├── manifest.json
│   ├── app.asar
│   ├── app.asar.unpacked\
│   └── harness\
└── 1.5.1\                  # 上一版，保留一份用于回滚
```

用 `%LOCALAPPDATA%` 而不是现有 userData（Roaming）：热更新包每版 100MB 上下，不能进漫游配置。

### 5.2 Bootstrap（不可热更的那一小段）

改造 `scripts/build-main.mjs` 生成的 `main.cjs` 加载器。它是安装版本里唯一决定"加载谁"的代码，逻辑必须极薄、无依赖、不会崩：

1. 读 `hot/current.json`，不存在或解析失败则走安装版本。
2. 读该目录的 `manifest.json`，检查：`electronVersion === process.versions.electron`、`compare(manifest.version, 安装版本) > 0`、`app.asar` 存在。任一不满足则清理该目录、删 `current.json`，走安装版本。
3. 读 `boot-state.json`，若 `attempts >= 2` 且没有 `lastOkAt`，视为坏包：删目录、写回滚事件到本地队列、走安装版本。
4. `attempts += 1` 写回。
5. 设置 `process.env.WORLDBASE_HOT_RESOURCES = <hot dir>`，然后 `require('<hot dir>/app.asar/dist-electron/electron/main.cjs')`。热包里的加载器再按现有逻辑走 bytenode。

bootstrap 里不做哈希校验，那是应用阶段的事。每次启动只做存在性和版本匹配检查，保证冷启动不变慢。

### 5.3 资源路径统一

新增 `resolveResourcesPath()`：有 `WORLDBASE_HOT_RESOURCES` 就返回它，否则 `process.resourcesPath`。所有引用 `process.resourcesPath` 的地方改走它，重点是 `rust-harness-client.ts` 的 `resolveHarnessBinary()`。这样 JS 和 Rust 二进制永远来自同一个包，协议版本原子切换。

### 5.4 生效版本

新增 `getEffectiveVersion()`：热包生效时返回 manifest 的 version，否则 `app.getVersion()`。以下位置改用它：About 页显示、更新检查的 `current` 参数、`startup-report-service.ts` 上报的 `version`。`installed` 参数仍传 `app.getVersion()`。

### 5.5 UpdateService 状态机扩展

在现有状态之外加两个状态：

```text
downloaded → applying → applied   （热更新专用，applied 表示重启后生效）
```

`update-service.ts` 的流程：

1. `checkForUpdates` 切到 `/api/app-update/latest`，多传 `installed`、`electron`、`device`。响应里 `hotPayload` 存在则优先记为待下载 asset，`asset` 保留为回退项。
2. `downloadUpdate` 复用现有下载与 sha256 校验，zip 落到 `updates/<version>/`。
3. 新增 `applyHotPayload`：
   - 用 `extract-zip`（Electron 官方维护，基于 yauzl 流式解压）解到 `hot/staging-<version>/`。
   - `node:crypto` 的 `verify(null, manifestBytes, publicKey, sig)` 验 ed25519 签名。
   - 逐文件比对 sha256 与 size；目录里出现清单外文件即失败。
   - `manifest.electronVersion === process.versions.electron` 再校一次。
   - 全部通过后 `rename staging → <version>`，写 `current.json`，重置 `boot-state.json`。
   - 删除除当前和上一版之外的旧目录。
   - 状态置 `applied`，上报 `phase=applied`。
4. About 页 `applied` 状态显示"更新已就绪，重启后生效"，按钮"立即重启"调用 `app.relaunch()` 然后 `app.quit()`，走现有 before-quit 清理。
5. 任何一步失败：删 staging，上报 `phase=failed`，状态退回 `update_available` 且 asset 切换为安装包，UI 提示"将改用安装包更新"。热更新失败绝不能让用户卡住。

### 5.6 启动健康确认

`main.ts` 在主窗口 `ready-to-show` 且 Rust harness 握手成功后调用 `markHotBootOk()`：把 `boot-state.json` 的 `attempts` 归零、写 `lastOkAt`，并上报 `phase=boot_ok`（带 `fromVersion` = 安装版本）。

bootstrap 因连续失败回滚时，上报无法在 bootstrap 里发（还没起网络栈），先写到 `hot/pending-events.json`，由下一次成功启动的 UpdateService 补发 `phase=rolled_back`。

### 5.7 与完整安装包的关系

- 用户后来跑了完整安装器（比如 Electron 升级），安装版本会大于热包版本，bootstrap 第 2 步自动清掉热包。
- 服务端拿到 `installed` 和 `electron` 后能判断该设备是否还能吃热包；Electron 升级那次发版只配安装包不配热包，客户端自然走安装器。
- 安装器流程本身不变，仍是上一轮修好的直接 spawn + `--updated`。

## 6. 安全边界

- 传输：所有 URL 强制 HTTPS，`downloadUrl` 必须落在 `api.worldbase.world` 域。
- 完整性：zip 整体 sha256（来自 API）+ 逐文件 sha256（来自 manifest）+ manifest ed25519 签名（公钥内置）。三层缺一不应用。
- 版本约束：只允许升级，`manifest.version` 必须大于当前生效版本；`electronVersion` 必须严格相等。
- 路径：解压时拒绝含 `..` 或绝对路径的条目，清单外文件视为失败。
- 回滚：两次启动失败自动回退；服务端 kill switch 阻止新设备继续拿到坏包。
- 私钥轮换：公钥列表在 bootstrap 里支持多把，新旧并存一个版本周期后再移除旧的。

## 7. 缓存策略

| 对象 | 策略 |
|---|---|
| `/api/app-update/latest` | `no-store` |
| `/api/app-update/events` | 动态，不缓存 |
| 热更新 zip、manifest | R2 key 含时间戳前缀，天然不可变，可长缓存 |
| `/api/releases` | 保持现状 |

## 8. 分阶段实施

### P1：跑通 Windows 闭环

| 仓库 | 任务 | 估时 |
|---|---|---|
| worldbase-admin | 迁移脚本、`kind` 过滤、`/api/app-update/latest`、`/api/app-update/events` | 2 天 |
| worldbase-admin | 管理台热更新包表单、启用开关、灰度百分比 | 1 天 |
| the-world | `build-hot-payload.mjs` + CI 签名与产物 | 1 天 |
| the-world | bootstrap 改造、`resolveResourcesPath`、`getEffectiveVersion` | 1.5 天 |
| the-world | UpdateService 热更新分支、解压校验、About 页状态、健康确认与回滚 | 2.5 天 |
| 联调 | 真机：正常应用、签名篡改、哈希篡改、Electron 版本不匹配、连续崩溃回滚、kill switch | 1 天 |

### P2

- CI 直发（Access service token）。
- 按文件哈希去重：客户端已有的文件不重复下载，热包体积从 100MB 降到通常几 MB 到几十 MB。
- Dashboard 回滚率告警。
- macOS：解决 harness 二进制签名与公证后复用同一套 bootstrap。

## 9. 验收标准

- 1.5.0 安装版设备，服务端发布 1.5.1 热包后：检查更新提示可热更、下载、应用、重启，About 页显示 1.5.1，Rust harness 版本同为 1.5.1。
- 同一设备再发布需要 Electron 升级的 1.6.0：客户端只拿到安装包，走安装器。
- 篡改 zip 任一字节、篡改 manifest 任一字段、替换签名：客户端拒绝应用并退回安装包流程。
- 人为让热包主进程启动即崩：第三次启动自动回到 1.5.0，服务端收到 `rolled_back` 事件。
- 管理台关闭热包启用开关：新检查的设备不再拿到 `hotPayload`。
- 老版本 1.5.x 客户端与官网下载页行为完全不变。

## 10. 实施记录与上线前清单（2026-09-28）

### 10.1 已落地代码

worldbase-admin：

- `apps/api/migrations/0006_hot_payload.sql`：release_assets 加 kind/electron_version/min_base_version/manifest_json/manifest_sig/enabled/rollout_percent，新建 app_update_events 与 app_update_daily_stats。
- `apps/api/src/routes/appUpdate.ts`：`GET /api/app-update/latest`（判定 + 灰度桶 + hotPayload 组装）、`POST /api/app-update/events`（埋点 + 日聚合）。两者已加入 auth 白名单。
- `apps/api/src/routes/releases.ts`：zod 扩展、热包保存时 manifest 一致性校验、`PATCH /admin/releases/:version/:slug/control`（kill switch/灰度）、`/api/releases` 的 `?kinds=` 过滤（默认仅 installer，官网与老客户端不受影响）。
- `apps/api/src/routes/downloads.ts`：官网下载列表过滤热包；热包仍走 `/api/download/:slug` 下发计数。
- 管理台 Releases 页：产物类型选择、manifest.json/manifest.sig 上传（自动回填 Electron 版本）、每行热包的启用开关与灰度百分比；Dashboard 新增热更新统计块（applied/boot_ok/回滚率，超 10% 高亮）。

the-world：

- `apps/electron/scripts/build-hot-payload.mjs`：从 `release/win-unpacked/resources` 产出热包 zip + manifest.json + manifest.sig（ed25519，`HOT_PAYLOAD_PRIVATE_KEY`）+ 整包 sha256。
- `scripts/build-main.mjs`：main.cjs 加载器加入 `tryActivateHotPayload`（存在性/版本/Electron 匹配检查、attempts 计数、连续 2 次失败回滚并落盘 pending-events）。测试：`pnpm test:hot-bootstrap`（6 场景）。
- `src/main/app-update/hot-payload-store.ts`：hot 目录状态、`resolveResourcesPath`、`getEffectiveVersion`、公钥内置。
- `src/main/app-update/update-service.ts`：checkForUpdates 切 `/api/app-update/latest`（404 自动回退旧接口）、热包下载后自动 apply（extract-zip → 验签 → 逐文件 sha256/size 白名单 → 原子 rename → current.json）、失败回退安装包流程、`installDownloadedUpdate` 对 applied 热包执行 relaunch、事件上报（install-id 与启动上报共用，保证灰度桶稳定）、pending 回滚事件补发。
- `electron/main.ts`：ready-to-show + Rust harness 握手成功后 `confirmHotBoot()`（归零 boot-state、上报 boot_ok）。
- `electron/main-process/rust-harness-client.ts`：harness 二进制改走 `resolveResourcesPath()`，与 JS 同源。
- About 页：applying/applied 状态、"立即重启"按钮、更新徽标包含 applied。

### 10.2 三平台支持（2026-09-28 扩展）

热更新包覆盖 Windows / macOS / Linux，**同一对 ed25519 密钥三平台复用**（manifest 的 platform/arch 字段区分，服务端按 platform+arch+electronVersion 匹配）：

- 热包根目录：win `%LOCALAPPDATA%\WorldBase\hot`；mac `~/Library/Application Support/WorldBase/hot`；linux `$XDG_DATA_HOME/WorldBase/hot`（默认 `~/.local/share`）。bootstrap 与 hot-payload-store 两处实现必须保持一致。
- CI 三个 job 各自产出热包：win `release/win-unpacked/resources`（win32/x64）、mac `release/mac-arm64/WorldBase.app/Contents/Resources`（darwin/arm64）、linux `release/linux-unpacked/resources`（linux/x64）。
- 非 Windows 应用热包时对 `harness/worldbase-app-server` 兜底 chmod 0755（zip 权限元数据可能丢失）。
- 管理台发布热更新包时可同时或分别上传三个平台的 zip，各自一条 release_asset 记录；客户端只匹配自己平台的那条。

**macOS 特别注意**：热包内的原生二进制（sharp/@img 的 .node、harness 可执行文件）随打包 bundle 被 electron-builder 签名，签名嵌入在 Mach-O 文件内、解压后仍然有效；但要求热包与客户端由**同一签名身份**构建（同 CI、同一证书）。开启 Hardened Runtime + library validation 时，跨团队签名的原生库会被拒绝——发 mac 热包前务必真机验证一次。harness 独立 spawn，非隔离文件 Gatekeeper 不拦。

### 10.3 上线前必做（人工步骤）

1. **生成正式签名密钥对**（不要用开发期生成的测试密钥；三平台复用同一对）：
   ```bash
   node -e "
     const { generateKeyPairSync } = require('node:crypto');
     const { publicKey, privateKey } = generateKeyPairSync('ed25519');
     console.log('PUB:', publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
     console.log('PRIV:', privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'));
   "
   ```
   - 私钥配置到 GitHub 仓库 secret `HOT_PAYLOAD_PRIVATE_KEY`（三个平台 job 的 Build hot payload 步骤都会读取）。
   - 公钥替换 `apps/electron/src/main/app-update/hot-payload-store.ts` 的 `HOT_PAYLOAD_PUBLIC_KEYS` 并随客户端发版。
2. **应用数据库迁移**：worldbase-admin 执行 `pnpm db:migrate`（生产 `pnpm db:migrate:prod`）。
3. 真机联调按第 9 节验收标准在三个平台各走一遍（含签名篡改、Electron 版本不匹配、连续崩溃回滚、kill switch；mac 额外验证热包原生库随主程序加载不受 library validation 影响）。
