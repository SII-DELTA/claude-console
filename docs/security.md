# 安全

## 威胁模型

* 攻击者位于同一局域网：agent 默认仅绑回环，不在 LAN 上监听，探测不到。
* 同一 tailnet 内的其他人/设备：能到达 `<tailscale-ip>:7345`，需密码 + 长 token 才能访问。
* 公网：不直接暴露——访问只经 Tailscale（WireGuard 端到端加密）。

## 鉴权

* **密码登录**：设置 `MAC_AGENT_PASSWORD` 后，web 登录页输入密码，POST `/auth/login`
  常量时间比对成功后签发长期 token。**任何暴露到回环以外的部署都必须设置密码。**
* token：256-bit URL-safe；存储于 SQLite `devices` 表，可吊销（`DELETE /devices/:id`）。
* REST 用 `Authorization: Bearer <token>`；WS 用 `?token=` 首帧校验，非法帧立即关闭（4001）。
* 失败限速：登录/配对 5 次/分钟锁定。
* `MAC_AGENT_NO_AUTH=1` 仅供纯本机（回环）便捷调试，设了 `MAC_AGENT_PASSWORD` 时被忽略。

## 监听与暴露

* 默认仅监听 `127.0.0.1`（不裸暴露）。
* `MAC_AGENT_BIND=<tailscale-ip>` 显式放行到 Tailscale 接口；**不要绑 `0.0.0.0`**。

## 输入安全

* 所有 REST/WS 入口使用 zod schema 严格校验；多余字段被剥离。
* `claude` CLI 在用户指定的 workspace 下以 headless 模式运行，权限模式由 `CLAUDE_PERMISSION_MODE` 控制。

## OWASP 关注项

| 项 | 处理 |
| --- | --- |
| A01 失效访问控制 | 密码登录 + Bearer token，token 可吊销 |
| A02 加密失效 | 传输经 Tailscale WireGuard 端到端加密（无需自建 TLS） |
| A03 注入 | zod 校验 + better-sqlite3 prepared statements |
| A05 安全配置错误 | 默认仅监听 `127.0.0.1`（`MAC_AGENT_BIND` 显式放行） |
| A07 身份失败 | 登录限速（5 次/分钟）+ token revoke |

## 部署建议

* 远程访问走 Tailscale 直连，仅向受信 tailnet 暴露 7345，并设置 `MAC_AGENT_PASSWORD`；不要绑 `0.0.0.0` 或暴露公网。
* 上线前关闭 verbose error 日志。
* 定期 `DELETE /devices/:id` 吊销旧设备 token。
