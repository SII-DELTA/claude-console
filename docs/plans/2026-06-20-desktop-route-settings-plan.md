# Plan — 桌面会话发送路由设置

对应 spec: [2026-06-20-desktop-route-settings-spec.md](../specs/2026-06-20-desktop-route-settings-spec.md)
确认默认:自动 → A=原生、B=原生(都走桌面);新会话恒 agent;图片走接管确认;全局存储。

## 1. store.ts
- `export type DesktopRouteMode = "auto" | "native" | "takeover"`。
- keys `mac.desktopRoute.active` / `mac.desktopRoute.inactive`,默认 `"auto"`。
- `getDesktopRoute(cat: "active"|"inactive"): DesktopRouteMode` / `setDesktopRoute(cat, mode)`。
- 纯解析(可测):
  ```ts
  export function routeSendNative(opts: {
    selectedId: string | null; hasVscode: boolean; ideState: IdeState | null;
  }): boolean {
    if (!opts.selectedId || !opts.hasVscode) return false;
    const active = ideBadgeFor(opts.ideState, opts.selectedId) !== null;
    const mode = getDesktopRoute(active ? "active" : "inactive");
    const resolved = mode === "auto" ? "native" : mode; // auto→native(两类)
    return resolved === "native";
  }
  ```

## 2. page.tsx
- 替换 `desktopControllable`:`const routeNative = routeSendNative({selectedId, hasVscode: selectedHasVscode, ideState}) && !takeoverArmed;`
- `composerLocked = externalLive && !takeoverArmed && !routeNative;`
- handleSend(在 bPermission 之后):
  ```ts
  if (routeNative && selectedId) {
    if (images?.length) { /* 既有 imgTakeover 确认 → sendPrompt(force,images) */ }
    const r = await sendToVscode(selectedId, text);
    if (!r.ok) setError("发到桌面 VSCode 失败,可在设置改为接管或重试");
    return !!r.ok; // 失败 → composer 恢复草稿(不静默接管)
  }
  return await sendPrompt(text, { force: externalLive || undefined, images });
  ```
- placeholder:routeNative → "发送到桌面 VSCode 会话…"。

## 3. SettingsPage.tsx(VscodeSection)
- 两个分段控件:`活跃会话(已在桌面)` / `未活跃旧会话`,各 自动/原生/接管。
- 文案更新:删掉已失效的 "→VSCode 按钮" 描述,改为"发送按钮会按下面设置自动选择 注入桌面 / 接管"。
- 自动的提示:写明"自动:都优先注入桌面"。

## 4. agent: inject cwd 回退(B 类原生需要)
- `ClaudeStore.cwdOfSession(id): Promise<string|null>` = `resolveSessionFile` + `readSessionMeta`(缓存)→ cwd。
- `http-server` `/ide/inject`:服务端解析 cwd = ide-control 的 session-state 优先,缺失则 `opts.claude.cwdOfSession(id)`;都无 → 404。把解析到的 cwd 传给 `injectToSession`。
- `ide-control.injectToSession` 接受可选 `cwd`(服务端自证,非调用方原始输入);有则用之,pid 仍按 sessionMeta(可能 null → webview 模式)。

## 5. 测试 + 收尾
- store `routeSendNative` 单测(A/B × auto/native/takeover × hasVscode/无)。
- agent `cwdOfSession` 测试(活跃 state / 仅 JSONL / 不存在)。
- web typecheck+build;agent typecheck+test。
- change log → commit。

## 验收
- 设置可改两类路由;默认都注入桌面;图片明示接管;新会话走 agent;native 失败不静默、保留草稿。
