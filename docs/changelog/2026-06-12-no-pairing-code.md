# 2026-06-12 免配对码直连

## 改动概述
移除配对码（pairCode）和令牌（token）认证机制，实现 web 端与 local-agent 的直接连接。

## 改动文件

### 1. `apps/web/components/ConnectForm.tsx`
- **移除**：配对码输入框及相关UI
- **移除**：`pair()` API 调用和配对逻辑
- **改为**：直接调用 `health()` 端点验证连接
- **修改**：提交连接时 `token` 字段设为空字符串

### 2. `packages/local-agent/src/http-server.ts`
- **禁用**：请求认证中间件 `addHook("onRequest", ...)`
- **影响**：所有 HTTP 端点无需提供 `Authorization` header
- **保留**：FREE_PATHS 常量定义供日后参考

### 3. `packages/local-agent/src/ws-bridge.ts`
- **移除**：WebSocket upgrade 事件中的 token 验证逻辑
- **改为**：直接升级所有连接请求，deviceId 固定为 `"web-client"`
- **变化**：跳过 `AuthManager.verifyToken()` 调用

## 核心改动细节

**前**（配对码流程）：
```
1. Web 页面显示配对码输入框
2. 用户输入 8 位配对码 + 服务器地址
3. POST /auth/pair { pairCode, deviceName, platform } 获取 token
4. 保存 token，建立 WebSocket 连接时附加 ?token=...
5. 服务器验证 token，升级连接
```

**后**（直连流程）：
```
1. Web 页面仅显示服务器地址输入
2. 用户输入地址，点击「连接」
3. GET /health 验证服务器可达性
4. 直接建立 WebSocket 连接（无 token 参数）
5. 服务器接受所有连接请求
```

## 影响范围

### 安全性影响
⚠️ **明显降低**：移除了设备认证，任何能访问 local-agent 端口的客户端均可连接。

**仅适用于以下场景**：
- 本地局域网使用（防火墙隔离外网）
- 完全信任的网络环境
- 开发/测试环境

### 用户体验改进
✅ **简化连接流程**：
- 减少输入步骤（无需配对码）
- 移除配对码的 5 分钟 TTL 限制
- 页面加载后立即可连接

## 验证结果

- ✅ ConnectForm 可正常渲染，仅显示服务器地址输入
- ✅ health() 端点仍可访问（无认证）
- ✅ WebSocket 握手成功，直接接收 `server:hello` 消息
- ✅ 浏览器开发者工具确认 WebSocket 连接无 `?token=` 参数

## 后续可选操作

1. **恢复认证**：若需要安全性，可改为 IP 白名单 + HTTP Basic Auth
2. **简化认证**：可替换为固定密钥或环境变量认证
3. **清理死代码**：`AuthManager`、`HistoryStore` 的认证相关逻辑仍存在，可在确认不需要后删除
