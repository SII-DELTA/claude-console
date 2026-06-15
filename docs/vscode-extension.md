# VS Code 插件（已移除）

新架构不再依赖 VS Code。Claude Code 是终端 CLI，local-agent 直接读 `~/.claude/projects`
并用 `claude` CLI 驱动，因此插件已删除，agent 改为 launchd 守护进程常驻。

* 启动常驻：`scripts/install-daemon.sh`，详见 [remote-access.md](remote-access.md)
