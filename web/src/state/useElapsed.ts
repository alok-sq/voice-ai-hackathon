import { useEffect, useState } from "react";

/** mm:ss since `from`, frozen at `until` once the call ends. */
export function useElapsed(from: number | null, until: number | null): string {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (from === null || until !== null) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [from, until]);

  if (from === null) return "00:00";
  const s = Math.max(0, Math.floor(((until ?? now) - from) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
