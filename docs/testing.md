# 测试策略

## 各模块单测

| 模块 | 工具 | 数量 |
| --- | --- | --- |
| `@mac/shared` | vitest | 15 |
| `@mac/local-agent` | vitest（forks/singleFork） | 74 |
| `@mac/web` | vitest + jsdom + RTL | 18 |

跑全部：

```bash
pnpm test
```

## 端到端冒烟

```bash
pnpm --filter @mac/local-agent dev   # 终端 A，记下 pairCode
PAIR_CODE=12345678 ./scripts/e2e-smoke.sh
```

依次验证：`/health` → 配对 → 创建会话 → 发送 stdin → 拉日志 → 删除。

## CI 建议

* GitHub Actions：
  1. `pnpm install --frozen-lockfile`
  2. `pnpm typecheck && pnpm lint && pnpm test`
* better-sqlite3 native binding 需在 CI 缓存或允许 build script。
