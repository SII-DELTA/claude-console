"use client";

import { useState } from "react";
import type { ClaudeProject, ClaudeSession } from "@mac/shared";

export interface ProjectStat {
  run: number;
  need: number;
}

/** Per-project (by cwd) running/needs-attention counts + totals, from a session set. */
export function projectStats(sessions: ClaudeSession[]): {
  byCwd: Map<string, ProjectStat>;
  totalRun: number;
  totalNeed: number;
} {
  const byCwd = new Map<string, ProjectStat>();
  let totalRun = 0;
  let totalNeed = 0;
  for (const s of sessions) {
    const st = byCwd.get(s.cwd) ?? { run: 0, need: 0 };
    const need = s.attention === "approval" || s.attention === "question" || s.attention === "error";
    if (need) {
      st.need += 1;
      totalNeed += 1;
    } else if (s.driving) {
      st.run += 1;
      totalRun += 1;
    }
    byCwd.set(s.cwd, st);
  }
  return { byCwd, totalRun, totalNeed };
}

function PillBadges({ run, need }: ProjectStat) {
  if (!run && !need) return null;
  return (
    <span className="ml-1 flex shrink-0 items-center gap-1">
      {need > 0 && <span className="rounded-full bg-accent/20 px-1.5 text-[10px] font-medium text-accent">{need}</span>}
      {run > 0 && (
        <span className="flex items-center gap-0.5 text-[10px] text-success">
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          {run}
        </span>
      )}
    </span>
  );
}

function Pill({ label, active, run, need, onClick }: { label: string; active: boolean; run: number; need: number; onClick: () => void }) {
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

/** Sticky horizontal project filter bar (全部 + projects) with activity badges. */
export function ProjectBar({
  projects,
  focus,
  onFocus,
  stats,
}: {
  projects: ClaudeProject[];
  focus: string | null;
  onFocus: (dir: string | null) => void;
  stats: { byCwd: Map<string, ProjectStat>; totalRun: number; totalNeed: number };
}) {
  const [q, setQ] = useState("");
  const searchable = projects.length > 6;
  const list = q ? projects.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())) : projects;
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
        <Pill label="全部" active={focus == null} run={stats.totalRun} need={stats.totalNeed} onClick={() => onFocus(null)} />
        {list.map((p) => {
          const st = stats.byCwd.get(p.cwd) ?? { run: 0, need: 0 };
          return <Pill key={p.dir} label={p.name} active={focus === p.dir} run={st.run} need={st.need} onClick={() => onFocus(p.dir)} />;
        })}
      </div>
    </div>
  );
}
