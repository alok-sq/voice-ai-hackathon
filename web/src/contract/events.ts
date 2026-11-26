/**
 * Call event contract, v1.
 *
 * The agent publishes these as JSON on the LiveKit data topic `call-events`.
 * The demo and replay sources emit the same shapes, so the console renders
 * identically whatever the source.
 *
 * Compatibility rules:
 *   - `seq` and `ts` are optional so the original README events still parse.
 *     When the agent sends `seq` (monotonic per call), the console drops repeats.
 *   - Unknown event types and malformed events are ignored, never thrown.
 *   - New fields may be added; existing fields never change meaning.
 *
 * The console sends commands back on the topic `console-commands`
 * (see `ConsoleCommand` at the bottom of this file).
 */

export const CONTRACT_VERSION = 1;
export const EVENTS_TOPIC = "call-events";
export const COMMANDS_TOPIC = "console-commands";

/* ---------- Vocabulary ---------- */

export const FLOW_STATES = [
  "IDENTITY",
  "INTEREST",
  "PROPERTY",
  "BILL",
  "LOCATION_TIMELINE",
  "FINANCE",
  "MEETING_PITCH",
  "WRAP_UP",
  "DONE",
] as const;
export type FlowState = (typeof FLOW_STATES)[number];

export const OUTCOMES = ["qualified", "not_qualified", "callback", "wrong_number", "do_not_call"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const PROPERTY_TYPES = ["independent_house", "housing_society", "commercial"] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const ROOF_OWNERSHIP = ["owned", "rented", "shared"] as const;
export type RoofOwnership = (typeof ROOF_OWNERSHIP)[number];

export type Role = "agent" | "caller";
export type GuardrailKind = "price" | "savings" | "subsidy" | "other";

export interface MeetingSlot {
  /** Human-readable, as agreed on the call, e.g. "Tomorrow, 5 pm". */
  label: string;
  /** ISO 8601 date-time when the agent could resolve it. */
  iso?: string;
  /** Where the meeting happens, e.g. "Home" or an address. */
  location?: string;
}

/** Lead field -> value type. Units are fixed: rupees, square feet. */
export interface LeadValues {
  identity_confirmed: boolean;
  solar_interest: boolean;
  property_type: PropertyType;
  roof_ownership: RoofOwnership;
  roof_access: boolean;
  /** Square feet. */
  shadow_free_area: number;
  /** Rupees per month, integer. */
  monthly_bill: number;
  discom: string;
  city_or_pincode: string;
  timeline: string;
  loan_interest: boolean;
  subsidy_interest: boolean;
  meeting_slot: MeetingSlot;
}
export type LeadField = keyof LeadValues;
export type Lead = Partial<LeadValues>;

/* ---------- Events ---------- */

interface Envelope {
  /** Monotonic per call. Lets the console drop duplicates. */
  seq?: number;
  /** Epoch milliseconds when the agent produced the event. */
  ts?: number;
}

export type LeadEvent = { [F in LeadField]: Envelope & { type: "lead"; field: F; value: LeadValues[F] } }[LeadField];

export interface TranscriptLine {
  id: string;
  role: Role;
  text: string;
  final: boolean;
}

export type CallEvent =
  | (Envelope & { type: "state"; state: FlowState })
  | (Envelope & { type: "transcript"; role: Role; text: string; final: boolean; id?: string })
  | LeadEvent
  | (Envelope & { type: "outcome"; outcome: Outcome; reason?: string; callbackAt?: string })
  /** One per agent reply. replyMs = caller stopped speaking -> agent audio started. */
  | (Envelope & { type: "metric"; replyMs: number; sttMs?: number; llmTtftMs?: number; ttsTtfbMs?: number })
  | (Envelope & { type: "system"; text: string })
  /** Caller spoke over the agent and the agent stopped. */
  | (Envelope & { type: "interrupted" })
  /** Agent output was blocked because it stated a price, savings or subsidy figure. */
  | (Envelope & { type: "guardrail"; kind: GuardrailKind; text?: string })
  /** Caller went quiet and the agent prompted again. */
  | (Envelope & { type: "reprompt"; attempt: number })
  | (Envelope & { type: "handoff"; reason: string })
  /** Who is producing audio right now. */
  | (Envelope & { type: "speaking"; who: Role | "none" })
  /** Running totals for the call. costInr is computed by the agent from its rates. */
  | (Envelope & {
      type: "usage";
      costInr: number;
      llmTokensIn?: number;
      llmTokensOut?: number;
      sttSeconds?: number;
      ttsCharacters?: number;
    })
  /** Full state, sent when a console joins mid-call so it catches up. */
  | (Envelope & {
      type: "snapshot";
      state: FlowState | null;
      lead: Lead;
      outcome?: Outcome | null;
      transcript?: TranscriptLine[];
    })
  | (Envelope & { type: "call_ended"; reason: string });

export type CallEventType = CallEvent["type"];

/* ---------- Console -> agent commands ---------- */

export type ConsoleCommand = { type: "handoff_request"; reason: string };

/* ---------- Runtime validation ---------- */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const oneOf =
  <T extends string>(list: readonly T[]) =>
  (v: unknown): v is T =>
    isStr(v) && (list as readonly string[]).includes(v);
const optional =
  (check: (v: unknown) => boolean) =>
  (v: unknown): boolean =>
    v === undefined || check(v);

export const isFlowState = oneOf(FLOW_STATES);
export const isOutcome = oneOf(OUTCOMES);
const isRole = oneOf(["agent", "caller"] as const);

const isMeetingSlot = (v: unknown): v is MeetingSlot =>
  isObj(v) && isStr(v.label) && optional(isStr)(v.iso) && optional(isStr)(v.location);

const LEAD_VALUE_CHECKS: { [F in LeadField]: (v: unknown) => v is LeadValues[F] } = {
  identity_confirmed: isBool,
  solar_interest: isBool,
  property_type: oneOf(PROPERTY_TYPES),
  roof_ownership: oneOf(ROOF_OWNERSHIP),
  roof_access: isBool,
  shadow_free_area: isNum,
  monthly_bill: isNum,
  discom: isStr,
  city_or_pincode: isStr,
  timeline: isStr,
  loan_interest: isBool,
  subsidy_interest: isBool,
  meeting_slot: isMeetingSlot,
};

export const LEAD_FIELDS = Object.keys(LEAD_VALUE_CHECKS) as LeadField[];

export const isLeadField = (v: unknown): v is LeadField => isStr(v) && v in LEAD_VALUE_CHECKS;

export function isValidLeadValue<F extends LeadField>(field: F, value: unknown): value is LeadValues[F] {
  return LEAD_VALUE_CHECKS[field](value);
}

/** Keeps only fields whose values have the right type. */
export function sanitizeLead(v: unknown): Lead {
  if (!isObj(v)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (isLeadField(k) && isValidLeadValue(k, val)) out[k] = val;
  }
  return out as Lead;
}

const isTranscriptLine = (v: unknown): v is TranscriptLine =>
  isObj(v) && isStr(v.id) && isRole(v.role) && isStr(v.text) && isBool(v.final);

const SHAPES: Record<CallEventType, (e: Obj) => boolean> = {
  state: (e) => isFlowState(e.state),
  transcript: (e) => isRole(e.role) && isStr(e.text) && isBool(e.final) && optional(isStr)(e.id),
  lead: (e) => isLeadField(e.field) && isValidLeadValue(e.field, e.value),
  outcome: (e) => isOutcome(e.outcome) && optional(isStr)(e.reason) && optional(isStr)(e.callbackAt),
  metric: (e) =>
    isNum(e.replyMs) && optional(isNum)(e.sttMs) && optional(isNum)(e.llmTtftMs) && optional(isNum)(e.ttsTtfbMs),
  system: (e) => isStr(e.text),
  interrupted: () => true,
  guardrail: (e) => oneOf(["price", "savings", "subsidy", "other"] as const)(e.kind) && optional(isStr)(e.text),
  reprompt: (e) => isNum(e.attempt),
  handoff: (e) => isStr(e.reason),
  speaking: (e) => isRole(e.who) || e.who === "none",
  usage: (e) =>
    isNum(e.costInr) &&
    optional(isNum)(e.llmTokensIn) &&
    optional(isNum)(e.llmTokensOut) &&
    optional(isNum)(e.sttSeconds) &&
    optional(isNum)(e.ttsCharacters),
  snapshot: (e) =>
    (e.state === null || isFlowState(e.state)) &&
    isObj(e.lead) &&
    (e.outcome === undefined || e.outcome === null || isOutcome(e.outcome)) &&
    (e.transcript === undefined || (Array.isArray(e.transcript) && e.transcript.every(isTranscriptLine))),
  call_ended: (e) => isStr(e.reason),
};

/**
 * Validates an untrusted value (e.g. a parsed data message) as a CallEvent.
 * Returns null for anything that does not match the contract.
 */
export function parseEvent(raw: unknown): CallEvent | null {
  if (!isObj(raw) || !isStr(raw.type) || !(raw.type in SHAPES)) return null;
  if (!optional(isNum)(raw.seq) || !optional(isNum)(raw.ts)) return null;
  if (!SHAPES[raw.type as CallEventType](raw)) return null;
  // The shape checks above have verified the type, so these casts are sound.
  const event = raw as unknown as CallEvent;
  if (event.type === "snapshot") return { ...event, lead: sanitizeLead(raw.lead) };
  return event;
}
