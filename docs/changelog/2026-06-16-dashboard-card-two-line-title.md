# 监控台卡片标题两行 + 次要信息独立底行 Change Log

- 日期: 2026-06-16

## 背景
卡片标题与项目名/徽章/时间挤在一行被截断，尤其「需要你处理」卡片标题几乎看不见；
有了 AI 摘要后原始 title 意义不大。

## 变更
统一三类卡片（需处理 / 运行中 / 最近完成）结构：
- 标题最多两行（line-clamp-2），优先 currentTask(AI 摘要) → 最近指令 → 原 title。
- 项目名 / 消息数 / 时间 / 关注徽章 全部收到卡片**最底部独立一行**（MetaLine），不再与标题争行宽。
- 运行卡保留「正在 …活动」一行；完成卡保留结果摘要一行。

## 改动文件
- apps/web/components/Dashboard.tsx：移除 Tag，新增 MetaLine；重写 AttentionCard/RunningRow/DoneRow 布局。

## 验证
- pnpm --filter @mac/web typecheck 通过；web 22 测试通过。
