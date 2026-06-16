import { useEffect, useRef, useState } from "react";

const EDGE = 24; // px：起始落点距左/右边缘内多少算候选
const THRESHOLD = 60; // px：水平位移超过此值松手触发返回
const MAX_PULL = 120; // px：跟手位移限幅
const AXIS_LOCK = 8; // px：超过此位移开始判定主方向
const EXIT_MS = 220; // ms：滑出/回弹动画时长（需与样式 transition 一致）

/**
 * 移动端边缘滑动返回手势。
 * 仅当 touchstart 落在屏幕左/右边缘 EDGE 范围内、且主方向为水平时生效；
 * 左右任一方向滑动超过 THRESHOLD 松手即触发：页面先按方向滑出屏幕，
 * 动画结束后再调用 onBack；未达阈值则回弹归位。
 *
 * 返回 { ref, dx, animating }：
 * - ref：挂到容器元素上
 * - dx：当前水平位移（用于 translateX）
 * - animating：是否处于动画态（用于决定是否启用 transition）
 */
export function useEdgeSwipeBack(enabled: boolean, onBack: () => void) {
  const ref = useRef<HTMLElement>(null);
  const [dx, setDx] = useState(0);
  const [animating, setAnimating] = useState(false);

  const startX = useRef<number | null>(null);
  const startY = useRef(0);
  const active = useRef(false); // 已锁定为水平手势
  const dxRef = useRef(0);
  const exitingRef = useRef(false); // 退出动画进行中，忽略新手势
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    function clearTimer() {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }

    function settleDrag() {
      startX.current = null;
      active.current = false;
    }

    function onStart(e: TouchEvent) {
      if (exitingRef.current) return;
      const t = e.touches[0];
      if (!t) return;
      const w = window.innerWidth;
      if (t.clientX <= EDGE || t.clientX >= w - EDGE) {
        clearTimer();
        setAnimating(false); // 跟手阶段关闭 transition
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
      settleDrag();
      setAnimating(true); // 启用 transition：滑出或回弹

      if (triggered) {
        // 按手势方向把页面滑出屏幕，动画结束后再真正返回
        exitingRef.current = true;
        const sign = dxRef.current >= 0 ? 1 : -1;
        const target = sign * (window.innerWidth + 40);
        dxRef.current = target;
        setDx(target);
        clearTimer();
        timerRef.current = setTimeout(() => {
          onBackRef.current();
          // 复位：此时 main 已隐藏，重置不可见
          exitingRef.current = false;
          dxRef.current = 0;
          setAnimating(false);
          setDx(0);
        }, EXIT_MS);
      } else {
        // 回弹归位
        dxRef.current = 0;
        setDx(0);
      }
    }

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      clearTimer();
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [enabled]);

  return { ref, dx, animating, exitMs: EXIT_MS };
}
