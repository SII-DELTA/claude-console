"use client";

import { useEffect, useRef, useState } from "react";
import type { ClaudeProject } from "@mac/shared";
import { useAppStore } from "../lib/store";
import { ConnectForm } from "../components/ConnectForm";
import { SessionList } from "../components/SessionList";
import { Timeline } from "../components/Timeline";
import { Composer } from "../components/Composer";
import { QuickActions } from "../components/QuickActions";
import { ClaudeLogo } from "../components/ClaudeLogo";
import { QuestionPanel, findPendingQuestions } from "../components/QuestionPanel";
import { UsageDisplay } from "../components/UsageDisplay";
import { LoadingBadge } from "../components/LoadingBadge";
import { BottomTabs } from "../components/BottomTabs";
import { Dashboard } from "../components/Dashboard";
import { SettingsPage } from "../components/SettingsPage";
import { notify } from "../lib/notify";

export default function Page() {
  const hydrated = useHydrated();
  const connection = useAppStore((s) => s.connection);
  // Avoid SSR/client hydration mismatch: connection comes from localStorage,
  // which is only available on the client. Render a neutral splash until mounted.
  if (!hydrated) return <Splash />;
  if (!connection) return <ConnectForm />;
  return <Console />;
}

function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}

function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg">
      <ClaudeLogo size={32} className="animate-pulse text-[#D97757]" />
    </div>
  );
}

function Console() {
  const {
    connection,
    projects,
    activeProjectDir,
    switchProject,
    loadProjects,
    restoreFromUrl,
    sessions,
    selectedId,
    messages,
    historyOffset,
    loadingEarlier,
    loadEarlier,
    stream,
    driveStatus,
    lastUsage,
    permissionMode,
    setPermissionMode,
    wsConnected,
    error,
    loadingDetail,
    mobileTab,
    setMobileTab,
    selectSession,
    sendPrompt,
    interrupt,
    answerPermission,
    pendingPermission,
    loadSessions,
    setConnection,
    clearError,
    connectWs,
    ws,
  } = useAppStore();

  // Mobile: a "new session" detail view opened with no session selected yet.
  const [composeNew, setComposeNew] = useState(false);
  // Mobile shows the session detail (chat) when a session is open or composing new;
  // otherwise the home view (dashboard/sessions/settings tabs). Desktop ignores this.
  const mobileDetail = !!selectedId || composeNew;
  // Bell badge: sessions that urgently need the user (awaiting answer / errored).
  const attentionCount = sessions.filter((s) => s.attention === "question" || s.attention === "error").length;
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [takeoverArmed, setTakeoverArmed] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  // Text dropped into the composer from a timeline message (not auto-sent). Bump nonce to re-trigger.
  const [draft, setDraft] = useState<{ text: string; nonce: number }>({ text: "", nonce: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  // set while prepending older messages so the jump-to-latest effect doesn't fire
  const skipAutoScrollRef = useRef(false);

  const hasMoreHistory = !!selectedId && historyOffset > 0;

  // Load an older page while preserving the viewport (compensate for the height
  // added at the top so the content under the user's eyes doesn't jump).
  async function handleLoadEarlier() {
    const el = scrollRef.current;
    if (!el || loadingEarlier || !hasMoreHistory) return;
    skipAutoScrollRef.current = true;
    const prevHeight = el.scrollHeight;
    const prevTop = el.scrollTop;
    await loadEarlier();
    requestAnimationFrame(() => {
      const el2 = scrollRef.current;
      if (el2) el2.scrollTop = el2.scrollHeight - prevHeight + prevTop;
      skipAutoScrollRef.current = false;
    });
  }

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    setAtBottom(bottom);
    if (bottom) setHasNew(false);
    // near the top → pull in an older page
    if (el.scrollTop < 80 && hasMoreHistory && !loadingEarlier) void handleLoadEarlier();
  }
  function scrollToBottom() {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setHasNew(false);
  }

  // reset the takeover arm whenever the selected session changes
  useEffect(() => setTakeoverArmed(false), [selectedId]);

  // The app shell is `position: fixed` and sized to the visualViewport (see the root
  // div + globals.css). This is the only reliable iOS-PWA keyboard fix: in standalone
  // mode window.innerHeight never changes and the OS scrolls the *layout* viewport to
  // reveal the focused input — which shoves an in-flow layout up off-screen. By pinning
  // a fixed shell to visualViewport.height (area above the keyboard) and following its
  // offsetTop, the composer always sits right above the keyboard and nothing scrolls.
  useEffect(() => {
    const root = document.documentElement;
    const setH = () => {
      const vv = window.visualViewport;
      const h = vv ? vv.height : window.innerHeight;
      root.style.setProperty("--app-height", `${h}px`);
      root.style.setProperty("--vv-top", `${vv ? vv.offsetTop : 0}px`);
      // keyboard open ⇒ home indicator hidden ⇒ drop the safe-area gap below the composer
      const kbOpen = vv ? window.innerHeight - vv.height > 120 : false;
      root.classList.toggle("kb-open", kbOpen);
    };
    setH();
    window.addEventListener("resize", setH);
    window.addEventListener("orientationchange", setH);
    window.visualViewport?.addEventListener("resize", setH);
    window.visualViewport?.addEventListener("scroll", setH);
    return () => {
      window.removeEventListener("resize", setH);
      window.removeEventListener("orientationchange", setH);
      window.visualViewport?.removeEventListener("resize", setH);
      window.visualViewport?.removeEventListener("scroll", setH);
      root.classList.remove("kb-open");
    };
  }, []);

  // connect the WS on mount when restoring a persisted connection
  useEffect(() => {
    if (!ws) connectWs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // load projects, restore the project/session from the URL, then poll sessions
  useEffect(() => {
    void (async () => {
      await loadProjects();
      await restoreFromUrl();
      await loadSessions();
    })();
    const t = setInterval(() => void loadSessions(), 20000);
    return () => clearInterval(t);
  }, [loadProjects, restoreFromUrl, loadSessions]);

  // Jump to the latest when switching sessions; otherwise follow new content
  // only when already near the bottom (instant — smooth-per-token is janky).
  const prevSel = useRef<string | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // prepending older messages: keep the viewport where it is (handled separately)
    if (skipAutoScrollRef.current) return;
    const switched = prevSel.current !== selectedId;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (switched || nearBottom) {
      el.scrollTo({ top: el.scrollHeight });
      setAtBottom(true);
      setHasNew(false);
    } else {
      setHasNew(true); // new content arrived while scrolled up
    }
    // only "consume" the switch once the session's messages have actually loaded,
    // so the empty interim render doesn't swallow the jump-to-latest
    if (!selectedId || messages.length > 0) prevSel.current = selectedId;
  }, [messages, stream, selectedId]);

  const liveConflict = error?.startsWith("LIVE:") ? error.slice(5) : null;
  const selected = sessions.find((s) => s.id === selectedId);
  // Live AND not driven by our agent → it's running in a terminal / elsewhere.
  // Sending would fight that process for the same session file, so block it and
  // require an explicit takeover.
  const externalLive = !!selected?.isLive && !selected?.drivenByAgent && driveStatus !== "streaming";
  const composerLocked = externalLive && !takeoverArmed;
  // 方案 B: an AskUserQuestion intercepted live via the control protocol (shows
  // even while the turn is "streaming" — the turn is paused awaiting the answer).
  const bPermission =
    pendingPermission && pendingPermission.sessionId === selectedId ? pendingPermission : null;
  // 方案 A fallback: a headlessly-failed AskUserQuestion re-rendered from history.
  // Suppressed when B is active to avoid a duplicate picker.
  const pendingQuestions = bPermission
    ? null
    : driveStatus === "streaming"
      ? null
      : findPendingQuestions(messages);

  // notify when a question first appears (most actionable signal)
  const hadQuestion = useRef(false);
  useEffect(() => {
    const has = !!pendingQuestions;
    if (has && !hadQuestion.current) notify("❓ Claude 需要你选择", selected?.title);
    hadQuestion.current = has;
  }, [pendingQuestions, selected?.title]);

  // Returns true on success; false lets the composer restore the user's draft so a
  // failed/timed-out send never silently eats what they typed.
  async function handleSend(
    text: string,
    images?: import("@mac/shared").ClaudeImage[],
  ): Promise<boolean> {
    // 方案 B: a picker is awaiting a live control_request. A free-text reply is the
    // answer to that question (same-turn resume) — route it through answerPermission
    // so the CLI unblocks and the picker dismisses, instead of sending a new prompt.
    if (bPermission && text.trim()) {
      const answers: Record<string, string | string[]> = {};
      for (const q of bPermission.questions) answers[q.question] = q.multiSelect ? [text] : text;
      void answerPermission(answers);
      return true;
    }
    // when armed (or taking over external-live), force the resume
    return await sendPrompt(text, { force: externalLive || undefined, images });
  }

  function selectAndClose(id: string) {
    void selectSession(id);
  }

  function startNew() {
    void selectSession(null);
    setComposeNew(true); // mobile: open the new-session detail view
  }

  // Mobile: back from the session detail returns to the home tabs.
  function goBack() {
    void selectSession(null);
    setComposeNew(false);
  }

  return (
    <div
      className="fixed inset-x-0 flex overflow-hidden bg-bg text-ink flex-col md:flex-row"
      style={{ top: "var(--vv-top, 0px)", height: "var(--app-height, 100dvh)" }}
    >
      {/* Sidebar (desktop) / Drawer (mobile) */}
      <aside className="hidden w-72 shrink-0 border-r border-line bg-bg-alt md:block">
        <Brand
          projects={projects}
          activeProjectDir={activeProjectDir}
          fallbackName={connection?.workspaceName}
          wsConnected={wsConnected}
          onSwitch={(dir) => void switchProject(dir)}
        />
        <div className="h-[calc(100%-4.5rem)]">
          <SessionList
            sessions={sessions}
            selectedId={selectedId}
            onSelect={(id) => void selectSession(id)}
            onNew={startNew}
            onRefresh={loadSessions}
          />
        </div>
      </aside>

      {/* Mobile home: shared header + bottom-tab views (dashboard / sessions / settings) */}
      {!mobileDetail && (
        <div className="flex min-h-0 flex-1 flex-col md:hidden">
          <HomeHeader
            title={mobileTab === "dashboard" ? "Claude Console" : mobileTab === "sessions" ? "Sessions" : "Settings"}
            wsConnected={wsConnected}
            attentionCount={attentionCount}
            onBell={() => setMobileTab("dashboard")}
            onRefresh={() => Promise.all([loadSessions(), loadProjects()])}
          />
          <div className="min-h-0 flex-1">
            {mobileTab === "dashboard" && (
              <Dashboard
                sessions={sessions}
                projects={projects}
                onOpen={selectAndClose}
                onSwitchProject={(dir) => void switchProject(dir)}
                onShowAll={() => setMobileTab("sessions")}
              />
            )}
            {mobileTab === "sessions" && (
              <div className="flex h-full flex-col">
                <ProjectPicker
                  projects={projects}
                  activeProjectDir={activeProjectDir}
                  fallbackName={connection?.workspaceName}
                  onSwitch={(dir) => void switchProject(dir)}
                />
                <div className="min-h-0 flex-1">
                  <SessionList
                    sessions={sessions}
                    selectedId={selectedId}
                    onSelect={selectAndClose}
                    onNew={startNew}
                    onRefresh={loadSessions}
                  />
                </div>
              </div>
            )}
            {mobileTab === "settings" && (
              <SettingsPage
                serverUrl={connection?.url}
                workspaceName={connection?.workspaceName}
                wsConnected={wsConnected}
                permissionMode={permissionMode}
                onPermissionChange={setPermissionMode}
                onDisconnect={() => setConnection(null)}
              />
            )}
          </div>
          <BottomTabs active={mobileTab} onChange={setMobileTab} />
        </div>
      )}

      {/* Main chat column — desktop always; mobile only in detail view */}
      <main
        className={`min-h-0 min-w-0 flex-1 flex-col md:flex ${mobileDetail ? "flex" : "hidden"}`}
      >
        {/* Mobile header */}
        <header className="flex shrink-0 items-center gap-2 border-b border-line bg-bg-alt px-2 py-2 pt-safe md:hidden">
          <button
            onClick={goBack}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-bg-raised transition-colors"
            aria-label="返回"
          >
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="truncate text-sm font-medium" style={{ maxWidth: "calc(100% - 150px)" }}>{selected?.title ?? "新会话"}</span>
          {selected?.isLive && <ConnDot ok={wsConnected} />}
          <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap ml-auto">
            <UsageDisplay />
          </div>
          <DetailMenu sessionId={selectedId} onDisconnect={() => setConnection(null)} />
        </header>

        {/* Desktop header */}
        <header className="hidden shrink-0 items-center gap-2 border-b border-line px-4 py-2.5 md:flex">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
            {selected?.title ?? "新会话"}
          </span>
          {selected?.isLive &&
            (selected.drivenByAgent ? (
              <Badge tone="ok">本端运行中</Badge>
            ) : (
              <Badge tone="warn">终端运行中</Badge>
            ))}
          <UsageDisplay />
          <button onClick={() => setConnection(null)} className="btn-ghost !py-1 text-xs">
            断开
          </button>
        </header>

        {/* Messages */}
        <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full overflow-y-auto overscroll-contain px-4 py-5 scroll-thin md:px-8"
        >
          {!selectedId && messages.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="mx-auto max-w-3xl">
              {loadingDetail && messages.length === 0 && (
                <p className="text-center text-sm text-ink-faint">加载中…</p>
              )}
              {hasMoreHistory && (
                <div className="mb-3 flex justify-center">
                  <button
                    onClick={() => void handleLoadEarlier()}
                    disabled={loadingEarlier}
                    className="rounded-full border border-line bg-bg-raised px-3 py-1 text-[12px] text-ink-dim transition-colors hover:text-ink disabled:opacity-60"
                  >
                    {loadingEarlier ? "加载更早…" : "加载更早的消息"}
                  </button>
                </div>
              )}
              <Timeline
                messages={messages}
                onFillInput={(t) => setDraft((d) => ({ text: t, nonce: d.nonce + 1 }))}
              />
              {stream && (
                <div className="mt-3">
                  <StreamingBubble
                    text={stream.text}
                    thinking={stream.thinking}
                    tools={stream.tools}
                  />
                </div>
              )}
              {externalLive && driveStatus === "idle" && (
                <div className="mt-4">
                  <LoadingBadge />
                </div>
              )}
              {driveStatus !== "streaming" && lastUsage?.sessionId === selectedId && (
                <UsageLine usage={lastUsage.usage} />
              )}
            </div>
          )}
        </div>
          {selectedId && !atBottom && (
            <button
              onClick={scrollToBottom}
              className="absolute bottom-3 right-3 grid h-9 w-9 place-items-center rounded-full border border-line bg-bg-raised text-ink shadow-lg transition-colors hover:border-accent/60"
              aria-label="回到最新"
              title={hasNew ? "有新内容，回到最新" : "回到最新"}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <polyline points="18 13 12 19 6 13" />
              </svg>
              {hasNew && (
                <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-accent ring-2 ring-bg" />
              )}
            </button>
          )}
        </div>

        {error && !liveConflict && <Toast message={error} onClose={clearError} />}

        {bPermission && (
          <div>
            {bPermission.live === false && (
              <p className="mx-auto mb-1 max-w-3xl px-1 text-[11px] text-ink-faint">
                这是之前挂起的问题，回答后会恢复该会话继续。
              </p>
            )}
            <QuestionPanel
              questions={bPermission.questions}
              onSubmit={(_text, structured) => {
                const answers: Record<string, string | string[]> = {};
                for (const a of structured) {
                  answers[a.question] = a.multiSelect ? a.labels : (a.labels[0] ?? "");
                }
                void answerPermission(answers);
              }}
            />
          </div>
        )}

        {pendingQuestions && !composerLocked && (
          <QuestionPanel
            questions={pendingQuestions}
            onSubmit={(answer) => void sendPrompt(answer, externalLive ? { force: true } : undefined)}
          />
        )}


        {composerLocked && (
          <div className="mx-auto mb-1 mt-1 flex max-w-3xl items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2">
            <span className="flex-1 text-warning text-xs">
              会话外部运行中，先接管才能发送
            </span>
            <button
              onClick={() => setTakeoverArmed(true)}
              className="btn !bg-warning hover:!bg-warning/80 !py-1 text-xs"
            >
              接管它
            </button>
          </div>
        )}

        {driveStatus !== "streaming" && (
          <div className="mx-auto flex max-w-3xl items-center gap-2 px-3 pt-1.5 md:px-8">
            <div className="min-w-0 flex-1">
              {selectedId && <QuickActions onPick={(p) => handleSend(p)} disabled={composerLocked} />}
            </div>
            <PermissionSelect value={permissionMode} onChange={setPermissionMode} />
          </div>
        )}

        <Composer
          onSend={handleSend}
          onInterrupt={() => void interrupt()}
          streaming={driveStatus === "streaming"}
          disabled={composerLocked}
          prefill={draft}
          placeholder={
            composerLocked
              ? "运行中·先接管…"
              : takeoverArmed
                ? "接管并续写…"
                : selectedId
                  ? "续写会话…"
                  : "开启新会话…"
          }
        />
      </main>

      {/* Live-takeover confirmation */}
      {(pendingPrompt !== null || liveConflict) && (
        <ConfirmTakeover
          message={liveConflict ?? "该会话在终端仍活跃，确认要从这里接管吗？"}
          onCancel={() => {
            setPendingPrompt(null);
            clearError();
          }}
          onConfirm={() => {
            const p = pendingPrompt;
            setPendingPrompt(null);
            clearError();
            if (p) void sendPrompt(p, { force: true });
          }}
        />
      )}
    </div>
  );
}

// Shared mobile home header — logo + title + connection dot, with usage 余量,
// a notification bell (badge = needs-attention count), and a refresh button.
function HomeHeader({
  title,
  wsConnected,
  attentionCount,
  onBell,
  onRefresh,
}: {
  title: string;
  wsConnected: boolean;
  attentionCount: number;
  onBell: () => void;
  onRefresh: () => void | Promise<unknown>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  async function doRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      // keep the spin visible long enough to read as a deliberate refresh
      setTimeout(() => setRefreshing(false), 500);
    }
  }
  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-line bg-bg-alt px-3 py-2.5 pt-safe">
      <ClaudeLogo size={22} className="text-[#D97757]" />
      <span className="text-[17px] font-semibold text-ink">{title}</span>
      <ConnDot ok={wsConnected} />
      <div className="ml-auto flex items-center gap-1.5">
        <UsageDisplay />
        <button
          onClick={onBell}
          aria-label="需要处理的会话"
          className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-line text-ink-dim transition-colors hover:bg-bg-raised hover:text-ink"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
          {attentionCount > 0 && (
            <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white">
              {attentionCount > 9 ? "9+" : attentionCount}
            </span>
          )}
        </button>
        <button
          onClick={() => void doRefresh()}
          disabled={refreshing}
          aria-label="刷新"
          title="刷新"
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-line text-ink-dim transition-colors hover:bg-bg-raised hover:text-ink disabled:opacity-60"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={refreshing ? "animate-spin" : ""}>
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <polyline points="21 3 21 9 15 9" />
          </svg>
        </button>
      </div>
    </header>
  );
}

function Brand({
  projects,
  activeProjectDir,
  fallbackName,
  wsConnected,
  onSwitch,
}: {
  projects: ClaudeProject[];
  activeProjectDir: string | null;
  fallbackName?: string;
  wsConnected: boolean;
  onSwitch: (dir: string) => void;
}) {
  return (
    <div>
      <div className="flex h-13 items-center gap-2 px-4 py-3 pt-safe">
        <ClaudeLogo size={18} className="text-[#D97757]" />
        <span className="text-sm font-semibold text-ink">Claude Console</span>
        <ConnDot ok={wsConnected} />
      </div>
      <ProjectPicker
        projects={projects}
        activeProjectDir={activeProjectDir}
        fallbackName={fallbackName}
        onSwitch={onSwitch}
      />
    </div>
  );
}

function ProjectPicker({
  projects,
  activeProjectDir,
  fallbackName,
  onSwitch,
}: {
  projects: ClaudeProject[];
  activeProjectDir: string | null;
  fallbackName?: string;
  onSwitch: (dir: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = projects.find((p) => p.dir === activeProjectDir);
  const activeName = active?.name ?? fallbackName ?? "项目";
  return (
    <div className="relative border-b border-line">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 border-t border-line/60 px-4 py-2.5 text-left text-[13px] hover:bg-bg-raised"
        title="切换项目"
      >
        <span className="shrink-0 text-ink-faint">项目</span>
        <span className="truncate font-medium text-ink">{activeName}</span>
        {active && active.liveCount > 0 && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
        )}
        <span className="ml-auto shrink-0 text-ink-faint">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute left-2 right-2 top-full z-30 mt-1 max-h-[70vh] overflow-y-auto rounded-xl border border-line bg-bg-raised shadow-2xl scroll-thin">
            <div className="flex gap-1 border-b border-line/40 p-1.5">
              <input
                type="text"
                placeholder="输入项目路径…"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.currentTarget.value.trim()) {
                    onSwitch(e.currentTarget.value.trim());
                    setOpen(false);
                  }
                }}
                className="flex-1 rounded-lg bg-bg px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint outline-none focus:ring-1 focus:ring-accent/50"
              />
            </div>
            <div className="p-1.5">
              {projects.length === 0 && (
                <p className="px-3 py-4 text-center text-sm text-ink-faint">没有发现项目</p>
              )}
              {projects.map((p) => (
                <button
                  key={p.dir}
                  onClick={() => {
                    onSwitch(p.dir);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left hover:bg-bg-alt ${
                    p.dir === activeProjectDir ? "bg-bg-alt" : ""
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-medium text-ink">{p.name}</span>
                      {p.liveCount > 0 && (
                        <span className="shrink-0 rounded-full bg-success/20 px-1.5 py-0.5 text-[10px] font-medium text-success">
                          {p.liveCount} live
                        </span>
                      )}
                    </div>
                    <div className="truncate text-[11px] text-ink-faint">{p.cwd}</div>
                  </div>
                  <span className="shrink-0 text-[12px] text-ink-faint">{p.sessionCount} 会话</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

type PermMode = import("@mac/shared").ClaudePermissionMode;
const PERM_OPTIONS: { value: PermMode; label: string; hint: string }[] = [
  { value: "plan", label: "计划", hint: "只规划不执行" },
  { value: "auto", label: "自动", hint: "按风险放行" },
  { value: "acceptEdits", label: "接受编辑", hint: "自动改文件" },
  { value: "default", label: "默认", hint: "" },
  { value: "bypassPermissions", label: "全部放行", hint: "危险" },
];

function PermissionSelect({
  value,
  onChange,
}: {
  value: PermMode;
  onChange: (m: PermMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = PERM_OPTIONS.find((o) => o.value === value) ?? PERM_OPTIONS[2];
  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-full border border-line bg-bg-raised px-2.5 py-1 text-[12px] text-ink-dim transition-colors hover:text-ink"
        title="权限模式"
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2l8 3v6c0 5-3.5 8-8 11-4.5-3-8-6-8-11V5z" />
        </svg>
        {current!.label}
        <span className="text-ink-faint">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-0 z-30 mb-1.5 w-44 overflow-hidden rounded-xl border border-line bg-bg-raised p-1 shadow-2xl">
            {PERM_OPTIONS.map((o) => (
              <button
                key={o.value}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-bg-alt ${
                  o.value === value ? "bg-bg-alt" : ""
                }`}
              >
                <span className="w-3 shrink-0 text-accent">{o.value === value ? "✓" : ""}</span>
                <span className="text-ink">{o.label}</span>
                {o.hint && (
                  <span
                    className={`ml-auto text-[10.5px] ${
                      o.value === "bypassPermissions" ? "text-danger/80" : "text-ink-faint"
                    }`}
                  >
                    {o.hint}
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function UsageLine({ usage }: { usage: import("@mac/shared").ClaudeUsage }) {
  const parts: string[] = [];
  if (usage.durationMs != null) parts.push(`${(usage.durationMs / 1000).toFixed(1)}s`);
  if (usage.outputTokens != null) parts.push(`↓${fmtTokens(usage.outputTokens)}`);
  if (usage.inputTokens != null) parts.push(`↑${fmtTokens(usage.inputTokens)}`);
  if (usage.costUsd != null) parts.push(`$${usage.costUsd.toFixed(usage.costUsd < 0.01 ? 4 : 3)}`);
  if (parts.length === 0) return null;
  return <div className="mt-2 px-0.5 text-[11px] text-ink-faint">本轮 · {parts.join(" · ")}</div>;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <ClaudeLogo size={40} className="mb-3 text-[#D97757]" />
      <h2 className="text-lg font-medium text-ink">开启一个 Claude Code 会话</h2>
      <p className="mt-2 max-w-xs text-sm text-ink-dim">
        在下方输入任务即可新建会话，或从左侧选择一个历史会话继续。
      </p>
    </div>
  );
}

const WORKING_VERBS = [
  "探索中",
  "酝酿中",
  "钻研中",
  "运算中",
  "编织中",
  "捣鼓中",
  "推敲中",
  "熬煮中",
  "琢磨中",
  "捣腾中",
];

function Working() {
  const [i, setI] = useState(0);
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const v = setInterval(() => setI((x) => (x + 1) % WORKING_VERBS.length), 2600);
    const t = setInterval(() => setSec((s) => s + 1), 1000);
    return () => {
      clearInterval(v);
      clearInterval(t);
    };
  }, []);
  return (
    <p className="flex items-center gap-2 text-[13px] text-ink-dim">
      <ClaudeLogo size={14} className="animate-spin text-[#D97757] [animation-duration:2.6s]" />
      <span>{WORKING_VERBS[i]}…</span>
      <span className="text-ink-faint">{sec}s · esc 中断</span>
    </p>
  );
}

function StreamingBubble({
  text,
  thinking,
  tools,
}: {
  text: string;
  thinking: string;
  tools: string[];
}) {
  // tail of the live thinking stream so it visibly moves before answer text
  const thinkingTail = thinking ? thinking.slice(-260) : "";
  return (
    <div className="space-y-1.5">
      <Working />
      {!text && thinkingTail && (
        <p className="whitespace-pre-wrap break-words border-l-2 border-line pl-2 text-[12.5px] italic text-ink-dim">
          {thinkingTail}
          <span className="cursor-blink"> </span>
        </p>
      )}
      {tools.map((t, i) => (
        <p key={i} className="flex items-center gap-1.5 font-mono text-[13px] text-info">
          <span className="h-1.5 w-1.5 rounded-full bg-info" />
          {t}
        </p>
      ))}
      {/* plain text while streaming (cheap); committed message renders markdown */}
      {text && (
        <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink cursor-blink">
          {text}
        </p>
      )}
    </div>
  );
}

function ConfirmTakeover({
  message,
  onConfirm,
  onCancel,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-bg-alt p-5">
        <h3 className="text-base font-semibold text-warning">⚠ 会话仍活跃</h3>
        <p className="mt-2 text-sm text-ink-dim">{message}</p>
        <p className="mt-2 text-xs text-ink-faint">
          强制接管会在该会话上另起一个进程，可能与终端里正在运行的进程冲突。
        </p>
        <div className="mt-4 flex gap-2">
          <button onClick={onCancel} className="btn-ghost flex-1">
            取消
          </button>
          <button onClick={onConfirm} className="btn flex-1 !bg-warning hover:!bg-warning/80">
            强制接管
          </button>
        </div>
      </div>
    </div>
  );
}

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="mx-auto mb-2 mt-1 flex max-w-3xl items-center gap-2 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
      <span className="flex-1">{message}</span>
      <button onClick={onClose} className="text-danger/70 hover:text-danger">
        ✕
      </button>
    </div>
  );
}

function Badge({ children, tone = "ok" }: { children: React.ReactNode; tone?: "ok" | "warn" }) {
  const cls =
    tone === "warn"
      ? "bg-warning/20 text-warning"
      : "bg-success/20 text-success";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>
  );
}

function DetailMenu({ sessionId, onDisconnect }: { sessionId: string | null; onDisconnect: () => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  async function copyId() {
    if (!sessionId) return;
    try {
      await navigator.clipboard.writeText(sessionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked (insecure context) — ignore */
    }
  }
  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-bg-raised transition-colors text-lg leading-none"
        aria-label="更多"
      >
        ⋯
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-xl border border-line bg-bg-raised p-1 shadow-2xl">
            <MenuItem
              label={copied ? "已复制 ✓" : "复制会话 ID"}
              disabled={!sessionId}
              onClick={() => void copyId()}
            />
            <MenuItem label="刷新页面" onClick={() => window.location.reload()} />
            <MenuItem
              label="断开连接"
              danger
              onClick={() => {
                setOpen(false);
                onDisconnect();
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  label,
  onClick,
  danger,
  disabled,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`block w-full rounded-lg px-3 py-2 text-left text-[13px] hover:bg-bg-alt disabled:opacity-40 ${
        danger ? "text-danger" : "text-ink"
      }`}
    >
      {label}
    </button>
  );
}

function ConnDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-success" : "bg-ink-faint"}`}
      title={ok ? "已连接" : "未连接"}
    />
  );
}
