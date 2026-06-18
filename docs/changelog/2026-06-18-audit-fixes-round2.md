# 第二轮全面审计修复(A–O 全修)

- 日期: 2026-06-18
- 来源: 三路并行二次审计(对抗性验证上轮修复 + 扫未覆盖文件 + 端到端竞态)。
- 前置结论: 上一轮 10 处修复经逐条 reproduce **全部验证通过,零回归**。

## Batch 1 — 后端泄漏/限额/安全(commit 4e33f48)
- A `titleOf`/`lastSent` Map 加上限+过期清理(`session:deleted` 删 titleOf)。
- B `/asr` 加 2MB(base64)上限,防刷腾讯云 ASR 配额/费用。
- J 绑定非 loopback 且无 `MAC_AGENT_PASSWORD` → 启动醒目告警(开放 RCE)。
- M `/usage` 移出免鉴权路径(配额泄漏;客户端 post-login 带 token 调用,不受影响)。

## Batch 2 — 前端状态/竞态(commit dc57779)
- C `selectSession` 清 `sendStatus`(跨会话 receipt 残留)。
- D 新建会话拿到 id 后补 `revalidateTail`,回收 id 采纳前被丢的 `claude_message`。
- E driving 闪烁:`claude_driving` 记时间戳,2s 内 `session_updated` 快照不回退 driving。
- H `syncTail` cursor 取 `Math.max`,不被晚到响应回退到 endTurn 之前。
- I `loadSessions`/`loadAllSessions` 在途守卫,回前台+轮询不并发重复扫描。
- O `findPendingQuestions` 返回稳定 `toolUseId`,picker key 用它。

## Batch 3 — 收敛守卫/SW/调试/卸载(本提交)
- F 重连期 `refreshPendingPermission` 用 `recentlyCancelled` 拦截,不复活已取消的问题。
- G `session_updated` 的 attention 清理加 `pickerSetAt<1500ms` 守卫,不误清刚弹的 picker。
- K `sw.js` 用 `URL.searchParams.get("s")` 精确匹配(`includes` 会让 `s=abc` 命中 `s=abcd`)。
- L `debug-log` 加 capturing 开关:关闭即停止记录(patch 永久但不再增长);ring buffer 用 `shift()` 不再每次 `slice` 重建。
- N `Composer` 转写加 `mounted` ref 守卫,卸载后不 setState。

## 验证
- shared 构建 / local-agent typecheck + 119 测试 / web typecheck + 22 测试,全过。

## 说明
F/G 为保守"加守卫"式修复(只在窄窗口跳过某次 set/clear),最坏退化为原自愈行为,不会更糟。E 的 driving 防抖很可能同时改善了此前"运行中判断不准"的残留观感。
