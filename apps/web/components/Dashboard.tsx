"use client";

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

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 rounded bg-bg px-1.5 py-0.5 text-[10px] text-ink-dim">{children}</span>;
}

/* ── 需要你处理 卡片（整卡可点进会话）─────────────────────────────── */
function AttentionCard({ s, kind, onOpen }: { s: ClaudeSession; kind: AttKind; onOpen: (id: string) => void }) {
  const a = ATT[kind];
  return (
    <button
      onClick={() => onOpen(s.id)}
      className={`w-full rounded-xl border border-line border-l-2 bg-bg-alt p-3 text-left transition-colors hover:bg-bg-raised ${a.accent}`}
    >
      <div className="flex items-start gap-3">
        <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${a.tile}`}>{a.icon(18)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium text-ink">{s.title}</span>
            <Tag>{projName(s.cwd)}</Tag>
            <span className={`ml-auto shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-medium ${a.badge}`}>{a.label}</span>
            <span className="shrink-0 whitespace-nowrap text-[11px] text-ink-faint">{relTime(s.updatedAt)}</span>
          </div>
          {s.preview && <p className="mt-1 line-clamp-2 text-[12px] text-ink-dim">{s.preview}</p>}
        </div>
      </div>
    </button>
  );
}

/* ── 正在运行 行 ───────────────────────────────────────────────────── */
function RunningRow({ s, onOpen }: { s: ClaudeSession; onOpen: (id: string) => void }) {
  return (
    <button onClick={() => onOpen(s.id)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-bg-raised">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-success/15 text-success"><TypeIcon name={projName(s.cwd)} size={16} /></div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-ink">{projName(s.cwd)}</span>
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
        </div>
        <div className="truncate text-[11px] text-ink-faint">{s.preview ?? s.title}</div>
      </div>
      <div className="shrink-0 text-right">
        <div className="whitespace-nowrap text-[11px] text-ink-dim">消息 {s.messageCount} · 工具 {s.toolUseCount}</div>
        <div className="text-[11px] text-ink-faint">{relTime(s.updatedAt)}</div>
      </div>
    </button>
  );
}

/* ── 最近完成 行 ───────────────────────────────────────────────────── */
function DoneRow({ s, onOpen }: { s: ClaudeSession; onOpen: (id: string) => void }) {
  const dur = s.createdAt ? Math.round((new Date(s.updatedAt).getTime() - new Date(s.createdAt).getTime()) / 60000) : null;
  return (
    <button onClick={() => onOpen(s.id)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-bg-raised">
      <svg viewBox="0 0 24 24" width="18" height="18" {...sw} className="shrink-0 text-warning"><circle cx="12" cy="12" r="9" /><polyline points="8.5 12 11 14.5 15.5 9.5" /></svg>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-ink">{s.title}</span>
          <Tag>{projName(s.cwd)}</Tag>
        </div>
        <div className="truncate text-[11px] text-ink-faint">已完成{dur != null ? ` · 总耗时 ${dur}m` : ""}</div>
      </div>
      <span className="shrink-0 whitespace-nowrap text-[11px] text-ink-faint">{relTime(s.updatedAt)}</span>
    </button>
  );
}

/* ── 快速切换项目 chip ─────────────────────────────────────────────── */
function ProjectChip({ p, onSwitch }: { p: ClaudeProject; onSwitch: (dir: string) => void }) {
  return (
    <button onClick={() => onSwitch(p.dir)} className="flex w-44 shrink-0 items-center gap-2 rounded-xl border border-line bg-bg-alt px-3 py-2.5 text-left transition-colors hover:border-accent/50">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-bg text-ink-dim"><TypeIcon name={p.name} size={16} /></div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-ink">{p.name}</div>
        <div className="text-[10px] text-ink-faint">{p.sessionCount} 个会话</div>
      </div>
      {p.liveCount > 0 && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />}
    </button>
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
  onOpen,
  onSwitchProject,
  onShowAll,
}: {
  sessions: ClaudeSession[];
  projects: ClaudeProject[];
  onOpen: (id: string) => void;
  onSwitchProject: (dir: string) => void;
  onShowAll: () => void;
}) {
  const attentionOf = (s: ClaudeSession): AttKind | null => {
    if (s.attention === "question") return "question";
    if (s.attention === "error") return "error";
    if (s.attention === "done" && !s.isLive && ageMs(s.updatedAt) < RECENT_DONE_MS) return "done";
    return null;
  };

  const needs = sessions.map((s) => ({ s, k: attentionOf(s) })).filter((x): x is { s: ClaudeSession; k: AttKind } => x.k != null);
  const needIds = new Set(needs.map((x) => x.s.id));
  // "正在运行" = a turn is actively in flight (hook ∪ our driver). NOT isLive — that
  // also counts idle-but-attached sessions (e.g. many open VSCode tabs), over-reporting.
  const running = sessions.filter((s) => s.driving && !needIds.has(s.id));
  const runIds = new Set(running.map((s) => s.id));
  const recentDone = sessions.filter((s) => !needIds.has(s.id) && !runIds.has(s.id)).slice(0, RECENT_LIMIT);

  if (sessions.length === 0 && projects.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <p className="text-sm text-ink-dim">还没有会话</p>
        <p className="mt-1 text-xs text-ink-faint">在 Sessions 页用「+」开启一个新会话</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto overscroll-contain px-4 py-4 scroll-thin">
      {needs.length > 0 && (
        <section className="mb-5">
          <SectionHead title="需要你处理" count={needs.length} color="text-accent" />
          <div className="space-y-2.5">
            {needs.map(({ s, k }) => (
              <AttentionCard key={s.id} s={s} kind={k} onOpen={onOpen} />
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

      {projects.length > 0 && (
        <section className="mb-2">
          <SectionHead title="快速切换项目" count={projects.length} color="text-ink-dim" />
          <div className="flex gap-2 overflow-x-auto pb-1 scroll-thin">
            {projects.map((p) => (
              <ProjectChip key={p.dir} p={p} onSwitch={onSwitchProject} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
