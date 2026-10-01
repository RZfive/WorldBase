# 安全政策 / Security Policy

## 报告漏洞 / Reporting a Vulnerability

**请不要通过公开 issue、讨论或 PR 报告安全漏洞。**
**Please do not report security vulnerabilities through public issues, discussions, or pull requests.**

请使用 GitHub 私密漏洞报告：
Please use GitHub's private vulnerability reporting:

**https://github.com/RZfive/the-world/security/advisories/new**

或在仓库页面的 **Security** 标签页点击 **Report a vulnerability**。
Or open the repo's **Security** tab and click **Report a vulnerability**.

- 响应时间：我们会在 **7 天内**确认收到报告，并尽快评估与修复。
- 修复进度会通过私密渠道与你同步；修复发布后会在 advisory 中致谢（除非你希望匿名）。
- 支持中文或英文报告。
- We aim to acknowledge reports within 7 days and will keep you updated through the private channel.

## 支持版本 / Supported Versions

| 版本 / Version | 支持情况 / Supported |
| --- | --- |
| main / 最新发布 | ✅ |
| 其他历史版本 | ❌ |

## 报告范围说明 / Scope Notes

以下攻击面尤其欢迎报告（不限于）：

- LAN Server（局域网服务、代理与鉴权）
- Computer Use（屏幕捕获、辅助功能/输入注入的权限边界）
- IM Gateway（webhook 验签、加密与凭据处理）
- 子项目进程管理与运行时隔离
- Rust Agent Loop 与 app-server / mobile-ffi 的进程间通信（stdio JSON-RPC / loopback WS）
- 热更新 payload 的签名校验与分发

一般性使用问题请改用 [GitHub Issues](https://github.com/RZfive/the-world/issues)。
