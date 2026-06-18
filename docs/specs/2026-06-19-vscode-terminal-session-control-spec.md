# 从控制台控制桌面 Claude Code 会话(VSCode/终端)Spec

- 日期: 2026-06-19
- 状态: 待确认
- 背景: 用户希望从手机/web 控制台把内容**注入并发送进桌面正在运行的 Claude Code 会话**(在 VSCode 面板或终端里跑的那个,而非 `--resume` 另起的独立进程)。经大量实测确定了可行路径与限制,本 spec 固化方案。

## 一、实测结论(可行性已验证)

| 能力 | 结论 | 依据 |
|---|---|---|
| 哪些项目有 VSCode 在跑 | ✅ | `~/.claude/ide/<port>.lock` → workspaceFolders + MCP 端口 + authToken |
| 会话↔pid↔cwd↔state | ✅ | `~/.claude/session-state/<sessionId>.json`(hook 写,pid 可探活) |
| 会话归属(扩展/终端/agent) | ✅ | pid 的 TTY + 祖先链(`Code Helper (Plugin)`=扩展;有 TTY=终端;node agent=`--resume`) |
| 按 sessionId 精确打开会话 | ✅ | `vscode://anthropic.claude-code/open?session=<id>&prompt=<text>`(URI handler 内部调 `primaryEditor.open`) |
| 跨 Space / 被遮挡窗口聚焦 | ✅(非静默) | `code <cwd>` 让 VSCode 自己聚焦窗口(AppleScript 跨 Space 抓不到) |
| 注入文本 | ✅ | 聚焦后 `osascript` 剪贴板 ⌘V;或扩展内 `editor.open(id, prompt)` prefill;或终端 `terminal.sendText` |
| **发送(回车)** | ⚠️ | **Claude Code 无"提交"命令**;webview 发送必须模拟回车(需窗口聚焦+辅助功能);**终端 `sendText(text,true)` 可静默发送** |
| 哪些会话开在 tab 里 | 仅插件 | 内置 MCP `getOpenEditors` 看不到 webview 会话 tab;`vscode.window.tabGroups` 可枚举(插件能力) |
| URI/primaryEditor 打开的视图 | 精简单槽 | 缺历史/新建按钮、会被下一个替换;插件用 `editor.open` 可得正常 tab |

**核心限制**:webview 会话"发送"无法纯静默(需回车键);终端会话可纯静默(sendText)。

## 二、架构(三件套 + 双适配 + 优雅降级)

### A. 配套插件(并入用户已有的 `claude-usage-statusbar`)
- `onStartupFinished` 在**每个窗口**激活;启动时:
  - 开 `127.0.0.1` 本地 HTTP(随机端口),写发现文件 `~/.claude-console/inject/<port>.json = {port, token, workspaceFolders}`;
- 接口(带 token 校验):
  - `GET /state`:返回本窗口 workspace、打开的 Claude 会话 tab 列表(`tabGroups` 枚举,尽力解析 sessionId)、本窗口可见的终端列表。
  - `POST /inject {sessionId, text, send, mode}`:
    - **webview 适配**:`executeCommand("claude-vscode.editor.open", sessionId, text)` → 正常 tab + prefill;`send` 时插件触发发送(若 Claude Code 暴露发送途径则用,否则回退到"需用户回车"或由 agent 走 osascript 回车)。
    - **terminal 适配**:若该会话在某 integrated terminal,`terminal.sendText(text, send===true)` → 输入(+回车,静默发送)。

### B. agent(`POST /ide/inject { sessionId, text, send }`)
1. `sessionId → cwd`(session-state / JSONL)。
2. **能力检测**:有该 workspace 的发现文件?
   - **有插件** → POST 给插件端口(静默/正常 tab/可处理终端)。
   - **无插件(回退)** → `code <cwd>` 聚焦窗口 → `open vscode://…/open?session=<id>` → `osascript` 剪贴板粘贴 →(`send` 时再回车)。
3. `send` 语义见配置(暂存 vs 自动发送)。

### C. 控制台(手机/web)
- 每个 session:**「发到 VSCode」**动作(短按=按配置;可选长按=另一动作)。
- 徽章/标记(见 §四)。

## 三、配置(手机 Settings)

- **原生接管模式**(总开关):开 → 发送走"注入桌面会话";关 → 维持现状(`--resume` 驱动)。
- **发送方式**:`暂存(prefill,静默,推荐)` / `自动发送(切窗口+回车,非静默)` / `终端优先(在终端则静默发送)`。
- **未运行时自动打开 VSCode**:目标项目无 VSCode 窗口时,是否 `code <cwd>` 打开。
- **自动安装/更新插件**:检测到 claude-usage-statusbar 无注入能力时,是否 `code --install-extension` 安装(或提示手动)。
- **辅助功能权限引导**:自动发送/回退路径需要时,给出授权指引。

## 四、控制台 UI(探测可视化)

- **Projects 页**:
  - 项目有 VSCode 在跑 → 显示徽章(如桌面图标/绿点),来自 `ide/*.lock`。
  - 没在跑 → 提供「在 VSCode 打开」(`code <cwd>`)。
- **Sessions 列表**:
  - 会话当前开在某 VSCode 窗口的 tab 里 → 徽章「在 VSCode」(来自插件 `/state` 的 tab 列表;无插件则此徽章不可用)。
  - 会话在终端跑 → 徽章「终端」(TTY 探测)。
  - busy/idle、属哪个项目窗口,一并标注。

## 五、安全
- 插件 HTTP 仅绑 `127.0.0.1` + token(发现文件 600 权限);只接受本机。
- agent 只对**本机已知会话**注入;sessionId 必须能在 session-state/JSONL 中找到。
- 自动安装插件需用户在 Settings 显式开启。

## 六、非目标 / 分期
- v1:webview 适配(插件 `editor.open` + 回退 URI)+ 探测/徽章 + 暂存发送 + 「在 VSCode 打开」。
- v2:终端适配(`sendText` 静默发送)+ 自动发送(osascript 回车)+ 自动安装插件。
- 不做:跨机器(仅本机 agent 所在的 Mac);不碰 Anthropic 官方 Remote Control。

## 七、决策(已定)
1. **默认发送方式 = 自动发送**(切窗口 + 模拟回车;webview 需辅助功能权限,终端则静默)。仍提供"暂存"作为可选项。
2. **插件并入 `claude-usage-statusbar`**(同扩展新增注入模块,不另装)。
3. 自动安装/更新:`code --install-extension <vsix>`(由 claude-usage-statusbar 仓库构建出 vsix);失败则提示手动。
4. 入口:**session 卡片**上加「发到 VSCode」(默认自动发送);聊天页顶部也放一个(发当前会话)。

## 八、实现顺序(确认后转 plan)
1. **claude-usage-statusbar**:加本地 HTTP(端口+发现文件)、`POST /inject`(webview `editor.open` + terminal `sendText`)、`GET /state`(tab/terminal 列表)、token。
2. **agent**:`POST /ide/inject`(能力检测 → 插件端口 / 回退 `code`+URI+osascript);`GET /ide/state`(聚合 lock + 发现文件 + session-state,给控制台用)。
3. **控制台**:Projects 徽章 +「在 VSCode 打开」;Sessions「在 tab / 终端 / busy」徽章;「发到 VSCode」入口;Settings 配置项。
4. 自动发送的 osascript 回车 + 辅助功能权限引导。
