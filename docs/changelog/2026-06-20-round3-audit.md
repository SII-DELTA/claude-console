# Change Log — 第三轮漏洞/性能排查与修复

日期: 2026-06-20
范围: local-agent 后端 + web 控制台(全栈安全/性能审计 + 一处用户报障)

## 背景

用户要求"继续排查漏洞和性能问题"。并行派两个审计 agent(后端安全/DoS/性能、前端泄漏/轮询/渲染),核实发现后按 A/B/C/D 四个桶全量修复;期间用户报告"跨项目会话点击打开 404",一并修复。

## A 安全高危(commit 2085b82)

- `/files/preview` 加 cwd 白名单:cwd 必须等于或位于某个已知项目之下。此前仅校验 path 不逃出 base,但 base=resolvePath(cwd) 本身无约束,传 `cwd=/`、`path=etc/passwd` 即任意文件读。
- `runtime`:`noAuth && 绑定非环回` 从"仅警告"改为"拒绝启动"(fail-closed),配置失误不再静默暴露等同 RCE 的开放端口;确需开放须显式 `MAC_AGENT_ALLOW_OPEN=1`。

## 清理(未提交内容)

- 删除嵌套陈旧克隆 `agent_console/claude-usage-statusbar/`(停在旧提交、无 injectServer、真身在同级已推送)。
- 删除已被 ide-control.ts 内联 osascript 取代的 `scripts/ide-inject.applescript`。

## B 前端性能(commit 9c0d0cb)

- 轮询省电省流量:page.tsx slow(20s)/fast(4s) 两个 interval 与 useUsage(60s)在 `document.hidden` 时短路;resume 由 handleVisible/visibilitychange 补拉。
- 流式不再抖动:`Timeline` 用 `useMemo([messages])` 只在消息变化时重建,`memo` 包裹组件;page.tsx 用 `useCallback` 稳定 onFillInput/onOpenFile。逐 token 不再重跑 O(n) buildTimeline 或重渲染整条历史。
- `Console` 改用 `useShallow` 切片订阅:无关 store 写入(如逐 token 的 tail 游标)不再触发大组件重渲染。

## C 限流 / 防烧 token(commit 31705ec)

- 新增 `rate-limit.ts`(进程内固定窗口,按 token 或 IP 分桶,自动清理)。
- 计费/高耗路由限流:POST /claude/sessions(10/min)、:id/continue(30/min)、/asr(30/min)、/push/test(10/min);WS client:create_session 每设备 20/min。超限 429。
- WS 背压:broadcast 检查 bufferedAmount,慢客户端(>1MB)丢帧(WS 仅 hint,客户端经 HTTP 字节游标补齐),僵尸(>8MB)terminate。
- 新增 rate-limit 单测(3 例)。

## D 中低危 + 用户报障(commit 31e296b, 661e767)

- **跨项目会话点击打开 404(用户报告)**:根因是 getSession/tail/isLive/sessionFileSize/getOpenQuestionIds/refreshSession 都按"活动项目目录"定位文件,但仪表盘/会话列表是跨项目聚合。新增 `resolveSessionFile(id)`:活动目录快路径 → 缓存 → 跨所有项目目录扫描,结果缓存。上述读路径全部改用。加跨项目回归测试。
- foldFile 读失败:非 ENOENT 错误打印告警而非静默返回空会话。
- auth token 闲置过期:默认 90 天未使用自动吊销,活跃设备滑动续期;可经 tokenIdleTtlMs 配置。
- ide:ancestryInVscode 裸 'Code' 匹配锚定为路径 basename,不再误判无关进程。
- 暂缓:getSession 的 limit 仍整份 fold(真正字节游标反向分页涉及 tool_use↔result 跨页配对正确性,风险较高),留作后续。

## 验证

- agent + web typecheck 干净;agent 测试 123 通过;web build 成功。
- 运行时:用户报障会话 `e9b24c31` 由 404 → 200(total 2439);`/files/preview cwd=/` → 403,合法项目文件 → 200,越界 → 403;`/push/test` 第 11 次 → 429。

## 影响范围

- 后端:http-server、runtime、claude-store、auth-manager、ws-bridge、ide-control、新增 rate-limit。
- 前端:page.tsx、Timeline.tsx、useUsage.ts。
- 无功能回归(全程 typecheck + 测试 + build 验证)。
