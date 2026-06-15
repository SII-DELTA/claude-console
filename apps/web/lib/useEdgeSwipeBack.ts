import { useEffect, useRef, useState } from "react";

const EDGE = 24; // px：起始落点距左/右边缘内多少算候选
const THRESHOLD = 60; // px：水平位移超过此值松手触发返回
const MAX_PULL = 120; // px：跟手位移限幅
const AXIS_LOCK = 8; // px：超过此位移开始判定主方向

/**
 * 移动端边缘滑动返回手势。
 * 仅当 touchstart 落在屏幕左/右边缘 EDGE 范围内、且主方向为水平时生效；
 * 左右任一方向滑动超过 THRESHOLD 松手即触发 onBack，未达阈值则回弹（dx 归零）。
 *
 * 返回 { ref, dx }：ref 挂到容器元素上，dx 为当前跟手水平位移（用于 translateX）。
 */
export function useEdgeSwipeBack(enabled: boolean, onBack: () => void) {
  const ref = useRef<HTMLElement>(null);
  const [dx, setDx] = useState(0);

  const startX = useRef<number | null>(null);
  const startY = useRef(0);
  const active = useRef(false); // 已锁定为水平手势
  const dxRef = useRef(0);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    function reset() {
      startX.current = null;
      active.current = false;
      dxRef.current = 0;
      setDx(0);
    }

    function onStart(e: TouchEvent) {
      const t = e.touches[0];
      if (!t) return;
      const w = window.innerWidth;
      if (t.clientX <= EDGE || t.clientX >= w - EDGE) {
        startX.current = t.clientX;
        startY.current = t.clientY;
        active.current = false;
      } else {
        startX.current = null;
      }
    }

    function onMove(e: TouchEvent) {
      if (startX.current == null) return;
      const t = e.touches[0];
      if (!t) return;
      const ddx = t.clientX - startX.current;
      const ddy = t.clientY - startY.current;

      if (!active.current) {
        if (Math.abs(ddx) < AXIS_LOCK && Math.abs(ddy) < AXIS_LOCK) return;
        // 垂直为主 → 交还原生滚动
        if (Math.abs(ddy) > Math.abs(ddx)) {
          startX.current = null;
          return;
        }
        active.current = true;
      }

      e.preventDefault();
      const clamped = Math.max(-MAX_PULL, Math.min(MAX_PULL, ddx));
      dxRef.current = clamped;
      setDx(clamped);
    }

    function onEnd() {
      const triggered = active.current && Math.abs(dxRef.current) >= THRESHOLD;
      reset();
      if (triggered) onBackRef.current();
    }

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [enabled]);

  return { ref, dx };
}
