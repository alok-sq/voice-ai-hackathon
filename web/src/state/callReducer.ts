/**
 * Call state: one pure reducer that every event source feeds.
 *
 * Demo scripts, recorded replays and the live LiveKit room all produce the
 * same CallEvents, so the console behaves identically whichever is running.
 * Keep this file free of React, timers and I/O so it stays unit-testable.
 */
import type { CallEvent, FlowState, GuardrailKind, Lead, Outcome, Role } from "../contract/events";
import { FLOW_STATES } from "../contract/events";
import { STEPS, isBlocking, isCaptured, type CellState, type Step } from "../domain/lead";

export type Phase = "idle" | "connecting" | "live" | "ended" | "error";
export type MarkerKind = "interrupted" | "guardrail" | "reprompt" | "handoff";

export type TimelineItem =
  | { kind: "line"; id: string; role: Role; text: string; final: boolean; at: number }
  | { kind: "system"; id: string; text: string; at: number }
  | { kind: "marker"; id: string; marker: MarkerKind; text: string; at: number };

export interface Turn {
  replyMs: number;
  sttMs?: number;
  llmTtftMs?: number;
  ttsTtfbMs?: number;
}

export interface Usage {
  costInr: number;
  llmTokensIn?: number;
  llmTokensOut?: number;
  sttSeconds?: number;
  ttsCharacters?: number;
}

export interface CallView {
  phase: Phase;
  flowState: FlowState | null;
  visited: FlowState[];
  lead: Lead;
  outcome: { outcome: Outcome; reason?: string; callbackAt?: string } | null;
  timeline: TimelineItem[];
  turns: Turn[];
  usage: Usage | null;
  handoff: string | null;
  speaking: Role | "none";
  startedAt: number | null;
  endedAt: number | null;
  endReason: string | null;
  error: string | null;
  /** Highest `seq` seen; events at or below it are duplicates. */
  lastSeq: number;
  /** Counter for locally generated timeline ids. */
  nextId: number;
}

export type CallAction =
  | { type: "connect"; at: number }
  | { type: "connected"; at: number }
  | { type: "event"; event: CallEvent; at: number }
  | { type: "end"; reason: string; at: number }
  | { type: "fail"; message: string; at: number }
  | { type: "reset" };

export const initialCallView: CallView = {
  phase: "idle",
  flowState: null,
  visited: [],
  lead: {},
  outcome: null,
  timeline: [],
  turns: [],
  usage: null,
  handoff: null,
  speaking: "none",
  startedAt: null,
  endedAt: null,
  endReason: null,
  error: null,
  lastSeq: -Infinity,
  nextId: 0,
};

/** Omit that keeps a union a union (plain Omit collapses it to shared keys). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const isActive = (phase: Phase) => phase === "connecting" || phase === "live";

const GUARDRAIL_TEXT: Record<GuardrailKind, string> = {
  price: "Blocked a price figure. Agent deflected.",
  savings: "Blocked a savings figure. Agent deflected.",
  subsidy: "Blocked a subsidy amount. Agent deflected.",
  other: "Blocked an unsafe claim. Agent deflected.",
};

export function callReducer(view: CallView, action: CallAction): CallView {
  switch (action.type) {
    case "reset":
      return initialCallView;

    case "connect":
      return { ...initialCallView, phase: "connecting", startedAt: action.at };

    case "connected":
      return view.phase === "connecting" ? { ...view, phase: "live", startedAt: action.at } : view;

    case "end":
      return isActive(view.phase) ? finish(view, action.reason, action.at) : view;

    case "fail":
      if (!isActive(view.phase)) return view;
      return { ...view, phase: "error", endedAt: action.at, error: action.message, speaking: "none" };

    case "event":
      return applyEvent(view, action.event, action.at);
  }
}

function applyEvent(view: CallView, event: CallEvent, at: number): CallView {
  if (!isActive(view.phase)) return view;
  if (event.seq !== undefined) {
    if (event.seq <= view.lastSeq) return view;
    view = { ...view, lastSeq: event.seq };
  }

  const push = (item: DistributiveOmit<TimelineItem, "id" | "at"> & { id?: string }): CallView => ({
    ...view,
    timeline: [...view.timeline, { ...item, id: item.id ?? `local-${view.nextId}`, at } as TimelineItem],
    nextId: view.nextId + 1,
  });
  const marker = (m: MarkerKind, text: string) => push({ kind: "marker", marker: m, text });

  switch (event.type) {
    case "state":
      return {
        ...view,
        flowState: event.state,
        visited: view.visited.includes(event.state) ? view.visited : [...view.visited, event.state],
      };

    case "transcript": {
      const idx = event.id ? view.timeline.findIndex((i) => i.kind === "line" && i.id === event.id) : -1;
      if (idx >= 0) {
        const timeline = view.timeline.slice();
        timeline[idx] = { ...(timeline[idx] as TimelineItem & { kind: "line" }), text: event.text, final: event.final };
        return { ...view, timeline };
      }
      return push({ kind: "line", id: event.id, role: event.role, text: event.text, final: event.final });
    }

    case "lead":
      return { ...view, lead: { ...view.lead, [event.field]: event.value } };

    case "outcome":
      return { ...view, outcome: { outcome: event.outcome, reason: event.reason, callbackAt: event.callbackAt } };

    case "metric":
      return {
        ...view,
        turns: [
          ...view.turns,
          { replyMs: event.replyMs, sttMs: event.sttMs, llmTtftMs: event.llmTtftMs, ttsTtfbMs: event.ttsTtfbMs },
        ],
      };

    case "system":
      return push({ kind: "system", text: event.text });

    case "interrupted":
      return marker("interrupted", "Caller interrupted. Agent stopped talking.");

    case "guardrail":
      return marker("guardrail", event.text ?? GUARDRAIL_TEXT[event.kind]);

    case "reprompt":
      return marker("reprompt", `Caller went quiet. Prompt again (${event.attempt}).`);

    case "handoff":
      return { ...marker("handoff", `Handed to a person: ${event.reason}`), handoff: event.reason };

    case "speaking":
      return { ...view, speaking: event.who };

    case "usage": {
      const { costInr, llmTokensIn, llmTokensOut, sttSeconds, ttsCharacters } = event;
      return { ...view, usage: { costInr, llmTokensIn, llmTokensOut, sttSeconds, ttsCharacters } };
    }

    case "snapshot": {
      const upTo = event.state ? FLOW_STATES.indexOf(event.state) : -1;
      const lines: TimelineItem[] = (event.transcript ?? []).map((l) => ({ kind: "line", ...l, at }));
      return {
        ...view,
        flowState: event.state,
        visited: FLOW_STATES.slice(0, upTo + 1),
        lead: event.lead,
        outcome: event.outcome ? { outcome: event.outcome } : null,
        timeline: [...lines, { kind: "system", id: `local-${view.nextId}`, text: "Joined mid-call. Caught up.", at }],
        nextId: view.nextId + 1,
      };
    }

    case "call_ended":
      return finish(view, event.reason, at);
  }
}

/** Ends the call and records why, in the timeline as well as on the view. */
function finish(view: CallView, reason: string, at: number): CallView {
  return {
    ...view,
    phase: "ended",
    endedAt: at,
    endReason: reason,
    speaking: "none",
    timeline: [...view.timeline, { kind: "system", id: `local-${view.nextId}`, text: reason, at }],
    nextId: view.nextId + 1,
  };
}

/* ---------- Derived views ---------- */

export type StepStatus = "done" | "failed" | "partial" | "current" | "pending" | "skipped";

/**
 * Progress per step, derived from what was captured rather than from the
 * order of states, so skipped or revisited steps show the truth.
 */
export function stepStatuses(view: CallView): { state: Step; label: string; status: StepStatus }[] {
  const over = view.phase === "ended" || view.phase === "error" || view.flowState === "DONE";
  const currentIdx = view.flowState ? FLOW_STATES.indexOf(view.flowState) : -1;

  return STEPS.map(({ state, label, fields }) => {
    let status: StepStatus;
    const answered = fields.length > 0 && fields.every((f) => isCaptured(view.lead, f));
    // A step is decided the moment the caller answers, not when Pari moves on, so the
    // tick, the chime and the panel cell all happen together on the answer.
    if (fields.some((f) => isCaptured(view.lead, f) && isBlocking(f, view.lead[f]))) {
      status = "failed";
    } else if (answered) {
      status = "done";
    } else if (!over && view.flowState === state) {
      status = "current";
    } else if (fields.length > 0) {
      const n = fields.filter((f) => isCaptured(view.lead, f)).length;
      status = n > 0 ? "partial" : over ? "skipped" : "pending";
    } else {
      const visited = view.visited.includes(state);
      const movedOn = currentIdx > FLOW_STATES.indexOf(state);
      status = visited && movedOn ? "done" : over ? "skipped" : "pending";
    }
    return { state, label, status };
  });
}

/**
 * What the progress sounds should say about one update: how many steps just
 * passed, and how many just failed (ruled out, left incomplete when the call
 * moved on, or never reached when it ended). Resets for a new call are silent.
 */
export function stepCues(prev: StepStatus[], next: StepStatus[]): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  next.forEach((to, i) => {
    const from = prev[i];
    if (from === undefined || from === to) return;
    if (to === "done") passed++;
    else if (to === "failed") failed++;
    else if (from === "current" && (to === "partial" || to === "pending" || to === "skipped")) failed++;
    else if (from === "pending" && to === "skipped") failed++;
  });
  return { passed, failed };
}

/** The solar panel: one cell per step, lit when the step passes. Same source as the progress strip and the chimes. */
export const stepCells = (statuses: StepStatus[]): CellState[] =>
  statuses.map((s) => (s === "done" ? "full" : s === "failed" ? "failed" : s === "partial" ? "partial" : "empty"));

/** Steps fully captured, for the "N of 8 done" counter. */
export const stepsDone = (steps: { status: StepStatus }[]) => steps.filter((s) => s.status === "done").length;

export function currentStepLabel(view: CallView): string {
  if (view.phase === "idle") return "Waiting for a call";
  if (view.flowState === "DONE" || view.phase === "ended") return "Call complete";
  const step = STEPS.find((s) => s.state === view.flowState);
  return step ? `Now: ${step.label.toLowerCase()}` : "Starting";
}

export function medianReplyMs(turns: Turn[]): number | null {
  if (turns.length === 0) return null;
  const sorted = turns.map((t) => t.replyMs).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export type OrbState = "idle" | "connecting" | "listening" | "agent" | "caller" | "ended";

/** What the agent orb shows: the call phase, then who holds the floor. */
export function orbState(view: CallView): OrbState {
  switch (view.phase) {
    case "idle":
      return "idle";
    case "connecting":
      return "connecting";
    case "ended":
    case "error":
      return "ended";
    case "live":
      return view.speaking === "none" ? "listening" : view.speaking;
  }
}

/** Ground rule from the brief: the agent says the call is recorded. True once it has. */
export function recordingDisclosed(view: CallView): boolean {
  return view.timeline.some((i) => i.kind === "line" && i.role === "agent" && i.final && /record/i.test(i.text));
}

/** Robustness moments handled during the call, by kind. */
export function momentCounts(view: CallView): Record<MarkerKind, number> {
  const counts: Record<MarkerKind, number> = { interrupted: 0, guardrail: 0, reprompt: 0, handoff: 0 };
  for (const item of view.timeline) if (item.kind === "marker") counts[item.marker] += 1;
  return counts;
}

/** The record the console exports: what the agent would write to the CRM. */
export function leadRecord(view: CallView) {
  return { outcome: view.outcome, lead: view.lead, usage: view.usage, turns: view.turns.length };
}
