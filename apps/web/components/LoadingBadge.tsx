"use client";

import { useEffect, useState } from "react";
import { ClaudeLogo } from "./ClaudeLogo";

const LOADING_PHRASES = [
  "终端运行中",
  "进程活跃中",
  "外部接管中",
  "正在同步",
  "等待中",
  "接管准备中",
  "状态同步中",
  "会话活跃",
];

export function LoadingBadge() {
  const [phrase, setPhrase] = useState(LOADING_PHRASES[0]);

  useEffect(() => {
    let index = 0;
    const interval = setInterval(() => {
      index = (index + 1) % LOADING_PHRASES.length;
      setPhrase(LOADING_PHRASES[index]);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex items-center gap-2 text-accent">
      <style>{`
        @keyframes pulse-scale {
          0% { transform: scale(0.6); opacity: 0.4; }
          50% { transform: scale(1.2); opacity: 1; }
          100% { transform: scale(0.6); opacity: 0.4; }
        }
        .loading-snowflake {
          animation: pulse-scale 1.2s ease-in-out infinite;
        }
      `}</style>
      <ClaudeLogo size={16} className="loading-snowflake" />
      <span className="text-sm">{phrase}</span>
    </div>
  );
}
