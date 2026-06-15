import type { Config } from "tailwindcss";

// Claude Code-inspired dark palette (warm coral accent on neutral charcoal).
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: "#D97757", // Claude coral
          dark: "#C2613F",
          soft: "#E8A088",
        },
        bg: {
          DEFAULT: "#1A1915", // app background
          alt: "#222019", // panels
          raised: "#2A2722", // raised cards / composer
        },
        line: "#3A362E",
        ink: {
          DEFAULT: "#F4EFE7",
          dim: "#A8A296",
          faint: "#6E6A60",
        },
        success: "#5FB87A",
        warning: "#E0A33E",
        danger: "#E06A5A",
        info: "#6BA3C4",
      },
      borderRadius: {
        xl: "12px",
        "2xl": "16px",
        "3xl": "20px",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
