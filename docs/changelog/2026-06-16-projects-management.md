# Projects 项目管理页 Change Log

- 日期: 2026-06-16
- spec: docs/specs/2026-06-16-projects-management-spec.md
- plan: docs/plans/2026-06-16-projects-management-plan.md

## 新增能力
- 移动端新增第 4 个底部 tab **Projects**：项目列表、新增项目、隐藏/恢复项目。
- **逐级目录选择器**（底部弹窗）：从 ~/ 或 / 一层层进入，只列文件夹，选定即新增项目。
- 隐藏的项目从监控台总览与切换栏移除；在 Projects 页「已隐藏」分组可一键恢复。

## 后端(已提交 057f247)
- ClaudeProject 加 hidden/pinned；HistoryStore 持久化 hidden_projects/pinned_projects；
  ClaudeStore listProjects 合并 pinned+标 hidden、listAllSessions 排除 hidden、listDir 目录浏览；
  http: GET /claude/fs/list、POST /claude/projects/hide|unhide|add；runtime 启动注入。

## 前端
- api: fsList/hideClaudeProject/unhideClaudeProject/addClaudeProject。
- store: MobileTab 加 "projects"；hideProject/unhideProject/addProject actions(改完刷新 projects+overview)。
- 组件: DirectoryPicker(底部 sheet 面包屑+快捷根+folder 列表+确认)、ProjectsPage(列表+新增+隐藏/已隐藏)。
- BottomTabs 加 Projects tab；page.tsx 渲染、监控台 ProjectBar 过滤 hidden、点项目→切换并跳 Sessions。

## 验证
- typecheck 全绿；后端 133 测试(含 hidden 排除/pinned 合成/listDir)、web 22 测试通过。
- 需 make restart 重启 agent 后新路由生效。
