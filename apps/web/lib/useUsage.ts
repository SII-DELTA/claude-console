"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "./store";
import { ApiClient } from "./api";

export interface UsageQuota {
  five_hour: { utilization: number; resets_at: string } | null;
  seven_day: { utilization: number; resets_at: string } | null;
}

const FETCH_INTERVAL = 60 * 1000; // 60 seconds

export function useUsage() {
  const [usage, setUsage] = useState<UsageQuota | null>(null);
  const connection = useAppStore((s) => s.connection);

  useEffect(() => {
    // token may legitimately be "" in open/no-auth mode; /usage is a free path,
    // so fetch as long as we have a url and a defined (possibly empty) token.
    if (!connection?.url || connection.token == null) {
      setUsage(null);
      return;
    }

    const { url, token } = connection;
    let isMounted = true;
    let timeoutId: NodeJS.Timeout | null = null;

    async function fetchUsage() {
      try {
        const api = new ApiClient(url, token);
        const data = await api.getUsage();
        if (isMounted) setUsage(data);
      } catch {
        if (isMounted) setUsage(null);
      }
    }

    fetchUsage();
    // Skip polling while the tab is hidden/locked; refetch immediately on resume.
    timeoutId = setInterval(() => {
      if (!document.hidden) void fetchUsage();
    }, FETCH_INTERVAL);
    const onVisible = () => {
      if (!document.hidden) void fetchUsage();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      isMounted = false;
      if (timeoutId) clearInterval(timeoutId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [connection]);

  return usage;
}
