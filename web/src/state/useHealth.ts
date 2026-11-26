import { useEffect, useState } from "react";
import { fetchHealth, type Health } from "../sources/api";

const POLL_MS = 10_000;

/** Polls the backend so the console knows whether a live call is possible. */
export function useHealth(paused: boolean): Health | null {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    if (paused) return;
    const ctrl = new AbortController();
    const check = () => fetchHealth(ctrl.signal).then((h) => !ctrl.signal.aborted && setHealth(h));
    void check();
    const id = setInterval(check, POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [paused]);

  return health;
}
