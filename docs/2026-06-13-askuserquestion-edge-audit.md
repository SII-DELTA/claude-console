# AskUserQuestion 选择器全链路边界条件审计

- 日期: 2026-06-13
- 目的: 逐一核对 AskUserQuestion（A 兜底 / B 控制协议 / 持久化恢复 / 忽略 / 取消）
  的边界条件是否都有处理，避免静默丢弃或卡住。

图例：✅ 已处理 ｜ ⚠️ 已知取舍/可接受 ｜ 🔧 本次修复

## 驱动 / 控制协议
- ✅ can_use_tool 缺 questions → deny 提示。
- ✅ 非 AskUserQuestion 的 ask → deny（零回归）。
- ✅ 未知 control_request subtype → 回空 success，避免 CLI 卡住。
- ✅ control_response（我们 initialize 的回包）→ 忽略。
- ✅ control_cancel_request → 删内存+持久 + 广播 cancel。
- ✅ 畸形 control_request（无 request_id）→ 消费但不误当流事件。
- 🔧 答复时 stdin 写失败（进程刚死）→ 不删记录、返回 false → HTTP 回退恢复路径，
  答案不丢。
- ✅ resumeAnswers 未被消费（resume 后模型没复问）→ done 时清空，不会泄漏到下一题。
- ✅ 进程崩溃/出错 close → clearPending 广播 cancel；**持久行保留**可恢复；并发 drive_error。
- ⚠️ 一直没人回答的存活提问会占用一个进程（关闭了空闲回收）；持久化已兜底，
  重启可回收且不丢问题。

## 持久化 / 恢复
- ✅ surface 即写持久；answer/decline/cancel/done/interrupt 删除；崩溃保留。
- ✅ listPending 合并持久行并按内存标记 live。
- ✅ 两端同时回答：先到者成功，后到者 409（前端按“已失效”静默收敛，不重复作答）。
- ✅ 重启恢复：--resume + resumeAnswers 自动应答重问 → 干净结果（集成测试覆盖）。
- ⚠️ recover 在 resume 前即删持久行；若 resume 失败，答案丢失但有 drive_error 暴露（非静默）。
- ⚠️ dismissed_questions / pending 行无定期清理（极小体积）；done/dismiss/interrupt 已覆盖主路径。

## 通知 / 跨端一致性
- ✅ 选择器取消：driver 广播 `permission_cancel` → 各端清除。
- ✅ 角标：JSONL 派生 `attention`（非错误答复才清）→ `session_updated` 广播 → 各端更新。
- ✅ 兜底对账：收到 `session_updated` 且非 question 时清除本地残留选择器（漏收 cancel / 他端作答）。
- ✅ 重连/选中会话：`refreshPendingPermission` 主动拉取恢复或清除。
- 🔧 后台会话提问也弹系统通知（之前仅选中会话）。
- ⚠️ 操作系统级 push 已弹出无法撤回（推送机制限制）；App 内角标/选择器会收敛。

## 忽略 / 取消（不回复）
- ✅ 忽略遗留提问：持久化 dismissed id，deriveAttention 跳过，跨重启生效。
- ✅ 取消存活提问：decline → allow 无 answers → “did not answer”非错误结果，回合继续不卡。
- ✅ 取消恢复态(live=false)：转为 dismiss（无存活 CLI 可应答）。
- ✅ 忽略额外清持久行，避免被 GET 重新拉回。

## 前端
- ✅ answer/decline 网络失败（非 409）→ 还原选择器 + 报错（不静默）。
- ✅ 409 → 视为已失效，保持关闭。
- ✅ refresh 竞态：selectedId 校验。
- ✅ 切换会话清空本地 pendingPermission。

## 结论
主路径与已知边界均有显式处理；剩余 ⚠️ 项为可接受取舍（资源/极小泄漏/不可撤回的系统推送），
均不会“静默吞掉”用户答案或让回合永久卡死。
