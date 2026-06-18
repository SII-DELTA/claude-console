# AskUserQuestion 选项卡:Tab 卡片(一次一问)+ 可折叠 + 布局加固 Spec

- 日期: 2026-06-18(更新:补充可折叠、标题溢出、✕ 错位、同类隐患)
- 状态: 待规划(已确认要做;优先级待定)
- 背景: 多问题的 AskUserQuestion 在手机上被 `QuestionPanel` 纵向全部堆叠渲染([QuestionPanel.tsx:155](apps/web/components/QuestionPanel.tsx#L155)),卡片过长把上面 Claude 的输出顶出屏幕,用户看不到刚输出的内容、难以做选择。且当前卡片有两处布局缺陷:标题文字溢出、右上角 ✕ 错位压到文字。

## 目标

1. `QuestionPanel` 从"全部问题平铺"改为"**单问题视图 + 顶部 tab 切换**",卡片紧凑、不遮挡上文,可逐题作答并随时点 tab 回改。
2. 卡片**可折叠到底部**:折叠后只占一小条,用户可先向上看完 Claude 输出,再展开作答。
3. 修复**标题文字溢出**与**右上角 ✕ 错位压到文字**,并对同类组件(ToolApprovalPanel)一并加固。

## 设计

### A. Tab 卡片(一次一问)— 改 QuestionPanel.tsx

- 状态新增 `active`(当前问题索引);保留现有 `selected[qi]`。
- **顶部 tab 行**(横向可滚动 `overflow-x-auto`):每问题一个 chip,标签用 `q.header`,缺省 `问题{qi+1}`。
  - 已答(`selected[qi].length>0`)标 ✓;当前 active 高亮。
  - tab 标签 `max-w-[~8rem] truncate`、`shrink-0`,避免撑爆;点击切题(回看/修改)。
- **主体**:只渲染 `active` 这一题的 `question` + options(单选/多选沿用)。
- **导航**:单选选中后自动前进到下一个未答题(末题停);提供"上一题/下一题"兜底;tab 始终可点回改。
- **底部**:进度(`2/3 已答`)、"提交选择"、"也可在下方输入框自由回复"、关闭 ✕。
- 单问题时不显示 tab 行,退化为单卡片。
- `onSubmit`/`findPendingQuestions`/`parseAskUserQuestion` 输出与协议不变。

### B. 可折叠

- 卡片头部加**折叠/展开**切换(chevron)。折叠态:收成一条紧凑栏(显示如「待你选择 · 3 问题 · 1/3 已答」+ 展开按钮),不占屏、上文完全可见。
- 默认展开;折叠状态在该 picker 生命周期内记忆(组件内 state 即可,无需持久化)。
- 折叠不丢已选(`selected` 保留)。
- 保留首次出现的 scrollIntoView + flash 高亮(折叠态也应能被滚动定位)。

### C. 布局加固(修溢出 + ✕ 错位)

- **头部结构化**:把 ✕ 与折叠按钮放进**独立的 flex 头部行**(`flex items-start gap-2`),而非 `absolute` 覆盖内容 —— 结构上即不可能压到文字。
  - 头部行布局:`[tab 区 / 标题 (min-w-0 flex-1)] [折叠] [✕]`,右侧按钮 `shrink-0`。
- **标题/header 防溢出**:header chip `shrink-0`;问题文字容器 `min-w-0`,长文本换行(`break-words`)或按需 `line-clamp`;tab 标签 `truncate`。
- **ToolApprovalPanel 同步加固**:沿用相同的头部结构与 `min-w-0`/`shrink-0`/`break-words`,把现有 `absolute right-2 top-2` ✕ 也改为头部行内按钮,消除潜在错位与溢出。

## 隐患排查结论(本次扫描)

- `QuestionPanel`:✕ 无右边距预留 + 标题缺 `min-w-0` → 确认溢出/错位(本 spec 修复)。
- `ToolApprovalPanel`:有 `pr-6` 预留但 header 文字无 truncate/`min-w-0` → 同类溢出隐患(一并修)。
- 其余 `absolute` 角标(Markdown 复制按钮、Timeline 角标、Composer 删图、BottomTabs 徽标)位于各自留白区,非文字碰撞,**本次不动**。

## 影响范围

- `apps/web/components/QuestionPanel.tsx`(主改)。
- `apps/web/components/ToolApprovalPanel.tsx`(头部结构 + 防溢出加固)。
- 不动协议、store、消息回填格式。

## 非目标

- 不改 AskUserQuestion 数据结构与回填协议;不做手势切题;不持久化折叠状态到本地存储。

## 验证

- 3~4 问题:卡片只占单题高度、上文可见;tab 可切换并回改;单选自动前进;单问题时无 tab。
- 折叠后只剩一条、上文完全可见;展开后已选保留。
- 超长 header/question:不溢出、✕ 永不压到文字(QuestionPanel 与 ToolApprovalPanel 均验证)。
- 提交输出与现状一致。
