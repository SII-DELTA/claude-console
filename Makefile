SHELL := /usr/bin/env bash

.PHONY: help start stop status restart dev pair test \
        web web-start web-stop web-restart web-status \
        agent agent-start agent-stop agent-restart agent-status \
        backend backend-start backend-stop backend-restart backend-status \
        daemon daemon-stop

help:
	@echo "正式运行（生产构建 next build + next start，远程/常驻用这个）："
	@echo "  make start          构建并起 local-agent(:7345) + web(:3005)"
	@echo "  make stop           停掉两者"
	@echo "  make restart        重新构建并重启两者（部署新代码用）"
	@echo "  make status         查看进程状态"
	@echo ""
	@echo "本地调试："
	@echo "  make dev            起 next dev（热更新，仅本机调试，勿走公网）"
	@echo "  make test           跑全部测试（shared + local-agent + web）"
	@echo ""
	@echo "单独控制："
	@echo "  make web | make agent          重启单个服务（web 为生产构建）"
	@echo "  make web-stop | make agent-stop 停单个服务"
	@echo ""
	@echo "常驻 / 打包："
	@echo "  make daemon         把 agent 装成 launchd 守护进程（MAC_AGENT_BIND=<ip> 可暴露到 Tailscale）"
	@echo "  make daemon-stop    卸载守护进程"
	@echo ""
	@echo "连上后：浏览器开 http://localhost:3005，服务器地址填 http://127.0.0.1:7345"
	@echo "（设了 MAC_AGENT_PASSWORD/.env 则登录页输密码）"

# 正式：生产构建
start:
	@WEB_MODE=prod bash scripts/dev-control.sh start all
	@echo "" && echo ">>> 打开 http://localhost:3005"

stop:
	@bash scripts/dev-control.sh stop all

restart:
	@WEB_MODE=prod bash scripts/dev-control.sh restart all
	@echo "" && echo ">>> 打开 http://localhost:3005"

status:
	@bash scripts/dev-control.sh status all

# 本地调试：next dev 热更新
dev:
	@WEB_MODE=dev bash scripts/dev-control.sh restart all
	@echo "" && echo ">>> 本地调试 http://localhost:3005（dev 模式，勿走公网）"

pair:
	@grep pairCode .logs/local-agent.log 2>/dev/null | tail -1 | sed -E 's/.*"pairCode": *"?([0-9]+)"?.*/\1/' \
	  || echo "（未找到，agent 可能没在跑：make agent）"

test:
	@pnpm test

web web-start web-restart:
	@WEB_MODE=prod bash scripts/dev-control.sh restart web

web-stop:
	@bash scripts/dev-control.sh stop web

web-status:
	@bash scripts/dev-control.sh status web

agent agent-start agent-restart backend backend-start backend-restart:
	@bash scripts/dev-control.sh restart agent

agent-stop backend-stop:
	@bash scripts/dev-control.sh stop agent

agent-status backend-status:
	@bash scripts/dev-control.sh status agent

daemon:
	@bash scripts/install-daemon.sh

daemon-stop:
	@bash scripts/uninstall-daemon.sh
