# Spec — 桌面会话发送路由设置(原生 / 接管 / 自动)

日期: 2026-06-20
状态: 待确认

## 1. 背景

会话合并为一个发送按钮后,"会话开在桌面 VSCode 时是注入桌面(原生)还是手机接管
(resume)"目前是写死的启发式。用户希望可配置:**默认尽量走桌面原生 chat、少接管**,
并能按会话类别覆盖。

## 2. 已确认的决定

- **2 类**(检测可靠):
  - **A 桌面活跃会话** = `ideBadgeFor(ideState, sessionId) != null`(该会话进程存活且跑在 VSCode/终端下)。
  - **B 未活跃旧会话** = 项目有 VSCode 窗口(`hasVscode`)、但该会话当前未在桌面活跃。
- **新会话恒走 agent**(当场拿 id、干净);本设置只作用于"已存在的会话"。
- **全局配置**(localStorage),不分项目。
- **图片永远走接管确认**(注入是纯文字),不受本设置影响。

## 3. 设置模型

两个全局设置,各 3 个模式:

| 设置项 | 取值 | 默认 |
|---|---|---|
| 桌面活跃会话(A) | 自动 / 原生 / 接管 | 自动 |
| 未活跃旧会话(B) | 自动 / 原生 / 接管 | 自动 |

模式语义:
- **原生**:发到桌面 VSCode 会话(`sendToVscode`→`/ide/inject`)。A 类=注入到活跃会话;
  B 类=agent 用 `editor.open(id,text)`/URI 在桌面**打开该会话并发送**。
- **接管**:手机 agent `continue`(必要时 `force`)续写。
- **自动**(推荐默认的解析,**待你确认**):
  - A 类 → **原生**(它已开着,直接续在桌面最顺)。
  - B 类 → **接管**(避免在你不在电脑前时无谓打开桌面 tab、抢焦点;agent 处处可用)。
  - 若你更想"B 也默认原生",把 B 默认设为 **原生** 即可(本 spec 需你拍板默认值)。

localStorage 键:`mac.desktopRoute.active`、`mac.desktopRoute.inactive` ∈ `auto|native|takeover`。

## 4. 路由解析(发送时)

```
resolveRoute(text, images, session, ideState, armed, settings):
  if (!selectedId)            -> agent(new)              // 新会话恒 agent
  if (images?.length)         -> takeover-confirm        // 图片:弹确认→force agent
  if (armed)                  -> agent(force)            // 显式接管逃生口
  if (!hasVscode(session.cwd))-> agent                   // 项目无 VSCode 窗口 → 无原生可言
  cat  = ideBadgeFor(...) ? 'active' : 'inactive'
  mode = settings[cat]
  if (mode == 'auto') mode = (cat=='active' ? 'native' : 'takeover')
  if (mode == 'native' && !desktopReachable) -> agent + 提示  // 回退
  return mode == 'native' ? desktop-inject : agent(force?)
```

- `desktopReachable` = macOS + 能拿到会话 cwd + (插件端点或 VSCode 窗口)。不满足→回退 agent 并提示一次。

## 5. composer / 锁交互

- `routeToDesktop`(解析为 native 且非图片)为真时:**输入框不锁**,发送→注入。
- 否则沿用现有 `externalLive` 锁 + 武装接管逻辑。
- placeholder 在 routeToDesktop 时提示"发送到桌面 VSCode 会话…"。

## 6. 关键边界与处理

1. **B 类原生取 cwd**:`injectToSession` 现仅从 `~/.claude/session-state/<id>.json` 反推 cwd;
   未活跃旧会话的 state 文件可能已被清理 → 注入失败。**改:cwd 解析回退到会话 JSONL 所在
   目录(`resolveSessionFile` → 解码 dir → cwd),仍服务端自证、不收调用方 cwd**。
2. **依赖/回退**:非 mac、远程 agent、无窗口、无插件且 URI 不可用 → native 回退 agent,提示一次。
3. **目标窗口歧义**:会话其实在外部终端(iTerm)而项目恰好开着 VSCode → A 类判定按 `ideBadgeFor`
   (它看进程祖先,iTerm 会是 terminal 且非 inVscode → badge 可能为 terminal)。原生仅在能确定
   VSCode 宿主时走;否则回退 agent。
4. **焦点干扰**:B 类原生会打开 tab、可能抢前台;在设置文案里说明,默认 B=接管以规避。
5. **会话正忙**:A 类原生注入时 Claude Code 会排队输入(可接受);接管则可能冲突(保留 force 提示)。
6. **响应可见性**:原生发送的回复经 tail 同步;发送后踢一次快速 tail,避免延迟与误判 attention。
7. **显式接管/武装** 始终优先于设置。

## 7. 影响文件(预估)

- `apps/web/lib/store.ts`:新增 `DesktopRoute` 类型 + get/set(active/inactive)+ 路由解析 helper。
- `apps/web/app/page.tsx`:`handleSend`/`composerLocked`/placeholder 用解析结果;native 回退提示。
- `apps/web/components/SettingsPage.tsx`:`VscodeSection` 增加两个分段控件 + 文案(并更新已失效的
  "→VSCode 按钮"旧描述)。
- `packages/local-agent/src/ide-control.ts`(+ `http-server.ts`):inject 的 cwd 解析回退到 JSONL 目录
  (经 store);保持服务端自证。
- 测试:路由解析单测(各类别×模式×边界);agent cwd 回退测试。

## 8. 非目标

- 不做"原生新建会话"(新会话恒 agent)。
- 不做按项目配置(先全局)。
- 不改 tail/字节游标同步、不改接口协议。

## 9. 待你确认

- **自动的默认解析**:A=原生、B=接管(我的推荐)?还是 B 也默认原生?
- 其余按本 spec 执行。
