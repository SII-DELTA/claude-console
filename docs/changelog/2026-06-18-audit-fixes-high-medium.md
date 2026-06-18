# 全面审计修复(高危+中危 1–10)

- 日期: 2026-06-18
- 来源: 三路并行代码审计(后端/前端状态/UI),核验后修复已确认的高+中危项。

## Batch A — 前端连接/同步(commit 2d4e674)
- **重连风暴**:`connectWs` 清待重连定时器;`onClose` 仅当死的是当前 socket 才重连 → 消除"每次连接 3s 后自杀重连"。
- **跨会话流式误判**:`isStreamSession` 不再把 `selectedId` 当流式判据(仅新会话 id 未采纳时用)。
- **resume 三事件重复**:`handleVisible` 800ms 合并 visibilitychange/online/pageshow。
- **游标残留**:`selectSession` 切会话即重置 `tailCursor`。

## Batch B — 后端 IO/安全(commit d9c5b13)
- **readRange 短读**:循环读满 + 只解码实读字节,消除零字节 NUL 损坏 JSON 行。
- **getSession 双读**:`foldFile` 顺带返回 consumedOffset,不再二次全量读。
- **metaCache 失效**:缓存键加 `size`,同毫秒追加 mtime 不变也能失效。
- **preview symlink 逃逸**:`realpath` 解析后再校验子树,堵住 cwd 内符号链接读任意文件(已验证:cwd 内 symlink→/etc/hosts 返回 403)。

## Batch C — UI(本提交)
- **弹层 key**:QuestionPanel/ToolApprovalPanel 加 `key`(requestId / 问题指纹),避免跨提问复用导致 selected/active 残留、提交到错选项、不闪烁不滚动。
- **Dashboard 滑动**:`swipeStart` 改 `useRef`,避免 touchstart→touchend 间重渲染重置起点 → 误触发跨项目切换。

## 验证
- shared 构建 / local-agent typecheck + 119 测试 / web typecheck + 22 测试 全过。
- agent 重启后:正常 preview 200、`../` 穿越 403、cwd 内 symlink 403、tail 接口 200。

## 未做(用户选择本轮只修 1–10;低危单列)
- 11 looksLikePath 误报收紧、12 recoverAnswerPermission 失败回滚、13 Timeline key/useMemo 重构、14 弹层可访问性(role/Esc)。
