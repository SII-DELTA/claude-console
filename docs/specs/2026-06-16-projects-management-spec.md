# Projects 项目管理页（列表 / 新增 / 隐藏 / 目录选择器）Spec

- 日期: 2026-06-16
- 状态: 待确认
- 范围: 新增移动端 Projects tab + 目录浏览后端 API + 项目隐藏/新增的服务端持久化
- 设计参考: 用户确认的双画板设计稿（Projects 列表 + 选择目录底部弹窗）

## 1. 目标

- 新增底部 tab **Projects**：项目列表、新增项目、隐藏/恢复项目。
- 手机端通过**逐级目录选择器**（从 `~` / `/` drill-in，只列文件夹）选电脑上的目录来新增项目。
- 隐藏的项目不在监控台总览/切换栏出现；在 Projects 页「已隐藏」分组可恢复。

## 2. 已确认决策

- 持久化：**服务端 durable**（agent sqlite，沿用 dismissed-questions 套路），跨设备一致。
- 「新增项目」：选目录后**记为已知项目**（pin 该 cwd），即使 0 会话也显示；点进可在该目录新建会话；首次跑会话后生成真实 `~/.claude/projects` 目录。
- 目录浏览：**全盘**（`~` 和 `/`），**只列文件夹、不读文件内容**，路径做绝对化/越界与权限校验。

## 3. 数据模型

`ClaudeProject` 新增可选字段：
- `hidden?: boolean` — 是否被用户隐藏。
- `pinned?: boolean` — 是否用户手动新增（可能 0 会话）。

## 4. 后端

### 4.1 HistoryStore（sqlite）
```
CREATE TABLE hidden_projects (dir TEXT PRIMARY KEY, hiddenAt TEXT NOT NULL);
CREATE TABLE pinned_projects (cwd TEXT PRIMARY KEY, addedAt TEXT NOT NULL);
```
方法：`hideProject(dir)`/`unhideProject(dir)`/`listHiddenProjects()`；
`addPinnedProject(cwd)`/`removePinnedProject(cwd)`/`listPinnedProjects()`。

### 4.2 ClaudeStore
- 内存持有 `hiddenDirs:Set` 与 `pinnedCwds:Set`，启动由 runtime 从 HistoryStore 注入；提供 `setHidden/addHidden/removeHidden`、`setPinned/addPinned/removePinned`。
- `listProjects()`：合并真实扫描结果 + pinned（pin 的 cwd 若无真实目录则合成 `sessionCount:0` 项，`pinned:true`），给每项标 `hidden`。**返回全部**（含隐藏，供管理页）。
- `listAllSessions()` / 监控台数据：**排除** hidden 项目下的会话（按 cwd → encodeProjectDir 命中 hiddenDirs）。
- 目录浏览辅助 `listDir(path)`（见 4.3）。

### 4.3 目录浏览 API
`GET /claude/fs/list?path=<abs|~>` →
```
{ path, parent, home, entries: [{ name, path }] }   // entries 仅目录，按名排序
```
- `~` / 空 → homedir；相对/非法 → 400。
- `path.resolve` 绝对化；`fs.readdir(withFileTypes)` 仅保留目录及指向目录的符号链接；隐藏目录（`.` 开头）默认**包含**（如 `.claude`）。
- 权限不足/不存在的子项跳过；整目录不可读 → 返回空 entries（不报错），`parent` 仍可上一级。

### 4.4 其它端点
- `POST /claude/projects/hide` `{ dir }` / `POST /claude/projects/unhide` `{ dir }`：落库 + 更新 ClaudeStore + 返回最新 projects。
- `POST /claude/projects/add` `{ cwd }`：pin（校验目录存在）+ 返回最新 projects。
- `GET /claude/projects` 已有：返回带 `hidden/pinned` 的全量。

## 5. 前端

### 5.1 导航
- `MobileTab` 增加 `"projects"`；BottomTabs 增第 4 个 tab（图标=文件夹，珊瑚高亮）。
- 顺序：监控台 / Projects / Sessions / Settings。

### 5.2 ProjectsPage 组件
- 顶部标题 + 「+ 新增项目」珊瑚按钮。
- 项目卡片：图标、名称、路径(mono)、`N 个会话` chip + 在线/离线点、`eye` 显示/隐藏切换、`⋯`（可后续扩展）。左滑露出「隐藏」。
- 底部「已隐藏 (n)」可折叠分组，行内「显示」恢复。
- 点项目卡 → 切到该项目并跳 Sessions（或监控台聚焦）。

### 5.3 DirectoryPicker 底部弹窗
- 面包屑（当前路径分段可点）+ 快捷根 `~ 主目录`/`/ 根目录`。
- `..上一级` + 子文件夹列表（folder 图标 + 名 + `›` drill-in）。
- 底部：所选路径预览(mono) + 「选择此目录」(珊瑚) + 「取消」。
- 选定 → `addProject(cwd)` → 刷新列表、关闭。

### 5.4 store / api
- api：`fsList(path)`、`hideProject(dir)`、`unhideProject(dir)`、`addProject(cwd)`。
- store：`projects` 已有；新增 actions 调用上述 api 后刷新 `loadProjects` + `loadAllSessions`；监控台 ProjectBar 与 allSessions 过滤掉 `hidden` 项目（前端兜底，后端也已排除）。

## 6. 安全

- 目录浏览只读、只返回目录名/路径，不返回文件内容、不返回文件项。
- 路径必须绝对化后校验；捕获 EACCES/ENOENT 不泄露堆栈。
- agent 默认仅 loopback；暴露时已有 password 鉴权覆盖该 API。

## 7. 验收

1. Projects tab 显示全部项目（含路径、会话数、在线点）；隐藏项进「已隐藏」。
2. 隐藏后该项目不再出现在监控台总览与切换栏；恢复后回归。
3. 「+ 新增项目」→ 目录选择器可从 `~`/`/` 逐级进入，选定后该 cwd 作为 pinned 项目出现（0 会话也在）。
4. 目录 API 只列文件夹；越权/非法路径返回 400 且不崩。
5. `pnpm typecheck` + 相关测试全绿（含 fs 列目录、hide/pin 持久化、cwd→hidden 过滤测试）。

## 8. 非目标

- 不做文件内容浏览/编辑。
- 不做真正"删除项目目录"（隐藏即可）。
- 桌面端布局不改（仅移动端新增 tab；桌面项目切换沿用 ProjectPicker）。
