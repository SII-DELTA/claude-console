# Change Log — web 区分正式/调试运行，公网慢根因修复

日期: 2026-06-13

## 背景

公网打开页面很慢（~15-20s）。实测定位：**并非网络或 ASR SDK**，而是 web 一直跑在 `next dev` 开发模式——产物未压缩未打包，单页要搬 ~10MB JS（`main-app.js` 6.2MB 经公网耗时 12.1s）。Makefile 此前没有 dev/prod 之分，`make start` 与 `make dev` 都走 `next dev`。

## 改动文件

- `scripts/dev-control.sh`
  - 新增 `WEB_MODE`（默认 `prod`）。
  - `start_web` 拆为 `start_web_prod`（`pnpm --filter @mac/shared build` → `next build` → `next start`，dist=`.next`）与 `start_web_dev`（`next dev`，dist=`.next-dev`）。
  - `stop_web` 的 kill 模式匹配 `next (dev|start)`，两种模式都能停。
  - restart 流程移除 `clean_web_cache`（dev 分支自清 `.next-dev`；prod 用增量构建不应清），删除该函数。
- `Makefile`
  - `make start / restart`：正式，`WEB_MODE=prod`（构建 + next start）。
  - `make dev`：本地调试，`WEB_MODE=dev`（next dev 热更新），从原 `start dev:` 合并目标中拆出。
  - `make web`：单独重启 web 也走 `WEB_MODE=prod`。
  - help 文案区分「正式运行 / 本地调试」。

## 核心变更

- 引入 dev↔prod 运行维度：`start/stop/restart/status` = 正式（生产构建），`dev` = 本地调试。
- prod 与 dev 用不同 dist 目录（`.next` / `.next-dev`），互不干扰，切换无需手动清缓存。

## 影响范围

- 仅本地运行/部署脚本；应用代码、agent、Caddy 均未改。
- `make start/restart` 首次或改代码后会多 ~30-60s 构建时间。
- Next `next start` 默认 `compress:true`，响应自动 gzip。

## 验证结果（公网同一链路实测）

| 指标 | dev（旧） | prod（新） |
|---|---|---|
| 总传输量 | ~10 MB | ~194 KB（gzip） |
| 最大单文件耗时 | 12.1s（6.2MB） | <1.2s |
| 预估整页加载 | 15-20s | ~1-2s |

- `next build` 通过，首屏 First Load JS 149 kB。
- 生产模式起服务后，公网各资源均 <1.2s，`content-encoding: gzip` 已生效。
