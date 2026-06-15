"use client";

import type { ClaudeSession } from "@mac/shared";

const RECENT_LIMIT = 5;

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function StatusBadge({ s }: { s: ClaudeSession }) {
  if (s.attention === "question")
    return <span className="rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">待回答</span>;
  if (s.attention === "error")
    return <span className="rounded-full bg-danger/20 px-1.5 py-0.5 text-[10px] font-medium text-danger">出错</span>;
  if (s.isLive)
    return (
      <span className="rounded-full bg-success/20 px-1.5 py-0.5 text-[10px] font-medium text-success">
        {s.drivenByAgent ? "本端运行" : "终端运行"}
      </span>
    );
  if (s.attention === "done")
    return <span className="rounded-full bg-line px-1.5 py-0.5 text-[10px] text-ink-dim">已完成</span>;
  return null;
}

function Card({ s, onOpen }: { s: ClaudeSession; onOpen: (id: string) => void }) {
  return (
    <button
      onClick={() => onOpen(s.id)}
      className="flex w-full items-center gap-3 rounded-xl border border-line bg-bg-alt px-3 py-2.5 text-left transition-colors hover:border-accent/50"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-medium text-ink">{s.title}</span>
          <StatusBadge s={s} />
        </div>
        {s.preview && <div className="mt-0.5 truncate text-[12px] text-ink-faint">{s.preview}</div>}
      </div>
      <span className="shrink-0 text-[11px] text-ink-faint">{relTime(s.updatedAt)}</span>
    </button>
  );
}

function Group({
  title,
  tone,
  sessions,
  onOpen,
}: {
  title: string;
  tone: string;
  sessions: ClaudeSession[];
  onOpen: (id: string) => void;
}) {
  if (sessions.length === 0) return null;
  return (
    <section className="mb-5">
      <h2 className={`mb-2 flex items-center gap-1.5 text-[12px] font-semibold ${tone}`}>
        {title}
        <span className="text-ink-faint">· {sessions.length}</span>
      </h2>
      <div className="space-y-2">
        {sessions.map((s) => (
          <Card key={s.id} s={s} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

export function Dashboard({
  sessions,
  onOpen,
  onShowAll,
}: {
  sessions: ClaudeSession[];
  onOpen: (id: string) => void;
  onShowAll: () => void;
}) {
  const needAttention = sessions.filter((s) => s.attention === "question" || s.attention === "error");
  const attentionIds = new Set(needAttention.map((s) => s.id));
  const running = sessions.filter((s) => s.isLive && !attentionIds.has(s.id));
  const runningIds = new Set(running.map((s) => s.id));
  const recentAll = sessions.filter((s) => !attentionIds.has(s.id) && !runningIds.has(s.id));
  const recent = recentAll.slice(0, RECENT_LIMIT);

  if (sessions.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <p className="text-sm text-ink-dim">还没有会话</p>
        <p className="mt-1 text-xs text-ink-faint">在 Sessions 页用「+」开启一个新会话</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-4 scroll-thin">
      <Group title="🔴 待你处理" tone="text-accent" sessions={needAttention} onOpen={onOpen} />
      <Group title="🟢 运行中" tone="text-success" sessions={running} onOpen={onOpen} />
      <Group title="🕘 最近" tone="text-ink-dim" sessions={recent} onOpen={onOpen} />
      {recentAll.length > RECENT_LIMIT && (
        <button
          onClick={onShowAll}
          className="mx-auto block rounded-full border border-line px-3 py-1 text-[12px] text-ink-dim transition-colors hover:text-ink"
        >
          查看全部 {sessions.length} 个会话
        </button>
      )}
    </div>
  );
}
