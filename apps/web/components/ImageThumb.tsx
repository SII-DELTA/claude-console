"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A thumbnail that opens a full-screen lightbox on click. Used for both composer
 * previews (object-URL) and sent/history images (data-URL). The lightbox is portaled
 * to <body> so `position: fixed` escapes any ancestor with a transform/backdrop-filter
 * (e.g. the composer's backdrop-blur), which would otherwise trap it in a small box.
 */
export function ImageThumb({ src, className }: { src: string; className?: string }) {
  const [open, setOpen] = useState(false);

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
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
              aria-label="关闭"
              className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-full bg-white/15 text-white backdrop-blur hover:bg-white/25"
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
