# 远程接入（Tailscale 直连 + launchd）

目标：人在外面，用手机/电脑浏览器经 **Tailscale** 直接接管家里 **Mac** 上的 Claude Code。
无需公网服务器、无需反向代理。

```
浏览器(手机/电脑, 同一 tailnet) ──Tailscale(WireGuard 端到端加密)──▶ Mac(local-agent:7345 + web:3005 + claude)
```

- 手机和 Mac 装同一个 Tailscale 账号（同 tailnet），流量走 WireGuard 加密，不经过公网。
- 不用租服务器、不暴露公网端口、不需要 TLS（tailnet 本身已加密）。

## 1. Mac：常驻 agent 并绑定到 Tailscale

```bash
# 装好 Tailscale，记下 Mac 的 tailnet IP
tailscale ip -4

# 把 agent 装成 launchd 守护进程，绑定到该 IP
MAC_AGENT_PASSWORD=<your-password> MAC_AGENT_BIND=$(tailscale ip -4) \
  ./scripts/install-daemon.sh /path/to/your/workspace
# 守护进程：开机自启、KeepAlive。日志在 ~/.mac-agent/agent.{out,err}.log
```

`MAC_AGENT_BIND` 让 agent 监听 `<mac-tailscale-ip>:7345`（默认仅 `127.0.0.1`，不裸暴露）。
web（`next start -p 3005`）默认绑所有网卡，在 tailnet IP 上即可访问，无需额外配置。

> 卸载：`./scripts/uninstall-daemon.sh`

## 2. 起 web（与 agent 同机）

```bash
# Mac 上，生产模式
make start        # 或 WEB_MODE=prod ./scripts/dev-control.sh start all
# web → :3005，agent → :7345
```

## 3. 手机/电脑直连访问

手机装好 Tailscale 并登录同一 tailnet 后：

1. 浏览器打开 `http://<mac-tailscale-ip>:3005`（用 MagicDNS 更顺手：`http://<主机名>:3005`）
2. 「服务器地址」填 `http://<mac-tailscale-ip>:7345`
3. 若 agent 设了 `MAC_AGENT_PASSWORD`，登录页一并输入该密码
4. iOS Safari / Android Chrome 可「添加到主屏幕」当 App 用，无需安装包

> 注：纯 http 访问下**语音输入不可用**（浏览器麦克风需 HTTPS），需要语音见下文
> 「语音输入需要 HTTPS」。

## 安全注意

- 流量经 Tailscale WireGuard 端到端加密，不暴露到公网。
- agent 默认只绑回环，靠 `MAC_AGENT_BIND` 显式放行到 Tailscale 接口，**不要绑 `0.0.0.0`**。
- 即便在私有 tailnet 内，也建议设 `MAC_AGENT_PASSWORD`（tailnet 内有其他人/设备时尤为必要）；token 可在 `/devices` 吊销。

## 语音输入需要 HTTPS（tailscale serve）

tailnet 流量本身已加密，普通使用无需 TLS。但**语音输入**例外：浏览器的 `getUserMedia`
（麦克风）只在**安全上下文**（HTTPS 或 localhost）下可用，`http://<tailscale-ip>:3005`
是普通 http，麦克风会被禁用。要用语音，就得给 web 一个 `https://` 地址。

Tailscale 自带 HTTPS：通过 [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
为 MagicDNS 主机名签发真证书（Let's Encrypt 的 `*.ts.net`），无需自有域名。

**0. 一次性**：管理后台 → DNS → 启用 **MagicDNS** 和 **HTTPS Certificates**。

**1. 把 web 和 agent 都用 HTTPS 暴露**（两个 https 端口，避免「HTTPS 页面连 http agent」的混合内容拦截）：

```bash
tailscale serve --bg --https=443  localhost:3005   # web  → https://<host>.<tailnet>.ts.net
tailscale serve --bg --https=8443 localhost:7345   # agent→ https://<host>.<tailnet>.ts.net:8443
tailscale serve status                              # 查看；tailscale serve reset 清空
```

**2. 手机**：浏览器开 `https://<host>.<tailnet>.ts.net`（HTTPS → 麦克风可用）。
在 `*.ts.net` 下前端会**自动**把「服务器地址」设为同主机的 `:8443`（即 agent 的 serve 端口），
无需手动输入。两端都是 HTTPS，WS 自动走 `wss://…:8443/ws`，无混合内容、无跨域（agent 默认 `CORS=*`）。

> 自动识别逻辑在 `apps/web/components/ConnectForm.tsx` 的 `defaultAgentUrl()`：
> `https://*.ts.net` → `https://<同主机>:8443`。若 serve 用了别的端口或同源 `/agent`，手动改地址即可。

> **更简洁的备选（同源）**：把 agent 挂到同一域名的 `/agent` 路径，正好匹配前端内置的
> `<origin>/agent` 默认值（连服务器地址都不用填）：
> ```bash
> tailscale serve --bg --https=443                   localhost:3005
> tailscale serve --bg --https=443 --set-path=/agent localhost:7345
> ```
> 起完用 `curl https://<host>.<tailnet>.ts.net/agent/health` 验证 `/agent` 前缀被正确剥离；
> 不剥就退回上面的双端口方案。

> **仅桌面调试**：Chrome 可在 `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
> 把 `http://<tailscale-ip>:3005` 加白名单临时启用麦克风——**手机无效**。
