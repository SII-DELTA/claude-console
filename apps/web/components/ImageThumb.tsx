"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A thumbnail that opens a lightbox on click. Used for composer previews (object-URL)
 * and sent/history images (data-URL). The lightbox is portaled to <body> so
 * `position: fixed` escapes any ancestor with a transform/backdrop-filter (e.g. the
 * composer's backdrop-blur) that would otherwise trap it. Padded by the safe-area so the
 * image and close button clear the notch/status bar and home indicator.
 */
export function ImageThumb({ src, className }: { src: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const lightbox =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            onClick={() => setOpen(false)}
            onTouchStart={(e) => {
              touchStart.current = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
            }}
            onTouchEnd={(e) => {
              const s = touchStart.current;
              touchStart.current = null;
              if (!s) return;
              const dx = e.changedTouches[0]!.clientX - s.x;
              const dy = e.changedTouches[0]!.clientY - s.y;
              if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) setOpen(false); // horizontal swipe → exit
            }}
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/85 backdrop-blur-sm"
            style={{
              paddingTop: "max(3.25rem, calc(env(safe-area-inset-top) + 2.75rem))",
              paddingBottom: "max(1.5rem, calc(env(safe-area-inset-bottom) + 1rem))",
              paddingLeft: "1rem",
              paddingRight: "1rem",
            }}
            role="dialog"
            aria-modal="true"
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
              aria-label="关闭"
              className="absolute right-3 z-[81] grid h-9 w-9 place-items-center rounded-full bg-white/15 text-white backdrop-blur hover:bg-white/25"
              style={{ top: "max(0.75rem, env(safe-area-inset-top))" }}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt="" className="max-h-full max-w-full cursor-zoom-out rounded-lg object-contain" />
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" onClick={() => setOpen(true)} className={`cursor-zoom-in ${className ?? ""}`} />
      {lightbox}
    </>
  );
}
