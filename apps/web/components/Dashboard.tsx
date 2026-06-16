"use client";

import { useRef, useState } from "react";
import type { ClaudeProject, ClaudeSession } from "@mac/shared";

const RECENT_DONE_MS = 60 * 60 * 1000; // a "done" session newer than this is "awaiting next step"
const RECENT_LIMIT = 5;

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function ageMs(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Date.now() - t : Infinity;
}

function projName(cwd: string): string {
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

/** Dynamic card title: Haiku summary → latest user instruction → opening title. */
function cardTitle(s: ClaudeSession): string {
  return s.currentTask || s.lastUserText || s.title;
}

/* ── icons ─────────────────────────────────────────────────────────── */
const sw = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function TypeIcon({ name, size = 18 }: { name: string; size?: number }) {
  const n = name.toLowerCase();
  const p = { viewBox: "0 0 24 24", width: size, height: size, ...sw } as const;
  if (/mobile|app|android|ios|flutter|rn/.test(n))
    return <svg {...p}><rect x="6" y="2" width="12" height="20" rx="2" /><line x1="11" y1="18" x2="13" y2="18" /></svg>;
  if (/web|dashboard|site|front|ui|next/.test(n))
    return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>;
  if (/doc|readme|md|wiki/.test(n))
    return <svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>;
  if (/data|pipeline|db|sql|etl/.test(n))
    return <svg {...p}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></svg>;
  return <svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
}

const ATT = {
  question: {
    label: "等待你的回答",
    badge: "bg-accent/20 text-accent",
    accent: "border-l-accent",
    tile: "bg-accent/15 text-accent",
    icon: (s: number) => <svg viewBox="0 0 24 24" width={s} height={s} {...sw}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>,
  },
  approval: {
    label: "待批准工具",
    badge: "bg-accent/20 text-accent",
    accent: "border-l-accent",
    tile: "bg-accent/15 text-accent",
    icon: (s: number) => <svg viewBox="0 0 24 24" width={s} height={s} {...sw}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>,
  },
  error: {
    label: "执行出错",
    badge: "bg-danger/20 text-danger",
    accent: "border-l-danger",
    tile: "bg-danger/15 text-danger",
    icon: (s: number) => <svg viewBox="0 0 24 24" width={s} height={s} {...sw}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12" y2="17" /></svg>,
  },
  done: {
    label: "等待下一步",
    badge: "bg-warning/20 text-warning",
    accent: "border-l-warning",
    tile: "bg-warning/15 text-warning",
    icon: (s: number) => <svg viewBox="0 0 24 24" width={s} height={s} {...sw}><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" /></svg>,
  },
} as const;

type AttKind = keyof typeof ATT;

/** Bottom meta line shared by all cards: 项目名 · [消息 N ·] 时间 等次要信息。 */
function MetaLine({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 flex items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-faint">{children}</div>;
}

/* ── 需要你处理 卡片（点击进会话；右滑忽略）─────────────────────────── */
const SWIPE_THRESHOLD = 90;
function AttentionCard({
  s,
  kind,
  onOpen,
  onIgnore,
}: {
  s: ClaudeSession;
  kind: AttKind;
  onOpen: (id: string) => void;
  onIgnore: (id: string) => void;
}) {
  const a = ATT[kind];
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startX = useRef<number | null>(null);
  const dxRef = useRef(0);
  const moved = useRef(false);

  function onTouchStart(e: React.TouchEvent) {
    startX.current = e.touches[0]!.clientX;
    moved.current = false;
    setDragging(true);
  }
  function onTouchMove(e: React.TouchEvent) {
    if (startX.current == null) return;
    const d = e.touches[0]!.clientX - startX.current; // right-swipe → positive
    if (Math.abs(d) > 6) moved.current = true;
    dxRef.current = Math.max(0, d);
    setDx(dxRef.current);
  }
  function onTouchEnd() {
    setDragging(false);
    startX.current = null;
    if (dxRef.current > SWIPE_THRESHOLD) {
      setDx(600); // slide out, then drop from the list
      setTimeout(() => onIgnore(s.id), 160);
    } else {
      setDx(0);
    }
    dxRef.current = 0;
  }

  return (
    <div className="relative overflow-hidden rounded-xl">
      {/* revealed behind the card as it slides right */}
      <div className="absolute inset-0 flex items-center gap-1.5 rounded-xl bg-bg-raised pl-4 text-[12px] font-medium text-ink-dim">
        <svg viewBox="0 0 24 24" width="16" height="16" {...sw}>
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
        忽略
      </div>
      <div
        onClick={() => {
          if (!moved.current) onOpen(s.id);
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{ transform: `translateX(${dx}px)`, transition: dragging ? "none" : "transform .16s ease-out" }}
        className={`relative rounded-xl border border-line border-l-2 bg-bg-alt p-3 text-left transition-colors hover:bg-bg-raised ${a.accent}`}
      >
        <div className="flex items-start gap-3">
          <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${a.tile}`}>{a.icon(18)}</div>
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-[14px] font-medium leading-snug text-ink">{cardTitle(s)}</div>
            <MetaLine>
              <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${a.badge}`}>{a.label}</span>
              <span className="truncate">{projName(s.cwd)}</span>
              <span className="shrink-0">· {relTime(s.updatedAt)}</span>
            </MetaLine>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── 正在运行 行 ───────────────────────────────────────────────────── */
function RunningRow({ s, onOpen }: { s: ClaudeSession; onOpen: (id: string) => void }) {
  return (
    <button onClick={() => onOpen(s.id)} className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-bg-raised">
      <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-success/15 text-success"><TypeIcon name={projName(s.cwd)} size={16} /></div>
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-[13px] font-medium leading-snug text-ink">{cardTitle(s)}</div>
        <div className="mt-0.5 truncate text-[11px] text-success">{s.lastActivity ? `正在 ${s.lastActivity}` : "思考中…"}</div>
        <MetaLine>
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-success" />
          <span className="truncate">{projName(s.cwd)}</span>
          <span className="shrink-0">· 消息 {s.messageCount}</span>
          <span className="shrink-0">· {relTime(s.updatedAt)}</span>
        </MetaLine>
      </div>
    </button>
  );
}

/* ── 最近完成 行 ───────────────────────────────────────────────────── */
function DoneRow({ s, onOpen }: { s: ClaudeSession; onOpen: (id: string) => void }) {
  const dur = s.createdAt ? Math.round((new Date(s.updatedAt).getTime() - new Date(s.createdAt).getTime()) / 60000) : null;
  return (
    <button onClick={() => onOpen(s.id)} className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-bg-raised">
      <svg viewBox="0 0 24 24" width="18" height="18" {...sw} className="mt-0.5 shrink-0 text-warning"><circle cx="12" cy="12" r="9" /><polyline points="8.5 12 11 14.5 15.5 9.5" /></svg>
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-[13px] font-medium leading-snug text-ink">{cardTitle(s)}</div>
        {s.lastResult && <div className="mt-0.5 truncate text-[11px] text-ink-dim">{s.lastResult}</div>}
        <MetaLine>
          <span className="truncate">{projName(s.cwd)}</span>
          <span className="shrink-0">· {relTime(s.updatedAt)}</span>
          {dur != null && <span className="shrink-0">· 耗时 {dur}m</span>}
        </MetaLine>
      </div>
    </button>
  );
}

/* ── 顶部项目切换栏（聚焦 + 活动徽章 + 搜索）────────────────────────── */
function PillBadges({ run, need }: { run: number; need: number }) {
  if (!run && !need) return null;
  return (
    <span className="ml-1 flex shrink-0 items-center gap-1">
      {need > 0 && (
        <span className="rounded-full bg-accent/20 px-1.5 text-[10px] font-medium text-accent">{need}</span>
      )}
      {run > 0 && (
        <span className="flex items-center gap-0.5 text-[10px] text-success">
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          {run}
        </span>
      )}
    </span>
  );
}

function Pill({
  label,
  active,
  run,
  need,
  onClick,
}: {
  label: string;
  active: boolean;
  run: number;
  need: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex shrink-0 items-center whitespace-nowrap rounded-full border px-3 py-1.5 text-[12px] transition-colors ${
        active ? "border-accent bg-accent/15 text-accent" : "border-line bg-bg-alt text-ink-dim hover:border-accent/40"
      }`}
    >
      <span className="max-w-[140px] truncate font-medium">{label}</span>
      <PillBadges run={run} need={need} />
    </button>
  );
}

function ProjectBar({
  projects,
  focus,
  onFocus,
  statByCwd,
  totalRun,
  totalNeed,
}: {
  projects: ClaudeProject[];
  focus: string | null;
  onFocus: (dir: string | null) => void;
  statByCwd: Map<string, { run: number; need: number }>;
  totalRun: number;
  totalNeed: number;
}) {
  const [q, setQ] = useState("");
  const searchable = projects.length > 6;
  const list = q
    ? projects.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
    : projects;
  if (projects.length === 0) return null;
  return (
    <div className="sticky top-0 z-10 border-b border-line bg-bg/95 px-3 py-2 backdrop-blur">
      {searchable && (
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索项目…"
          className="mb-2 w-full rounded-lg border border-line bg-bg-alt px-2.5 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent/50"
        />
      )}
      <div className="flex gap-1.5 overflow-x-auto pb-0.5 scroll-thin">
        <Pill label="全部" active={focus == null} run={totalRun} need={totalNeed} onClick={() => onFocus(null)} />
        {list.map((p) => {
          const st = statByCwd.get(p.cwd) ?? { run: 0, need: 0 };
          return (
            <Pill
              key={p.dir}
              label={p.name}
              active={focus === p.dir}
              run={st.run}
              need={st.need}
              onClick={() => onFocus(p.dir)}
            />
          );
        })}
      </div>
    </div>
  );
}

function SectionHead({ title, count, color, right }: { title: string; count: number; color: string; right?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <h2 className={`text-[13px] font-semibold ${color}`}>{title}</h2>
      <span className="grid h-4 min-w-4 place-items-center rounded-full bg-line px-1 text-[10px] text-ink-dim">{count}</span>
      {right && <span className="ml-auto text-[12px] text-ink-faint">{right}</span>}
    </div>
  );
}

export function Dashboard({
  sessions,
  projects,
  focus,
  onFocus,
  onOpen,
  onShowAll,
  onIgnore,
}: {
  /** ALL sessions across projects (overview); filtered locally by `focus`. */
  sessions: ClaudeSession[];
  projects: ClaudeProject[];
  /** focused project dir, or null for the all-projects overview */
  focus: string | null;
  onFocus: (dir: string | null) => void;
  onOpen: (id: string) => void;
  onShowAll: () => void;
  /** swipe-to-ignore an attention card (e.g. dismiss the pending question) */
  onIgnore: (id: string) => void;
}) {
  // locally-hidden cards (swiped away this session) — instant removal on top of the
  // backend dismiss, so the card disappears even for kinds with no server-side dismiss.
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  function ignore(id: string) {
    setIgnored((prev) => new Set(prev).add(id));
    onIgnore(id);
  }

  // Focus = look at one project only (its cwd); null = all-projects overview.
  const focusCwd = focus ? projects.find((p) => p.dir === focus)?.cwd : undefined;
  const view = focusCwd ? sessions.filter((s) => s.cwd === focusCwd) : sessions;

  const attentionOf = (s: ClaudeSession): AttKind | null => {
    if (ignored.has(s.id)) return null;
    if (s.attention === "approval") return "approval";
    if (s.attention === "question") return "question";
    if (s.attention === "error") return "error";
    if (s.attention === "done" && !s.isLive && ageMs(s.updatedAt) < RECENT_DONE_MS) return "done";
    return null;
  };

  const needs = view.map((s) => ({ s, k: attentionOf(s) })).filter((x): x is { s: ClaudeSession; k: AttKind } => x.k != null);
  const needIds = new Set(needs.map((x) => x.s.id));
  // "正在运行" = a turn is actively in flight (hook ∪ our driver). NOT isLive — that
  // also counts idle-but-attached sessions (e.g. many open VSCode tabs), over-reporting.
  const running = view.filter((s) => s.driving && !needIds.has(s.id));
  const runIds = new Set(running.map((s) => s.id));
  const recentDone = view.filter((s) => !needIds.has(s.id) && !runIds.has(s.id)).slice(0, RECENT_LIMIT);

  // Per-project activity badges (from ALL sessions) so you can triage across projects
  // without leaving the focused view.
  const statByCwd = new Map<string, { run: number; need: number }>();
  for (const s of sessions) {
    const st = statByCwd.get(s.cwd) ?? { run: 0, need: 0 };
    const need =
      s.attention === "approval" || s.attention === "question" || s.attention === "error";
    if (need) st.need += 1;
    else if (s.driving) st.run += 1;
    statByCwd.set(s.cwd, st);
  }
  const totalRun = [...statByCwd.values()].reduce((a, b) => a + b.run, 0);
  const totalNeed = [...statByCwd.values()].reduce((a, b) => a + b.need, 0);

  // swipe the body left/right to move focus across [全部, ...projects]
  const order: (string | null)[] = [null, ...projects.map((p) => p.dir)];
  const swipeStart = { x: 0, y: 0 };
  function onSwipeStart(e: React.TouchEvent) {
    swipeStart.x = e.touches[0]!.clientX;
    swipeStart.y = e.touches[0]!.clientY;
  }
  function onSwipeEnd(e: React.TouchEvent) {
    const dx = e.changedTouches[0]!.clientX - swipeStart.x;
    const dy = e.changedTouches[0]!.clientY - swipeStart.y;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const i = order.indexOf(focus);
    const next = dx < 0 ? i + 1 : i - 1;
    if (next >= 0 && next < order.length) onFocus(order[next]!);
  }

  if (sessions.length === 0 && projects.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <p className="text-sm text-ink-dim">还没有会话</p>
        <p className="mt-1 text-xs text-ink-faint">在 Sessions 页用「+」开启一个新会话</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ProjectBar
        projects={projects}
        focus={focus}
        onFocus={onFocus}
        statByCwd={statByCwd}
        totalRun={totalRun}
        totalNeed={totalNeed}
      />
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 scroll-thin"
        onTouchStart={onSwipeStart}
        onTouchEnd={onSwipeEnd}
      >
        {view.length === 0 && (
          <p className="mt-10 text-center text-[13px] text-ink-faint">该项目暂无会话</p>
        )}
      {needs.length > 0 && (
        <section className="mb-5">
          <SectionHead title="需要你处理" count={needs.length} color="text-accent" />
          <div className="space-y-2.5">
            {needs.map(({ s, k }) => (
              <AttentionCard key={s.id} s={s} kind={k} onOpen={onOpen} onIgnore={ignore} />
            ))}
          </div>
        </section>
      )}

      {running.length > 0 && (
        <section className="mb-5 rounded-xl border border-line bg-bg-alt p-2">
          <div className="px-1">
            <SectionHead title="正在运行" count={running.length} color="text-success" right={<button onClick={onShowAll}>查看全部 ›</button>} />
          </div>
          <div className="space-y-0.5">
            {running.map((s) => (
              <RunningRow key={s.id} s={s} onOpen={onOpen} />
            ))}
          </div>
        </section>
      )}

      {recentDone.length > 0 && (
        <section className="mb-5 rounded-xl border border-line bg-bg-alt p-2">
          <div className="px-1">
            <SectionHead title="最近完成" count={recentDone.length} color="text-warning" right={<button onClick={onShowAll}>查看全部 ›</button>} />
          </div>
          <div className="space-y-0.5">
            {recentDone.map((s) => (
              <DoneRow key={s.id} s={s} onOpen={onOpen} />
            ))}
          </div>
        </section>
      )}

      </div>
    </div>
  );
}
