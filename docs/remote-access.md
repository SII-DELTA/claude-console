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

## 安全注意

- 流量经 Tailscale WireGuard 端到端加密，不暴露到公网。
- agent 默认只绑回环，靠 `MAC_AGENT_BIND` 显式放行到 Tailscale 接口，**不要绑 `0.0.0.0`**。
- 即便在私有 tailnet 内，也建议设 `MAC_AGENT_PASSWORD`（tailnet 内有其他人/设备时尤为必要）；token 可在 `/devices` 吊销。

## 可选：tailnet 内 HTTPS

tailnet 流量已加密，一般无需 TLS。若想要 `https://` 地址（避免浏览器对 http 的限制），
可用 [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve) 为 MagicDNS 主机名签发 tailnet 证书：

```bash
tailscale serve --bg 3005    # 把本机 3005 以 https 暴露在 tailnet 内
```
