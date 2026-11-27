import { useCallback, useEffect, useReducer, useRef } from "react";
import { AbortedError, createSource, type CallOptions, type CallSource } from "../sources";
import { callReducer, initialCallView } from "./callReducer";

interface Session {
  source: CallSource;
  abort: AbortController;
}

/**
 * Owns the lifecycle of one call at a time.
 *
 * Every callback checks it still belongs to the current session, so a
 * cancelled or replaced session can never write into the UI. This is what
 * makes "End call" safe while still connecting.
 */
export function useCall() {
  const [view, dispatch] = useReducer(callReducer, initialCallView);
  const sessionRef = useRef<Session | null>(null);

  const stopSession = useCallback(() => {
    const s = sessionRef.current;
    sessionRef.current = null;
    if (!s) return;
    s.abort.abort();
    s.source.stop();
  }, []);

  const start = useCallback(
    async (opts: CallOptions) => {
      stopSession();
      const session: Session = { source: createSource(opts), abort: new AbortController() };
      sessionRef.current = session;
      const isCurrent = () => sessionRef.current === session;

      dispatch({ type: "connect", at: Date.now() });
      try {
        await session.source.start({
          signal: session.abort.signal,
          emit: (event) => {
            if (isCurrent()) dispatch({ type: "event", event, at: Date.now() });
          },
          onEnd: (reason) => {
            if (!isCurrent()) return;
            stopSession();
            dispatch({ type: "end", reason, at: Date.now() });
          },
        });
        if (isCurrent()) dispatch({ type: "connected", at: Date.now() });
      } catch (err) {
        if (!isCurrent() || err instanceof AbortedError || (err as Error)?.name === "AbortError") return;
        stopSession();
        dispatch({ type: "fail", message: (err as Error)?.message || "Could not start the call.", at: Date.now() });
      }
    },
    [stopSession],
  );

  const end = useCallback(async (reason = "Call ended by you") => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    session.abort.abort();
    const pending = session.source.stop();
    const events = pending instanceof Promise ? await pending : [];
    const at = Date.now();
    for (const event of events) dispatch({ type: "event", event, at });
    dispatch({ type: "end", reason, at });
  }, []);

  const requestHandoff = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    dispatch({ type: "event", event: { type: "system", text: "You asked for a handoff." }, at: Date.now() });
    try {
      await s.source.requestHandoff("Requested from the console");
    } catch (err) {
      console.warn("[console] Handoff request failed", err);
    }
  }, []);

  // The agent can end the call itself (call_ended event); release the transport then.
  useEffect(() => {
    if ((view.phase === "ended" || view.phase === "error") && sessionRef.current) stopSession();
  }, [view.phase, stopSession]);

  useEffect(() => stopSession, [stopSession]);

  return { view, start, end, requestHandoff };
}
