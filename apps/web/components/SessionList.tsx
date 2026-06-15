"use client";

import { useMemo, useRef, useState, type TouchEvent } from "react";
import type { ClaudeSession } from "@mac/shared";

export function SessionList({
  sessions,
  selectedId,
  onSelect,
  onNew,
  onRefresh,
}: {
  sessions: ClaudeSession[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRefresh?: () => void | Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [collapsed, setCollapsed] = useState({ today: false, thisWeek: false, older: true });
  const startY = useRef<number | null>(null);
  const ulRef = useRef<HTMLUListElement>(null);

  function onTouchStart(e: TouchEvent) {
    startY.current = (ulRef.current?.scrollTop ?? 0) <= 0 ? e.touches[0]!.clientY : null;
  }
  function onTouchMove(e: TouchEvent) {
    if (startY.current == null || refreshing) return;
    const dy = e.touches[0]!.clientY - startY.current;
    if (dy > 0) setPull(Math.min(dy * 0.5, 64));
  }
  async function onTouchEnd() {
    if (pull > 48 && onRefresh) {
      setRefreshing(true);
      try {
        await onRefresh();
      } finally {
        setRefreshing(false);
      }
    }
    setPull(0);
    startY.current = null;
  }
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(t));
  }, [sessions, q]);

  const grouped = useMemo(() => {
    const now = Date.now();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();
    const weekAgoMs = todayMs - 7 * 24 * 60 * 60 * 1000;

    const groups = {
      today: [] as ClaudeSession[],
      thisWeek: [] as ClaudeSession[],
      older: [] as ClaudeSession[],
    };

    filtered.forEach((s) => {
      const t = Date.parse(s.updatedAt);
      if (t >= todayMs) {
        groups.today.push(s);
      } else if (t >= weekAgoMs) {
        groups.thisWeek.push(s);
      } else {
        groups.older.push(s);
      }
    });

    return groups;
  }, [filtered]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 p-3">
        <button onClick={onNew} className="btn flex-1 text-sm">
          ＋ 新会话
        </button>
      </div>
      <div className="px-3 pb-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索会话…"
          className="field text-sm"
        />
      </div>
      <ul
        ref={ulRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        className="flex-1 space-y-1 overflow-y-auto px-2 pb-3 scroll-thin"
        style={{ transform: pull ? `translateY(${pull}px)` : undefined, transition: pull ? "none" : "transform 0.2s" }}
      >
        {(pull > 0 || refreshing) && (
          <li
            className="flex items-center justify-center text-[12px] text-ink-faint"
            style={{ height: refreshing ? 28 : pull, marginTop: refreshing ? 0 : -pull }}
          >
            {refreshing ? "刷新中…" : pull > 48 ? "释放刷新" : "下拉刷新"}
          </li>
        )}
        {filtered.length === 0 && (
          <li className="px-3 py-6 text-center text-sm text-ink-faint">暂无会话</li>
        )}
        {grouped.today.length > 0 && (
          <>
            <li>
              <button
                onClick={() => setCollapsed((c) => ({ ...c, today: !c.today }))}
                className="sticky top-0 flex w-full items-center gap-2 bg-bg px-3 py-2 text-xs font-medium text-ink-faint hover:bg-bg-alt"
              >
                <span>{collapsed.today ? "▶" : "▼"}</span>
                <span>🌅 今天</span>
                <span className="ml-auto text-ink-faint text-[11px]">{grouped.today.length}</span>
              </button>
            </li>
            {!collapsed.today && grouped.today.map((s) => <SessionItem key={s.id} session={s} selectedId={selectedId} onSelect={onSelect} />)}
          </>
        )}
        {grouped.thisWeek.length > 0 && (
          <>
            <li>
              <button
                onClick={() => setCollapsed((c) => ({ ...c, thisWeek: !c.thisWeek }))}
                className="sticky top-0 flex w-full items-center gap-2 bg-bg px-3 py-2 text-xs font-medium text-ink-faint hover:bg-bg-alt"
              >
                <span>{collapsed.thisWeek ? "▶" : "▼"}</span>
                <span>📅 本周</span>
                <span className="ml-auto text-ink-faint text-[11px]">{grouped.thisWeek.length}</span>
              </button>
            </li>
            {!collapsed.thisWeek && grouped.thisWeek.map((s) => <SessionItem key={s.id} session={s} selectedId={selectedId} onSelect={onSelect} />)}
          </>
        )}
        {grouped.older.length > 0 && (
          <>
            <li>
              <button
                onClick={() => setCollapsed((c) => ({ ...c, older: !c.older }))}
                className="sticky top-0 flex w-full items-center gap-2 bg-bg px-3 py-2 text-xs font-medium text-ink-faint hover:bg-bg-alt"
              >
                <span>{collapsed.older ? "▶" : "▼"}</span>
                <span>🗂️ 更早</span>
                <span className="ml-auto text-ink-faint text-[11px]">{grouped.older.length}</span>
              </button>
            </li>
            {!collapsed.older && grouped.older.map((s) => <SessionItem key={s.id} session={s} selectedId={selectedId} onSelect={onSelect} />)}
          </>
        )}
      </ul>
    </div>
  );
}

function SessionItem({
  session,
  selectedId,
  onSelect,
}: {
  session: ClaudeSession;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <li>
      <button
        onClick={() => onSelect(session.id)}
        className={`w-full rounded-xl px-3 py-2 text-left transition-colors ${
          session.id === selectedId ? "bg-bg-raised" : "hover:bg-bg-alt"
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="flex-1 truncate text-sm text-ink">{session.title}</span>
          {session.isLive &&
            (session.drivenByAgent ? (
              <span className="shrink-0 rounded-full bg-success/20 px-1.5 py-0.5 text-[10px] font-medium text-success">
                本端
              </span>
            ) : (
              <span className="shrink-0 rounded-full bg-warning/20 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                终端
              </span>
            ))}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-ink-faint">
          <span>{session.messageCount} 条</span>
          {session.toolUseCount > 0 && <span>· {session.toolUseCount} 工具</span>}
          <span className="ml-auto">{relTime(session.updatedAt)}</span>
        </div>
      </button>
    </li>
  );
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  const d = Math.floor(h / 24);
  return `${d}天前`;
}
