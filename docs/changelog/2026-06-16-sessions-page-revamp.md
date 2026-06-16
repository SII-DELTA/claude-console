# Sessions 页改版 Change Log

- 日期: 2026-06-16

## 变更
- 顶部项目选择改用与监控台**同一个 ProjectBar**(sticky pill + 运行/待处理徽章)，
  与 Projects 联动(排除隐藏项)。砍掉 coverflow 三卡方案。
- 抽出共享组件 `ProjectBar` + `projectStats`，监控台与 Sessions 复用。
- 会话列表按 **今日 / 本周 / 历史** 分组，配**手绘 SVG 图标**(太阳/周历/逆时针时钟)；
  每组内"需处理"会话置顶；行显示动态标题(currentTask→最近指令→title)+状态副行+相对时间。
- 底部**固定大「新建会话」按钮**(珊瑚)，列表滚动时常驻。
- 新建会话目标项目：聚焦某项目→直接在该项目新建；选「全部」→弹「在哪个项目新建」
  选择抽屉(单项目时直接用)。
- 新增 store `sessionsFocus`。

## 改动文件
- 新增 ProjectBar.tsx、SessionsPage.tsx。
- Dashboard.tsx 改用共享 ProjectBar/projectStats。
- store.ts: sessionsFocus + setter。
- page.tsx: 移动端 sessions tab 改用 SessionsPage(桌面端 SessionList 不变)。

## 验证
- web typecheck + 22 测试通过。纯前端，dev 热更可见。
