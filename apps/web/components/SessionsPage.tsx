"use client";

import { useState } from "react";
import type { ClaudeProject, ClaudeSession } from "@mac/shared";
import { useAppStore } from "../lib/store";
import { ProjectBar, projectStats } from "./ProjectBar";

const sw = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function cardTitle(s: ClaudeSession): string {
  return s.currentTask || s.lastUserText || s.title;
}

/* ── custom group icons (hand-drawn SVG) ─────────────────────────────── */
function TodayIcon() {
  // sun
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" {...sw}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </svg>
  );
}
function WeekIcon() {
  // calendar with a highlighted week row
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" {...sw}>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18M8 2v4M16 2v4" />
      <rect x="6" y="13" width="12" height="3" rx="1" fill="currentColor" stroke="none" opacity="0.55" />
    </svg>
  );
}
function HistoryIcon() {
  // clock with a counter-clockwise arrow
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" {...sw}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 4v4h4" />
      <path d="M12 8v4l3 2" />
    </svg>
  );
}

type Bucket = "today" | "week" | "history";
function bucketOf(iso: string): Bucket {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return "today";
  const age = now.getTime() - d.getTime();
  if (age < 7 * 86400_000) return "week";
  return "history";
}

const GROUPS = [
  { key: "today" as const, label: "今日", Icon: TodayIcon },
  { key: "week" as const, label: "本周", Icon: WeekIcon },
  { key: "history" as const, label: "历史", Icon: HistoryIcon },
];

function attentionOf(s: ClaudeSession): { label: string; tone: string } | null {
  if (s.attention === "approval") return { label: "待批准", tone: "text-accent" };
  if (s.attention === "question") return { label: "待回答", tone: "text-accent" };
  if (s.attention === "error") return { label: "出错", tone: "text-danger" };
  return null;
}

function SessionRow({ s, onSelect }: { s: ClaudeSession; onSelect: (id: string) => void }) {
  const att = attentionOf(s);
  const running = !!s.driving && !att;
  const dotColor = att ? "bg-accent" : running ? "bg-success" : "bg-ink-faint/50";
  const sub = att
    ? att.label
    : running
      ? s.lastActivity
        ? `正在 ${s.lastActivity}`
        : "运行中…"
      : s.lastResult || "已完成";
  return (
    <button
      onClick={() => onSelect(s.id)}
      className="flex w-full items-start gap-2.5 rounded-xl border border-line bg-bg-alt p-3 text-left transition-colors hover:bg-bg-raised"
    >
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotColor} ${running ? "animate-pulse" : ""}`} />
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-[14px] font-medium leading-snug text-ink">{cardTitle(s)}</div>
        <div className={`mt-0.5 truncate text-[11px] ${att ? att.tone : "text-ink-faint"}`}>{sub}</div>
      </div>
      <span className="mt-0.5 shrink-0 text-[11px] text-ink-faint">{relTime(s.updatedAt)}</span>
    </button>
  );
}

/** Bottom sheet to choose which project a new session belongs to (全部 scope). */
function ProjectChooser({ projects, onPick, onClose }: { projects: ClaudeProject[]; onPick: (dir: string) => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[70vh] flex-col rounded-t-2xl border-t border-line bg-bg-alt pb-safe">
        <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-line" />
        <h2 className="px-4 pb-1 pt-3 text-[15px] font-semibold text-ink">在哪个项目新建？</h2>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 scroll-thin">
          {projects.map((p) => (
            <button
              key={p.dir}
              onClick={() => onPick(p.dir)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 text-left hover:bg-bg-raised"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" {...sw} className="shrink-0 text-ink-dim"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-ink">{p.name}</span>
                <span className="block truncate font-mono text-[10px] text-ink-faint">{p.cwd}</span>
              </span>
              <span className="shrink-0 text-ink-faint">›</span>
            </button>
          ))}
        </div>
        <button onClick={onClose} className="shrink-0 border-t border-line py-3 text-[14px] text-ink-dim">取消</button>
      </div>
    </div>
  );
}

export function SessionsPage({ onSelect, onNewInProject }: { onSelect: (id: string) => void; onNewInProject: (dir: string) => void }) {
  const allSessions = useAppStore((s) => s.allSessions);
  // NOTE: select the raw array; filtering inside the selector returns a new array
  // every render → zustand/useSyncExternalStore infinite loop ("Maximum update depth").
  const allProjects = useAppStore((s) => s.projects);
  const projects = allProjects.filter((p) => !p.hidden);
  const focus = useAppStore((s) => s.sessionsFocus);
  const setFocus = useAppStore((s) => s.setSessionsFocus);
  const [choosing, setChoosing] = useState(false);

  const focusCwd = focus ? projects.find((p) => p.dir === focus)?.cwd : undefined;
  const view = focusCwd ? allSessions.filter((s) => s.cwd === focusCwd) : allSessions;
  const stats = projectStats(allSessions);

  // group by time bucket; within a group put attention sessions first
  const grouped = GROUPS.map((g) => ({
    ...g,
    items: view
      .filter((s) => bucketOf(s.updatedAt) === g.key)
      .sort((a, b) => {
        const aa = attentionOf(a) ? 1 : 0;
        const bb = attentionOf(b) ? 1 : 0;
        if (aa !== bb) return bb - aa;
        return b.updatedAt.localeCompare(a.updatedAt);
      }),
  })).filter((g) => g.items.length > 0);

  function newSession() {
    if (focus) onNewInProject(focus);
    else if (projects.length === 1) onNewInProject(projects[0]!.dir);
    else setChoosing(true);
  }

  return (
    <div className="flex h-full flex-col">
      <ProjectBar projects={projects} focus={focus} onFocus={setFocus} stats={stats} />

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 scroll-thin">
        {grouped.length === 0 && (
          <p className="mt-12 text-center text-[13px] text-ink-faint">该范围还没有会话</p>
        )}
        {grouped.map((g) => (
          <section key={g.key} className="mb-4">
            <div className="mb-2 flex items-center gap-1.5 text-ink-dim">
              <g.Icon />
              <h2 className="text-[13px] font-semibold">{g.label}</h2>
              <span className="grid h-4 min-w-4 place-items-center rounded-full bg-line px-1 text-[10px] text-ink-dim">{g.items.length}</span>
            </div>
            <div className="space-y-2">
              {g.items.map((s) => (
                <SessionRow key={s.id} s={s} onSelect={onSelect} />
              ))}
            </div>
          </section>
        ))}
      </div>

      <div className="shrink-0 border-t border-line bg-bg-alt px-4 py-3 pb-safe">
        <button
          onClick={newSession}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3.5 text-[15px] font-semibold text-white transition-colors hover:bg-accent-dark"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" {...sw}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
          新建会话
        </button>
      </div>

      {choosing && (
        <ProjectChooser
          projects={projects}
          onPick={(dir) => {
            setChoosing(false);
            onNewInProject(dir);
          }}
          onClose={() => setChoosing(false)}
        />
      )}
    </div>
  );
}
