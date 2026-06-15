# Change Log: Claude API Usage Quota Display

**Date:** 2026-06-12  
**Commit:** 657289e

## Overview

Implemented Claude API usage quota display in the Claude Console web application, showing real-time remaining quota and reset times for both 5-hour session limits and weekly limits.

## Changed Files

### Backend (local-agent)
- **`packages/local-agent/src/usage-cache.ts`** (NEW)
  - Module for reading/writing usage cache from `~/.claude/usage-cache.json`
  - Exports: `readUsageCache()`, `writeUsageCache()`, `getCacheAge()`
  - Type definition: `UsageData` interface with five_hour, seven_day, seven_day_opus, seven_day_sonnet, extra_usage fields

- **`packages/local-agent/src/http-server.ts`**
  - Added import for `readUsageCache` from usage-cache.ts
  - Added `/usage` endpoint (GET) that returns five_hour and seven_day quotas
  - Added `/usage` to FREE_PATHS to allow unauthenticated access

### Frontend (web)
- **`apps/web/lib/api.ts`**
  - Added `getUsage()` method to ApiClient class
  - Returns: `{ five_hour: {...} | null, seven_day: {...} | null }`

- **`apps/web/lib/useUsage.ts`** (NEW)
  - React hook for periodic usage data fetching
  - Auto-polls every 60 seconds when connected
  - Returns: `{ usage: UsageQuota | null, loading: boolean }`
  - Cleanup on unmount: clears timeout, sets isMounted flag

- **`apps/web/components/UsageDisplay.tsx`** (NEW)
  - React component to render usage quotas in UI
  - Displays: utilization % and time remaining until reset
  - Format: "85% · 3h17m" for session, "97% · 6d19h" for weekly
  - Shows nothing if cache is empty or unavailable

- **`apps/web/app/page.tsx`**
  - Imported UsageDisplay component
  - Added UsageDisplay to mobile header (after status dot)
  - Added UsageDisplay to desktop header (before disconnect button)

## How It Works

1. **Cache Source**: Data is read from `~/.claude/usage-cache.json` (file managed externally by Claude CLI or other process)
2. **Server**: `GET /usage` endpoint returns cached five_hour and seven_day quotas
3. **Client**: `useUsage()` hook polls endpoint every 60 seconds when connected
4. **Display**: `UsageDisplay` component renders quota with remaining time until reset
5. **Graceful Fallback**: If cache is unavailable, endpoint returns 404 with null values, component renders nothing

## Data Flow

```
~/.claude/usage-cache.json 
  ↓ (read by)
/usage endpoint
  ↓ (fetched by)
useUsage() hook
  ↓ (rendered by)
UsageDisplay component
  ↓ (displayed in)
Mobile & Desktop headers
```

## Testing Recommendations

1. Verify `/usage` endpoint returns correct data when cache exists
2. Verify endpoint returns 404 when cache is missing
3. Verify hook polling works with 60-second interval
4. Verify UsageDisplay shows correctly formatted time (e.g., "3h17m", "6d19h")
5. Verify components render nothing when usage data is null
6. Test on both mobile and desktop viewports
7. Test when connection is not established (should not fetch)

## Impact

- **Breaking**: None
- **Deprecations**: None
- **Dependencies Added**: None (uses existing http client and React hooks)
- **Performance**: +1 HTTP request every 60 seconds per connected session (minimal impact)
- **Disk Space**: None (reads existing file)

## Notes

- The cache file path is hardcoded as `~/.claude/usage-cache.json`
- Polling interval is fixed at 60 seconds
- No retry logic if API call fails; falls back to null gracefully
- UsageDisplay uses inline styling, no new CSS classes added
