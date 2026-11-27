import type { CallEvent, Role } from "../contract/events";

/** Text built so far for a Cartesia turn, keyed by the turn index. */
export interface OpenTurn {
  role: Role;
  text: string;
}

const roleOf = (role: unknown): Role | null => (role === "user" ? "caller" : role === "assistant" ? "agent" : null);

/** When the caller finished, waiting for the first audio of the reply. */
export interface ReplyClock {
  since: number | null;
}

/**
 * Reply time is caller-finished to the first audio of the answer.
 * The greeting has no preceding caller turn, so it is not timed.
 * Later audio chunks of the same reply are not timed again.
 */
export function replyLatency(msg: unknown, clock: ReplyClock, now: number): CallEvent | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  if (m.type === "turn_ended" && m.role === "user" && m.ignored !== true) {
    const text = typeof m.text === "string" ? m.text.trim() : "";
    if (text) clock.since = now;
    return null;
  }
  if (m.type === "audio_output" && typeof m.audio === "string" && m.audio && clock.since !== null) {
    const replyMs = Math.max(0, Math.round(now - clock.since));
    clock.since = null;
    return { type: "metric", replyMs };
  }
  return null;
}

/**
 * Turn Cartesia's websocket events into the console's call events.
 * Audio events are ignored here; the source plays those itself.
 * Unknown events produce nothing.
 */
export function eventsFromCartesia(msg: unknown, open: Map<number, OpenTurn>): CallEvent[] {
  if (!msg || typeof msg !== "object") return [];
  const m = msg as Record<string, unknown>;
  if (m.type === "turn_started") {
    const role = roleOf(m.role);
    if (!role || typeof m.turn !== "number") return [];
    open.set(m.turn, { role, text: "" });
    return [{ type: "speaking", who: role }];
  }
  if (m.type === "turn_output_text_delta") {
    if (typeof m.turn !== "number" || typeof m.text !== "string") return [];
    const buf = open.get(m.turn) ?? { role: "agent" as const, text: "" };
    buf.text += m.text;
    open.set(m.turn, buf);
    return [{ type: "transcript", role: "agent", text: buf.text, final: false, id: `a${m.turn}` }];
  }
  if (m.type === "turn_ended") {
    const role = roleOf(m.role);
    if (typeof m.turn !== "number" || !role) return [];
    const buffered = open.get(m.turn)?.text ?? "";
    open.delete(m.turn);
    if (m.ignored === true) return [{ type: "speaking", who: "none" }];
    const text = typeof m.text === "string" ? m.text : buffered;
    const events: CallEvent[] = [];
    if (text.trim()) {
      events.push({
        type: "transcript",
        role,
        text,
        final: true,
        id: role === "agent" ? `a${m.turn}` : `u${m.turn}`,
      });
    }
    if (role === "agent" && m.interrupted === true) events.push({ type: "interrupted" });
    events.push({ type: "speaking", who: "none" });
    return events;
  }
  if (m.type === "error" && typeof m.message === "string" && m.message.trim()) {
    return [{ type: "system", text: m.message.trim() }];
  }
  return [];
}
