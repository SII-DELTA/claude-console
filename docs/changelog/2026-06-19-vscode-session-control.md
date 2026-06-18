# 从控制台控制桌面 Claude Code 会话(VSCode/终端)

- 日期: 2026-06-19
- spec/plan: docs/specs|plans/2026-06-19-vscode-terminal-session-control-*

## 改动(跨两仓库)

### claude-usage-statusbar 扩展(commit 8221614)
- `src/injectServer.js`:每窗口启本地 `127.0.0.1` HTTP + 发现文件 `~/.claude-console/inject/<port>.json`(port/token/workspaceFolders),token 鉴权。
  - `GET /state`:本窗口 workspace + 打开的 Claude 会话 tab + 终端。
  - `POST /inject`:终端 `sendText(text,true)`(静默含发送)/ webview `claude-vscode.editor.open(id,text)`(正常 tab+prefill,needsEnter)。
- `activate` 先启注入桥 + 状态栏部分 try/catch(避免双装命令冲突)。打包 v1.1.1 已安装。

### agent(commit d9c5b13 之后)
- `ide-control.ts`:读 `~/.claude/ide`(VSCode窗口)、`~/.claude-console/inject`(插件端口)、`session-state`(id↔cwd↔state↔pid↔tty);`injectToSession`(有插件 POST / 无插件回退 `code`+URI+剪贴板粘贴,自动发送补 osascript 回车)。
- http:`GET /ide/state`、`POST /ide/inject`、`POST /ide/open`。

### 控制台(commit d07d549)
- api/store:`ideState`/`ideInject`/`ideOpen`;轮询拉 ideState;`sendToVscode`/`openInVscode`。
- Composer:`→VSCode` 按钮(当前文本发到桌面对应会话,仅项目有 VSCode 时显示)。
- Projects:VSCode 徽章 + 「在 VSCode 打开」。
- Settings:「发到 VSCode」(自动发送/暂存 + 探测统计)。

## 验证
- 扩展:`/state` 401 鉴权、带 token 返回、`/inject` editor.open 成功(实测 inject-test-3 窗口)。
- agent:`/ide/state` 聚合 6 项目+13 会话;`/ide/inject` URI 回退 ok。
- typecheck/测试:shared/agent(119)/web(23)全过。

## 已知限制 / 待办
- 插件需 VSCode **reload/重启**才在已开窗口生效(新装的 v1.1.1);用户现有窗口逐个 reload 后 `plugin` 才会变 true、走静默路径。
- webview 发送需模拟回车(Claude Code 无提交命令)→ 自动发送会切窗口(非静默);终端会话可静默。
- 跨 Space:`code <cwd>` 会切到目标窗口的 Space(非静默)。
- 未做:自动安装插件、会话级"在 tab"徽章(需插件在所有窗口运行)。
