import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);

export interface UsageData {
  five_hour?: { utilization: number; resets_at: string };
  seven_day?: { utilization: number; resets_at: string };
  seven_day_opus?: { utilization: number; resets_at: string } | null;
  seven_day_sonnet?: { utilization: number; resets_at: string } | null;
  extra_usage?: { is_enabled: boolean; monthly_limit: number; used_credits: number; utilization: number };
  lastFetch?: number; // timestamp
}

const CACHE_PATH = path.join(process.env.HOME || ".", ".claude", "usage-cache.json");

export async function readUsageCache(): Promise<UsageData | null> {
  try {
    const data = await readFile(CACHE_PATH, "utf8");
    const parsed = JSON.parse(data);
    // Handle both formats: direct UsageData or wrapped in { data: UsageData }
    const usage = parsed.data || parsed;
    return usage as UsageData;
  } catch {
    return null;
  }
}

export async function writeUsageCache(data: UsageData): Promise<void> {
  try {
    await mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("[usage-cache] Failed to write cache:", e);
  }
}

export function getCacheAge(): number | null {
  try {
    const stat = fs.statSync(CACHE_PATH);
    return Date.now() - stat.mtimeMs;
  } catch {
    return null;
  }
}
