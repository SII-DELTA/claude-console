/**
 * Design tokens for the Web console (Tailwind). Keep as plain literals.
 */
export const colors = {
  bgFrom: "#0B0B1A",
  bgTo: "#10142A",
  surface: "rgba(255,255,255,0.04)",
  surfaceStrong: "rgba(255,255,255,0.08)",
  primary: "#8B5CF6",
  primaryDeep: "#6D28D9",
  accent: {
    teal: "#14B8A6",
    green: "#22C55E",
    orange: "#F59E0B",
    red: "#EF4444",
    blue: "#3B82F6",
  },
  status: {
    running: "#22C55E",
    completed: "#14B8A6",
    error: "#EF4444",
    waiting: "#F59E0B",
    idle: "#94A3B8",
  },
  text: {
    primary: "#F8FAFC",
    secondary: "#94A3B8",
    muted: "#64748B",
  },
  border: "rgba(255,255,255,0.08)",
} as const;

export const radius = { sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const blur = { card: 14 } as const;
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, "2xl": 32 } as const;
