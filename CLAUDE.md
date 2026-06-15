# Nexra Claude Instructions

本文件用于 Claude 系列 coding agent 在本仓库中的最小强制规则。

## 最高原则（必须）

- 当需求有歧义、不清晰、或涉及决策时，必须先提问。
- 必须提供可选方案，并用可直接选择的选项卡让用户选择。
- 用户未选择前，禁止编码，禁止自行猜测。
- 回复、文档使用 中文 为主要语言

## 卡片格式（固定）

必须提供可直接选择的选项，不以“回复编号”作为唯一交互。

选项卡包含:
- 方案 A（适用场景、优点、风险）
- 方案 B（适用场景、优点、风险）
- 其他（无合适选项时允许自由输入）

## 设计与交付流程（必须）

- 先写 spec 文件到 docs/specs/。
- 设计确认后再写 plan 文件到 docs/plans/。
- 实现完成后先记录 change log，再提交 commit。

### spec/plan 命名规则（必须）

- spec 文件名格式: `日期-summary-spec.md`
- plan 文件名格式: `日期-summary-plan.md`
- `日期` 使用 `YYYY-MM-DD`（例如 `2026-05-27`）
- `summary` 使用 kebab-case，简洁描述主题

## Change Log 要求（必须）

- 每次实现完成都必须写 change log。
- 至少包含：改动文件、核心变更、影响范围、验证结果。

## 提交规则（必须）

- 每次代码修改完成后，必须立即提交一次 commit。
- commit message 必须清晰描述改动目的。
- 未提交 commit 视为任务未完成。
