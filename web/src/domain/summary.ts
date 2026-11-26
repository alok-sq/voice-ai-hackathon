/**
 * The post-call summary, built only from what the call captured.
 * No model writes it, so it can never claim something the caller did not say.
 */
import type { Lead, LeadValues } from "../contract/events";
import { medianReplyMs, stepStatuses, stepsDone, type CallView } from "../state/callReducer";
import { AGENT } from "./agent";
import { OUTCOME_LABELS, STEPS, formatLeadValue } from "./lead";

const pad = (n: number) => String(n).padStart(2, "0");

/** mm:ss. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Today, 5:42 pm" or "24 Nov, 9:05 am", in the viewer's local time. */
export function formatWhen(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  const h = d.getHours() % 12 || 12;
  const time = `${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? "am" : "pm"}`;
  return `${sameDay ? "Today" : `${d.getDate()} ${MONTHS[d.getMonth()]}`}, ${time}`;
}

const OWNERSHIP: Record<LeadValues["roof_ownership"], string> = { owned: "Owned roof", rented: "Rented roof", shared: "Shared roof" };
const yesNo = (v: boolean | undefined, yes: string, no: string) => (v === undefined ? undefined : v ? yes : no);

/** Short facts for the summary chips, in reading order. Identity, interest and the slot are said elsewhere. */
export function summaryFacts(lead: Lead): string[] {
  const facts = [
    lead.property_type && formatLeadValue("property_type", lead.property_type),
    lead.roof_ownership && OWNERSHIP[lead.roof_ownership],
    yesNo(lead.roof_access, "Roof access", "No roof access"),
    lead.shadow_free_area !== undefined ? `${formatLeadValue("shadow_free_area", lead.shadow_free_area)} shadow-free` : undefined,
    lead.monthly_bill !== undefined ? `${formatLeadValue("monthly_bill", lead.monthly_bill)}/month` : undefined,
    lead.discom,
    lead.city_or_pincode,
    lead.timeline,
    yesNo(lead.loan_interest, "Wants a loan", "No loan"),
    yesNo(lead.subsidy_interest, "Wants subsidy info", "No subsidy interest"),
  ];
  return facts.filter((f): f is string => typeof f === "string" && f.length > 0);
}

/** What happens next for this lead: the line a sales team acts on. */
export function nextAction(view: CallView): { headline: string; detail?: string } {
  const o = view.outcome;
  if (!o) return { headline: view.phase === "error" && view.error ? `Call failed: ${view.error}` : "Ended before an outcome." };
  switch (o.outcome) {
    case "qualified": {
      const slot = view.lead.meeting_slot;
      return { headline: slot ? `Survey booked: ${formatLeadValue("meeting_slot", slot)}` : "Qualified. Survey time not agreed yet." };
    }
    case "callback": {
      const headline = o.callbackAt ? `Call back: ${o.callbackAt}` : "Call back later.";
      return o.reason ? { headline, detail: o.reason } : { headline };
    }
    case "not_qualified":
      return { headline: o.reason ?? "Does not meet the criteria." };
    case "wrong_number":
      return { headline: "Number doesn't belong to the lead." };
    case "do_not_call":
      return { headline: "Added to do-not-call. No more calls." };
  }
}

export const outcomeLabel = (view: CallView) => (view.outcome ? OUTCOME_LABELS[view.outcome.outcome] : view.phase === "error" ? "Failed" : "No outcome");

export const callDuration = (view: CallView) =>
  view.startedAt !== null && view.endedAt !== null ? formatDuration(view.endedAt - view.startedAt) : "00:00";

/** Plain text for a CRM note or a chat message. */
export function summaryText({ view, callerName, city, language }: { view: CallView; callerName: string; city: string; language: string }): string {
  const action = nextAction(view);
  const facts = summaryFacts(view.lead);
  const median = medianReplyMs(view.turns);
  const stats = [
    median !== null ? `Median reply ${median} ms` : null,
    view.usage ? `Cost ₹${view.usage.costInr.toFixed(2)}` : null,
    `${stepsDone(stepStatuses(view))} of ${STEPS.length} steps`,
  ].filter(Boolean);
  return [
    `${AGENT.name} call · ${outcomeLabel(view)}`,
    `${callerName} · ${city} · ${language} · ${callDuration(view)}`,
    action.headline,
    action.detail,
    facts.length ? facts.join(" · ") : null,
    stats.join(" · "),
  ]
    .filter(Boolean)
    .join("\n");
}
