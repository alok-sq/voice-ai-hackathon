import { useCallback, useEffect, useRef, useState } from "react";
import type { CallView } from "./callReducer";
import { addSession, parseSessions, toSession, type SessionMeta, type SessionRecord } from "./sessions";

const STORAGE_KEY = "console.sessions.v1";

function load(): SessionRecord[] {
  try {
    return parseSessions(localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

function persist(list: SessionRecord[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Blocked or full storage: history still works for this visit.
  }
}

/**
 * Call history for this browser. Saves each call once, the moment it ends,
 * with the setup it was started with.
 */
export function useSessions(view: CallView, meta: SessionMeta) {
  const [sessions, setSessions] = useState<SessionRecord[]>(load);
  const saved = useRef<string | null>(null);
  // The setup cannot change during a call, so the latest meta is the call's own.
  const metaRef = useRef(meta);
  metaRef.current = meta;

  const finished = view.phase === "ended" || view.phase === "error";
  useEffect(() => {
    if (!finished) return;
    const rec = toSession(view, metaRef.current);
    if (!rec || saved.current === rec.id) return;
    saved.current = rec.id;
    setSessions((list) => {
      const next = addSession(list, rec);
      persist(next);
      return next;
    });
    // Runs once per finished call: `view.endedAt` changes only when a call ends.
  }, [finished, view.endedAt]);

  const clear = useCallback(() => {
    setSessions([]);
    persist([]);
  }, []);

  return { sessions, clear };
}
