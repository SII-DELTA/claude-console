# Change Log: 选择器可取消关闭 + 边界条件加固

- 日期: 2026-06-13
- 关联: docs/changelog/2026-06-13-interactive-permissions.md、
  docs/changelog/2026-06-13-pending-permission-recovery.md、
  docs/changelog/2026-06-13-dismiss-question.md

## 新增：Web 端关闭/取消提问选择器（不回复）

- driver `declinePermission()`：对存活的 can_use_tool 回 `allow` 且**不带 answers**
  → 工具返回干净的 `The user did not answer the questions.`（非错误），回合继续、不卡住。
- http `POST /claude/sessions/:id/decline-permission`。
- web：QuestionPanel 右上角 ✕（`onClose`）；store `closePermission()`：
  存活则 decline，恢复态(live=false)则走 dismiss；方案 A 选择器 ✕ = 忽略。

## 边界加固（避免静默吞掉）

- **答复写失败不丢答案**：`answerPermission` 在 stdin 写失败（进程刚死）时**不再**
  删除内存/持久记录、返回 false → HTTP 层回退到 resume 恢复路径重新作答。
- **后台会话提问也通知**：`server:claude_permission_request` 现在**无论是否选中**
  该会话都弹系统通知（之前仅选中会话才通知，后台提问只有铃铛角标、易漏）。
- **忽略同时清持久行**：dismiss-question 额外 `driver.clearPersistedPending()`，
  避免恢复态选择器被忽略后又被 GET 拉回。

## 测试

- 新增 driver 用例：declinePermission（allow 无 answers）、answerPermission 写失败
  保留记录。
- 全量：shared 15 + web 18 + local-agent 87 = 120 全绿；web typecheck 通过。

## 关联审计

详见 docs/2026-06-13-askuserquestion-edge-audit.md（逐边界条件核对结论）。
