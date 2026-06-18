"use client";

import { useState } from "react";
import type { ClaudeProject } from "@mac/shared";
import { useAppStore } from "../lib/store";
import { DirectoryPicker } from "./DirectoryPicker";

const sw = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function FolderIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} {...sw}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
function EyeIcon({ off, size = 18 }: { off?: boolean; size?: number }) {
  return off ? (
    <svg viewBox="0 0 24 24" width={size} height={size} {...sw}>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" width={size} height={size} {...sw}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function ProjectsPage({ onOpenProject }: { onOpenProject: (dir: string) => void }) {
  const projects = useAppStore((s) => s.projects);
  const hideProject = useAppStore((s) => s.hideProject);
  const unhideProject = useAppStore((s) => s.unhideProject);
  const addProject = useAppStore((s) => s.addProject);
  const ideState = useAppStore((s) => s.ideState);
  const openInVscode = useAppStore((s) => s.openInVscode);
  const hasVscode = (cwd: string) => !!ideState?.projects.find((p) => p.cwd === cwd)?.hasVscode;

  const [picking, setPicking] = useState(false);
  const [showHidden, setShowHidden] = useState(true);

  const visible = projects.filter((p) => !p.hidden);
  const hidden = projects.filter((p) => p.hidden);

  return (
    <div className="h-full overflow-y-auto overscroll-contain px-4 py-4 scroll-thin">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-[20px] font-semibold text-ink">Projects</h1>
        <button
          onClick={() => setPicking(true)}
          className="flex items-center gap-1 rounded-full bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-dark"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" {...sw}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
          新增项目
        </button>
      </div>

      <div className="space-y-2">
        {visible.map((p) => (
          <ProjectCard
            key={p.dir}
            p={p}
            vscode={hasVscode(p.cwd)}
            onOpen={() => onOpenProject(p.dir)}
            onHide={() => void hideProject(p.dir)}
            onOpenVscode={() => void openInVscode(p.cwd)}
          />
        ))}
        {visible.length === 0 && (
          <p className="py-8 text-center text-[13px] text-ink-faint">还没有项目，点「新增项目」选择一个目录</p>
        )}
      </div>

      {hidden.length > 0 && (
        <section className="mt-5">
          <button
            onClick={() => setShowHidden((v) => !v)}
            className="mb-2 flex w-full items-center gap-2 text-[13px] font-semibold text-ink-dim"
          >
            已隐藏 ({hidden.length})
            <svg viewBox="0 0 24 24" width="14" height="14" {...sw} className={`transition-transform ${showHidden ? "rotate-180" : ""}`}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {showHidden && (
            <div className="space-y-2">
              {hidden.map((p) => (
                <HiddenRow key={p.dir} p={p} onUnhide={() => void unhideProject(p.dir)} />
              ))}
            </div>
          )}
        </section>
      )}

      {picking && (
        <DirectoryPicker
          onPick={(cwd) => {
            void addProject(cwd);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

function ProjectCard({
  p,
  vscode,
  onOpen,
  onHide,
  onOpenVscode,
}: {
  p: ClaudeProject;
  vscode?: boolean;
  onOpen: () => void;
  onHide: () => void;
  onOpenVscode: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-bg-alt p-3">
      <button onClick={onOpen} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-bg text-ink-dim">
        <FolderIcon />
      </button>
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="truncate text-[14px] font-medium text-ink">{p.name}</div>
        <div className="truncate font-mono text-[11px] text-ink-faint">{p.cwd}</div>
        <div className="mt-1 flex items-center gap-1.5">
          <span className="rounded bg-bg px-1.5 py-0.5 text-[10px] text-ink-dim">{p.sessionCount} 个会话</span>
          <span className="flex items-center gap-1 text-[10px] text-ink-faint">
            <span className={`h-1.5 w-1.5 rounded-full ${p.liveCount > 0 ? "bg-success" : "bg-ink-faint/60"}`} />
            {p.liveCount > 0 ? "在线" : "离线"}
          </span>
          {vscode && (
            <span className="rounded bg-info/15 px-1.5 py-0.5 text-[10px] font-medium text-info">VSCode</span>
          )}
        </div>
      </button>
      <button
        onClick={onOpenVscode}
        aria-label={vscode ? "VSCode 已打开" : "在 VSCode 打开"}
        title={vscode ? "VSCode 已打开(点击聚焦)" : "在 VSCode 打开"}
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg hover:bg-bg-raised ${vscode ? "text-info" : "text-ink-faint hover:text-ink"}`}
      >
        <svg viewBox="0 0 24 24" width="17" height="17" {...sw}><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>
      </button>
      <button
        onClick={onHide}
        aria-label="隐藏项目"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-faint hover:bg-bg-raised hover:text-ink"
      >
        <EyeIcon />
      </button>
    </div>
  );
}

function HiddenRow({ p, onUnhide }: { p: ClaudeProject; onUnhide: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-bg-alt p-3 opacity-60">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-bg text-ink-faint">
        <FolderIcon />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium text-ink">{p.name}</div>
        <div className="truncate font-mono text-[11px] text-ink-faint">{p.cwd}</div>
      </div>
      <button
        onClick={onUnhide}
        className="shrink-0 rounded-lg border border-accent/40 px-2.5 py-1 text-[12px] text-accent hover:bg-accent/10"
      >
        显示
      </button>
    </div>
  );
}
