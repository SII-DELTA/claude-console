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
    if (!connection?.url || !connection?.token) {
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
    timeoutId = setInterval(fetchUsage, FETCH_INTERVAL);

    return () => {
      isMounted = false;
      if (timeoutId) clearInterval(timeoutId);
    };
  }, [connection]);

  return usage;
}
