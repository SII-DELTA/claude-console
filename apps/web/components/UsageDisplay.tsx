"use client";

import { useUsage } from "../lib/useUsage";

function formatTime(resets_at: string): string {
  try {
    const date = new Date(resets_at);
    const now = new Date();
    const diff = date.getTime() - now.getTime();

    if (diff < 0) return "reset";

    const totalMinutes = Math.floor(diff / (1000 * 60));
    const totalHours = Math.floor(totalMinutes / 60);
    const totalDays = Math.floor(totalHours / 24);

    if (totalDays > 0) {
      const h = totalHours % 24;
      return h > 0 ? `${totalDays}d${h}h` : `${totalDays}d`;
    }
    if (totalHours > 0) {
      const m = totalMinutes % 60;
      return m > 0 ? `${totalHours}h${m}m` : `${totalHours}h`;
    }
    return `${totalMinutes}m`;
  } catch {
    return "";
  }
}

export function UsageDisplay() {
  const usage = useUsage();

  if (!usage || (!usage.five_hour && !usage.seven_day)) {
    return null;
  }

  return (
    <div className="text-xs text-ink-dim leading-tight">
      {usage.five_hour && (
        <div title={`Session remaining: ${100 - usage.five_hour.utilization}%, resets at ${usage.five_hour.resets_at}`}>
          {100 - usage.five_hour.utilization}% ({formatTime(usage.five_hour.resets_at)})
        </div>
      )}
      {usage.seven_day && (
        <div title={`Weekly remaining: ${100 - usage.seven_day.utilization}%, resets at ${usage.seven_day.resets_at}`}>
          {100 - usage.seven_day.utilization}% ({formatTime(usage.seven_day.resets_at)})
        </div>
      )}
    </div>
  );
}
