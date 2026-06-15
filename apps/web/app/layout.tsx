import "./globals.css";
import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Claude Console",
  description: "远程接管你电脑上的 Claude Code 会话。",
  manifest: "/manifest.webmanifest?v=1.2.1",
  icons: {
    // 浏览器标签页用 SVG（清晰、矢量）；PWA 安装图标需 PNG，否则桌面端回退成字母占位图
    // ?v=3 用于强制 iOS/浏览器丢弃此前缓存的占位图标
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png?v=3", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png?v=3", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png?v=3",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Claude Console",
    startupImage: "/apple-touch-icon.png?v=3",
  },
};

export const viewport: Viewport = {
  themeColor: "#D97757",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  // When the soft keyboard opens, shrink the layout viewport (not just the visual
  // one) so our height-driven flex layout collapses to the visible area and the
  // composer pins right above the keyboard instead of being pushed off-screen.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh">
      <body>{children}</body>
    </html>
  );
}
