# VSCode/终端会话控制 Plan

- 日期: 2026-06-19
- 对应 spec: docs/specs/2026-06-19-vscode-terminal-session-control-spec.md
- 决策:默认自动发送;插件并入 claude-usage-statusbar。

## 阶段 1 — claude-usage-statusbar 插件(地基)
仓库 `/Users/Admin/Documents/project/claude-usage-statusbar`
- 新增 `src/injectServer.js`:
  - `activate` 时启动 `127.0.0.1` HTTP(端口 0 自动分配),写发现文件 `~/.claude-console/inject/<port>.json = {port, token, workspaceFolders, pid, version}`(权限 600);`deactivate` 删文件、关 server。
  - 随机 token;所有请求校验 `x-inject-token`。
  - `GET /state` → `{ workspaceFolders, claudeTabs:[{label, viewType}], terminals:[{name}] }`(用 `vscode.window.tabGroups` 枚举 webview tab、`vscode.window.terminals`)。
  - `POST /inject {sessionId?, text, send, mode}`:
    - `mode==="terminal"` 或检测到匹配终端 → `terminal.sendText(text, !!send)`(静默,含回车)。
    - 否则 webview → `executeCommand("claude-vscode.editor.open", sessionId, text)`(正常 tab + prefill);返回 `{applied, needsEnter:true}`(发送交给 agent 的 osascript 回车)。
- `src/extension.js` 的 `activate/deactivate` 接入。
- 构建 vsix:`npm run package`,装回 `code --install-extension`。

## 阶段 2 — agent 接口
仓库 agent_console / `packages/local-agent/src/`
- 新增 `ide-control.ts`:
  - `readIdeLocks()`:读 `~/.claude/ide/*.lock` → 项目→VSCode窗口。
  - `readInjectEndpoints()`:读 `~/.claude-console/inject/*.json` → 项目→插件端口/token。
  - `readSessionStates()`:读 `~/.claude/session-state/*.json` → sessionId↔pid↔cwd↔state(+pid 探活、TTY 判终端)。
  - `cwdOfSession(id)`:从 session-state / JSONL 找 cwd。
  - `inject({sessionId, text, send})`:cwd→有插件端点则 POST;否则回退 `code <cwd>` + `open vscode://…open?session=` + osascript 粘贴;`send` 时 osascript 回车。
  - `openInVscode(cwd)`:`code <cwd>`。
- http-server 路由:`GET /ide/state`(聚合给控制台)、`POST /ide/inject`、`POST /ide/open`。

## 阶段 3 — 控制台
- api.ts:`ideState()`、`ideInject(sessionId,text,send)`、`ideOpen(cwd)`。
- store:ideState 拉取/缓存。
- Projects:有 VSCode 徽章 +「在 VSCode 打开」。
- Sessions/Dashboard:「在 tab/终端/busy」徽章。
- session 卡片 +聊天页顶:「发到 VSCode」(默认自动发送)。
- Settings:原生接管开关、发送方式、自动开 VSCode、自动装插件、辅助功能引导。

## 阶段 4 — 收尾
- 自动发送 osascript 回车 + 权限引导文案。
- 每阶段 typecheck/构建/手测;逐个 commit;change log。

## 验证
- 插件:`curl` 本地端口 `/state`、`/inject`;
- agent:`POST /ide/inject` 真打到桌面会话;
- 控制台:徽章/按钮真机。
