# 监控台标题剥离 IDE/系统注入内容 Change Log

- 日期: 2026-06-16

## 背景（现象）
监控台「正在运行」卡片标题显示成 `<ide_opened_file>The user opened the file …`，
即把 IDE 自动注入到用户回合的上下文当成了用户指令。

## 根因
一条用户消息常含多个文本块：IDE 注入的 `<ide_opened_file>…</ide_opened_file>`（或
`<system-reminder>`、slash 命令包裹等）+ 真正的用户输入。解析时取了**第一个**文本块，
于是注入内容污染了 firstUserText / lastUserText / preview / 摘要 transcript。

## 修复
- 新增 `stripInjectedText()` / `userText()`：剥离 `ide_opened_file`、`ide_selection`、
  `ide_diagnostics`、`system-reminder`、`command-*`、`local-command-*` 等注入包裹块。
- `accumulate()` 用清洗后的真实文本更新 first/last user 文本与 openQuestionIds；
  纯注入回合不再被当作用户指令。
- current-task 的 transcript 同样剥离注入内容，避免摘要被带偏。

## 改动文件
- packages/local-agent/src/util/claude-jsonl.ts：stripInjectedText/userText + accumulate。
- packages/local-agent/src/current-task.ts：buildTranscript 清洗。
- 测试：claude-jsonl-derive.test.ts 增 3 个注入剥离用例。

## 验证
- typecheck 通过；local-agent 129 测试全绿。
- 需 `make restart` 重启 agent 后，标题不再出现 `<ide_opened_file>…`。

## 备注
- 冒烟测试残留的 3 个会话（首条为测试 transcript）建议手动删除（见对话）。
