import { usePullToRefresh } from "../lib/usePullToRefresh";

export function PullToRefreshIndicator() {
  const { pulling, pullDistance, threshold } = usePullToRefresh(60);
  const progress = Math.min(pullDistance / threshold, 1);

  if (pullDistance === 0) return null;

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center transition-all"
      style={{
        height: `${pullDistance}px`,
        background: `linear-gradient(to bottom, rgba(217, 119, 87, ${progress * 0.2}), transparent)`,
      }}
    >
      <div className="flex flex-col items-center gap-2">
        <div
          className="transition-transform"
          style={{
            transform: `rotate(${pulling ? 180 : 0}deg)`,
          }}
        >
          <span className="text-2xl">↓</span>
        </div>
        <span className="text-xs text-ink-dim">
          {pulling ? "释放刷新" : "下拉刷新"}
        </span>
      </div>
    </div>
  );
}
