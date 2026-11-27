import type { CallEvent } from "../contract/events";

/** When the caller’s transcript arrived, waiting for the first audio of the reply. */
export interface ElevenClock {
  since: number | null;
  n: number;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Turn ElevenLabs websocket events into console call events.
 * Audio is played by the source; this only times the first chunk of a reply.
 */
export function eventsFromElevenLabs(msg: unknown, clock: ElevenClock, now: number): CallEvent[] {
  if (!msg || typeof msg !== "object") return [];
  const m = msg as Record<string, unknown>;
  if (m.type === "user_transcript") {
    const body = m.user_transcription_event as Record<string, unknown> | undefined;
    const text = textOf(body?.user_transcript);
    if (!text) return [];
    clock.n += 1;
    clock.since = now;
    return [
      { type: "transcript", role: "caller", text, final: true, id: `u${clock.n}` },
      { type: "speaking", who: "none" },
    ];
  }
  if (m.type === "agent_response" || m.type === "agent_response_correction") {
    const body = (m.agent_response_event ?? m.agent_response_correction_event) as Record<string, unknown> | undefined;
    const text = textOf(body?.agent_response ?? body?.corrected_agent_response);
    if (!text) return [];
    clock.n += 1;
    return [
      { type: "transcript", role: "agent", text, final: true, id: `a${clock.n}` },
      { type: "speaking", who: "agent" },
    ];
  }
  if (m.type === "audio") {
    const body = m.audio_event as Record<string, unknown> | undefined;
    if (typeof body?.audio_base_64 !== "string" || !body.audio_base_64 || clock.since === null) return [];
    const replyMs = Math.max(0, Math.round(now - clock.since));
    clock.since = null;
    return [{ type: "metric", replyMs }];
  }
  if (m.type === "interruption") return [{ type: "interrupted" }, { type: "speaking", who: "none" }];
  return [];
}

export function outputSampleRate(format: unknown): number {
  if (typeof format !== "string") return 16_000;
  const match = /pcm_(\d+)/.exec(format);
  const rate = match ? Number(match[1]) : 16_000;
  return Number.isFinite(rate) && rate > 0 ? rate : 16_000;
}
