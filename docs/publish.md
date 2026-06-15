# 发布

本项目为纯 Web 方案，只需部署 `apps/web`（前端控制台）与 `local-agent`（本地服务）。

## Web 控制台 (apps/web)
```bash
pnpm --filter @mac/web build
pnpm --filter @mac/web start    # :3005，任何 Node 主机均可运行
```
个人自用通常与 local-agent 同机起，经 Tailscale 直连访问（见 [remote-access.md](remote-access.md)）。

## 本地 Agent (local-agent)
跑在你自己的电脑上，把 agent 装成 launchd 守护进程：
```bash
MAC_AGENT_PASSWORD=<password> MAC_AGENT_BIND=<tailscale-ip> ./scripts/install-daemon.sh
```
详见 [remote-access.md](remote-access.md)。

## 手机端
无需安装包：手机浏览器打开部署好的 web，iOS Safari / Android Chrome「添加到主屏幕」即可当 App 用。
