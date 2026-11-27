/**
 * Call history, kept in this browser. Pure helpers here; the hook in
 * useSessions.ts does the storage. Nothing leaves the device.
 */
import type { Outcome } from "../contract/events";
import type { CallerProfile } from "../domain/agent";
import type { Language, SourceKind } from "../sources/types";
import { medianReplyMs, type CallView } from "./callReducer";

export const SESSION_LIMIT = 50;

export interface SessionMeta {
  source: SourceKind;
  language: Language;
  /** Scenario title for scripted calls; null when a real agent took the call. */
  scenarioTitle: string | null;
  caller: CallerProfile;
}

export interface SessionRecord extends SessionMeta {
  /** The call's start time, which is unique per call in this console. */
  id: string;
  startedAt: number;
  endedAt: number;
  /** The call as it ended. */
  view: CallView;
}

/**
 * A saved snapshot of a finished call, or null when there is nothing worth keeping:
 * the call is still running, or it ended before anyone spoke.
 */
export function toSession(view: CallView, meta: SessionMeta): SessionRecord | null {
  if (view.phase !== "ended" && view.phase !== "error") return null;
  if (view.startedAt === null || view.endedAt === null) return null;
  if (!view.timeline.some((t) => t.kind === "line")) return null;
  return {
    ...meta,
    id: String(view.startedAt),
    startedAt: view.startedAt,
    endedAt: view.endedAt,
    view: {
      ...view,
      // Half-heard lines are noise in a record; -Infinity does not survive JSON.
      timeline: view.timeline.filter((t) => t.kind !== "line" || t.final),
      speaking: "none",
      lastSeq: 0,
    },
  };
}

/** Newest first, one entry per call, at most `limit`. */
export function addSession(list: SessionRecord[], rec: SessionRecord, limit = SESSION_LIMIT): SessionRecord[] {
  return [rec, ...list.filter((s) => s.id !== rec.id)].slice(0, limit);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function isSession(v: unknown): v is SessionRecord {
  if (!isObj(v) || !isObj(v.view) || !isObj(v.caller)) return false;
  return (
    typeof v.id === "string" &&
    typeof v.startedAt === "number" &&
    typeof v.endedAt === "number" &&
    typeof v.caller.name === "string" &&
    Array.isArray(v.view.timeline) &&
    Array.isArray(v.view.turns) &&
    isObj(v.view.lead)
  );
}

/**
 * Records saved before the four-source model used "demo" for scripted playback.
 * Only scripted calls carry a scenario title, so that tells the two apart.
 */
function upgrade(s: SessionRecord): SessionRecord {
  return s.source === "demo" && s.scenarioTitle !== null ? { ...s, source: "scripted" } : s;
}

/** Reads stored history defensively: anything broken is dropped, never thrown. */
export function parseSessions(raw: string | null): SessionRecord[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    return Array.isArray(data) ? data.filter(isSession).map(upgrade) : [];
  } catch {
    return [];
  }
}

/** How a saved call was made, for history rows and the session header. */
export function sourceLabel(source: SourceKind, scenarioTitle: string | null): string {
  switch (source) {
    case "scripted":
      return scenarioTitle ? `Scripted · ${scenarioTitle}` : "Scripted";
    case "demo":
      return "Demo · cascaded";
    case "demo_v2":
      return "Demo v2 · speech to speech";
    case "demo_v3":
      return "Demo v3 · Cartesia agent";
    case "demo_v4":
      return "Demo v4 · ElevenLabs agent";
    case "live":
      return scenarioTitle ? `Live call · ${scenarioTitle}` : "Live call";
  }
}

export interface HistoryStats {
  total: number;
  outcomes: Partial<Record<Outcome | "none", number>>;
  /** Median of every agent reply across all calls. */
  medianReplyMs: number | null;
}

export function historyStats(list: SessionRecord[]): HistoryStats {
  const outcomes: HistoryStats["outcomes"] = {};
  for (const s of list) {
    const k = s.view.outcome?.outcome ?? "none";
    outcomes[k] = (outcomes[k] ?? 0) + 1;
  }
  return { total: list.length, outcomes, medianReplyMs: medianReplyMs(list.flatMap((s) => s.view.turns)) };
}
