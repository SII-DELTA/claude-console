# 本地开发启停与前端错误修复 Spec

## 背景

当前项目缺少统一的本地启停入口。Web dev server 和 local-agent 容易残留旧进程，Next.js `.next` 缓存也可能在重构或构建切换后出现缺失 chunk，例如 `Cannot find module './240.js'`。

## 目标

- 增加 Makefile，提供前端、local-agent、整体开发环境的启动、停止、重启入口。
- 启动命令统一实现为 restart：先停止残留进程，再启动。
- stop 通过 `lsof` 与 `ps` 查找端口和命令行匹配的进程并杀掉。
- 在 `scripts/` 下实现 bash 辅助脚本，Makefile 调用脚本，不把复杂逻辑写进 Makefile。
- 修复当前 Web 打开时报错的问题，并完成浏览器验证。

## 非目标

- 不引入新的进程管理器。
- 不做生产部署脚本。

## 验收标准

- `make web` 能重启前端并修复 `.next` 缓存错误。
- `make agent` 能重启 local-agent。
- `make dev` 能同时重启 Web 与 local-agent。
- `make stop` 能停止 Web 与 local-agent。
- 浏览器打开 `http://127.0.0.1:3005/` 无 Next.js server error。
