import { Ban, Check, CircleAlert, CircleCheck, CircleMinus, Copy, PhoneForwarded, PhoneMissed, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Outcome } from "../contract/events";
import { languageLabel } from "../domain/language";
import { STEPS } from "../domain/lead";
import { callDuration, nextAction, outcomeLabel, summaryFacts, summaryText } from "../domain/summary";
import { medianReplyMs, momentCounts, stepStatuses, stepsDone } from "../state/callReducer";
import type { SessionRecord } from "../state/sessions";

export const OUTCOME_ICONS: Record<Outcome | "none", LucideIcon> = {
  qualified: CircleCheck,
  not_qualified: CircleMinus,
  callback: PhoneForwarded,
  wrong_number: PhoneMissed,
  do_not_call: Ban,
  none: CircleAlert,
};

/**
 * The hand-off after a call: outcome, what happens next, what was learned,
 * and how the call performed. Built only from captured fields.
 */
export function SummaryCard({ session }: { session: SessionRecord }) {
  const { view, caller } = session;
  const outcome = view.outcome?.outcome ?? "none";
  const Icon = OUTCOME_ICONS[outcome];
  const action = nextAction(view);
  const facts = summaryFacts(view.lead);
  const median = medianReplyMs(view.turns);
  const m = momentCounts(view);
  const language = languageLabel(session.language);
  const text = summaryText({ view, callerName: caller.name, city: caller.city, language });

  return (
    <section className="surface summary" data-outcome={outcome} aria-labelledby={`summary-h-${session.id}`}>
      <div className="summary__top">
        <h2 id={`summary-h-${session.id}`} className="section-title">
          Call summary
        </h2>
        <CopyButton text={text} />
      </div>

      <div className="summary__head">
        <span className="summary__badge">
          <Icon size={16} />
          {outcomeLabel(view)}
        </span>
        <span className="summary__who">
          {caller.name} · {caller.city} · {language} · <span className="mono">{callDuration(view)}</span>
        </span>
      </div>

      <p className="summary__action">{action.headline}</p>
      {action.detail && <p className="summary__detail">{action.detail}</p>}

      {facts.length > 0 && (
        <ul className="summary__facts" aria-label="Captured details">
          {facts.map((f) => (
            <li key={f} className="summary__fact">
              {f}
            </li>
          ))}
        </ul>
      )}

      <dl className="summary__stats">
        <Stat label="Median reply" value={median !== null ? `${median} ms` : "—"} />
        <Stat label="Cost" value={view.usage ? `₹${view.usage.costInr.toFixed(2)}` : "—"} />
        <Stat label="Steps" value={`${stepsDone(stepStatuses(view))} of ${STEPS.length}`} />
        <Stat label="Moments handled" value={String(m.interrupted + m.guardrail + m.reprompt)} />
      </dl>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="summary__stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (insecure origin, permissions); nothing useful to show.
    }
  };

  return (
    <button type="button" className="btn btn--ghost btn--sm" onClick={copy}>
      {copied ? <Check size={16} /> : <Copy size={16} />}
      {copied ? "Copied" : "Copy summary"}
    </button>
  );
}
