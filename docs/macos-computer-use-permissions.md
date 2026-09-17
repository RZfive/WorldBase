# macOS 安装版电脑使用权限

## 已确认的行为与边界

- Electron 主进程使用 `systemPreferences.getMediaAccessStatus('screen')` 和 `isTrustedAccessibilityClient(false)` 读取**当前进程**的授权，而不是按 WorldBase 显示名称读取系统列表。权限仅在启动时读取一次，聊天切换、打开设置、窗口聚焦均不轮询 TCC。
- 开发启动使用 `Electron.app`；安装版使用自己的 `com.theworld.app` 身份。修改 `app.setName`、`appId` 或添加 `Info.plist` 用途说明不会把开发环境的授权迁移给安装版。
- `mac.extendInfo` 已包含屏幕录制与辅助功能用途说明，不需要通过关闭 hardened runtime、增加全盘访问或修改 TCC 数据库解决。
- Apple Silicon 本地包在未配置证书时可以退回 ad-hoc 签名。它的 designated requirement 可能直接绑定构建的 cdhash；替换应用后，系统列表中的旧勾选不能作为新构建已获授权的依据。实际使用仍以 OS API 和截图/输入后端的检查为准。
- “去授权”会在用户点击后请求缺失的系统权限。屏幕录制通过 Electron `desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })` 触发请求，不保存或传递来源内容；不能只打开设置页，也不能把成功列出来源当作授权成功。
- 两个独立的权限入口可以直接打开对应设置，避免录屏启动快照仍为拒绝时一直跳不到辅助功能。任何授权结果都不会伪造为 `granted`，UI 仍需完全退出并重启才能重读。

## 当前已安装版本的恢复步骤

1. 完全退出开发版及安装版（macOS 使用 **⌘Q**，关闭最后一个窗口并不会退出主进程）。
2. 将新 `WorldBase.app` 安装到 `/Applications`，从这里启动，不要从 DMG、旧构建目录或另一份同名应用启动。
3. 在 WorldBase → 设置 → 通用 → 执行 → 电脑使用权限检查显示的**当前运行的应用路径**。如果系统已勾选但应用仍显示缺少权限，完全退出后，在系统设置 → 隐私与安全性中的**屏幕与系统音频录制（屏幕录制）**、**辅助功能**分别移除旧的 WorldBase 条目，再重新添加 `/Applications/WorldBase.app` 并开启开关。
4. 若录屏列表没有当前应用，启动安装版后点击“屏幕录制”或“去授权”以触发系统登记，再按系统提示授予权限。拒绝或请求失败仍会打开系统设置页。
5. 完成两项授权后，再次 **⌘Q** 并从 `/Applications` 重开。确认两项权限均已允许，再验证一次 `computer_observe` 和一个明确允许的小范围输入操作。

不要给另一个 Electron/Terminal/Rust helper 授权来掩盖安装版缺少授权。不要重置全部应用的 TCC 记录；以上恢复操作只针对 WorldBase。代码不会自动移除授权、修改系统设置或提升权限。

## 打包与签名

已有命令仍支持无证书的本地调试包：

```sh
pnpm electron:build:mac:arm64
```

`afterSign` 钩子使用 `/usr/bin/codesign -d --verbose=4 -r-` 检查**产物本身**。缺少 team-backed 签名时会打印授权失效与恢复说明，不会替用户关闭系统安全检查。

正式发布需要在构建环境配置同一团队的 **Developer ID Application** 签名证书及私钥，再使用严格入口：

```sh
# 先检查可用身份（不输出私钥）
security find-identity -v -p codesigning

# 可由 electron-builder 自动选择有效证书，也可用 CSC_NAME / CSC_LINK 配置
pnpm electron:build:mac:arm64:signed
```

该入口设置 `mac.forceCodeSigning=true`、`mac.type=distribution`，找不到有效证书会失败；签名后检查也会拒绝 ad-hoc / 无团队身份的产物。它不自动创建证书，也不替代发行所需的公证配置。不要固定一个没有证书支撑的 designated requirement 来“沿用”授权。

只读检查当前安装：

```sh
codesign -d --verbose=4 -r- /Applications/WorldBase.app
codesign --verify --deep --strict /Applications/WorldBase.app
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' /Applications/WorldBase.app/Contents/Info.plist
```

关注 `Signature=adhoc`、`TeamIdentifier=not set`、`designated => cdhash ...`，以及路径是否确实指向用户授权的那份应用。有效的文件签名验证与 TCC 授权是两件事，验证通过不代表已得到用户许可。

## 回归验证

```sh
pnpm --dir apps/electron test:computer-use-permissions
pnpm electron:typecheck
pnpm --dir apps/electron build
pnpm --dir apps/electron build:electron:bytecode
```

自动化测试覆盖启动只读一次、每项检查独立失败、开发/安装/DMG/转移路径、明确授权请求、拒绝后的设置入口、并发点击合并、独立权限入口、非 macOS 分支与打包签名检查。单元测试使用模拟权限宿主，**不能代替安装到 `/Applications` 后的真人授权与重启复测**。
