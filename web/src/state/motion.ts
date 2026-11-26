import { useEffect, useRef, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/** True when the viewer asked the OS for less motion. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia(QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Animates a number towards `target` (design system: numbers count up ~600 ms).
 * Jumps straight there under reduced motion, or when there is no target.
 */
export function useCountUp(target: number | null, durationMs = 600): number | null {
  const reduced = usePrefersReducedMotion();
  const [value, setValue] = useState<number | null>(target);
  const fromRef = useRef<number>(target ?? 0);

  useEffect(() => {
    if (target === null || reduced) {
      setValue(target);
      fromRef.current = target ?? 0;
      return;
    }
    const from = fromRef.current;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const v = from + (target - from) * easeOut(t);
      setValue(v);
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      fromRef.current = target;
    };
  }, [target, durationMs, reduced]);

  return value;
}
