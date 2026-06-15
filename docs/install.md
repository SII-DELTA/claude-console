# 安装 & 运行

## 1. 系统依赖

| 依赖 | 推荐版本 |
| --- | --- |
| Node.js | ≥ 20（22 LTS 推荐） |
| pnpm | 10.x（仓库已锁 10.33.2，由 corepack 管理） |
| `claude` CLI | 已登录（agent 复用本机凭据） |

```bash
brew install node@22
corepack enable
corepack prepare pnpm@10.33.2 --activate
```

## 2. 拉代码并安装

```bash
git clone <repo>
cd claude-console
pnpm install                      # 工作区 (packages/* + apps/web)
cp .env.example .env              # 按需设置 MAC_AGENT_PASSWORD
```

## 3. 本地联调

```bash
./scripts/dev.sh
# local-agent: 127.0.0.1:7345
# web:         http://localhost:3005
```

浏览器打开 <http://localhost:3005>，「服务器地址」填 `http://127.0.0.1:7345`；
若设置了 `MAC_AGENT_PASSWORD`，登录页一并输入该密码。

## 4. 跑全部测试

```bash
pnpm test     # shared + local-agent + web
```

## 5. 构建产物

```bash
pnpm --filter @mac/web build      # → apps/web/.next
pnpm -r --filter "./packages/*" build
```
