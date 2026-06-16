# Projects 项目管理 实施 Plan

对应 spec: `docs/specs/2026-06-16-projects-management-spec.md`

## 后端
1. shared schemas：`ClaudeProject` 加 `hidden?`/`pinned?`；新增 `FsListResponse`、hide/unhide/add body。
2. HistoryStore：`hidden_projects`/`pinned_projects` 表 + 增删查方法。
3. ClaudeStore：`hiddenDirs`/`pinnedCwds` 内存集 + setter/add/remove；`listProjects` 合并 pinned+标 hidden；`listAllSessions` 排除 hidden；`listDir(path)` 目录浏览。
4. http-server：`GET /claude/fs/list`、`POST /claude/projects/hide|unhide|add`。
5. runtime：启动注入 hidden/pinned；hide/unhide/add 端点落库+更新内存。

## 前端
6. store：`MobileTab` 加 `projects`；api 加 `fsList/hideProject/unhideProject/addProject`；store actions + 刷新；监控台过滤 hidden。
7. 组件：`ProjectsPage`、`DirectoryPicker`（底部 sheet）。
8. BottomTabs 加 Projects tab；page.tsx 渲染 ProjectsPage。

## 测试 / 提交
9. 后端测试：listDir 仅目录、hide/pin 持久化、cwd→hidden 过滤。
10. typecheck + 全量；分后端、前端两次 commit，附 change log。
