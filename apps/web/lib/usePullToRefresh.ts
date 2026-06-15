import { useEffect, useRef, useState } from "react";

export function usePullToRefresh(threshold: number = 60) {
  const [pulling, setPulling] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const startYRef = useRef(0);
  const scrollTopRef = useRef(0);
  const pullDistanceRef = useRef(0);

  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      scrollTopRef.current = window.scrollY || document.documentElement.scrollTop;
      if (scrollTopRef.current === 0) {
        startYRef.current = e.touches[0]!.clientY;
        pullDistanceRef.current = 0;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (scrollTopRef.current === 0 && startYRef.current > 0) {
        const currentY = e.touches[0]!.clientY;
        const distance = currentY - startYRef.current;
        if (distance > 0) {
          // 阻止默认行为（过度滚动）
          e.preventDefault?.();
          pullDistanceRef.current = distance;
          setPullDistance(distance);
          setPulling(distance >= threshold);
        }
      }
    };

    const handleTouchEnd = () => {
      if (pullDistanceRef.current >= threshold) {
        window.location.reload();
      }
      setPullDistance(0);
      pullDistanceRef.current = 0;
      startYRef.current = 0;
      setPulling(false);
    };

    // 在body上监听，PWA standalone模式下更可靠
    const target = typeof document !== "undefined" ? document.body : document;
    target.addEventListener("touchstart", handleTouchStart, { passive: true });
    target.addEventListener("touchmove", handleTouchMove, { passive: false });
    target.addEventListener("touchend", handleTouchEnd, { passive: true });

    return () => {
      target.removeEventListener("touchstart", handleTouchStart);
      target.removeEventListener("touchmove", handleTouchMove);
      target.removeEventListener("touchend", handleTouchEnd);
    };
  }, [threshold]);

  return { pulling, pullDistance, threshold };
}
