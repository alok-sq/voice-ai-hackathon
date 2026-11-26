import {
  Ban,
  CalendarCheck,
  Check,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  Copy,
  House,
  IndianRupee,
  MapPin,
  PhoneForwarded,
  PhoneMissed,
  UserRoundCheck,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LeadField, LeadValues, Outcome } from "../contract/events";
import { LEAD_FIELD_COUNT, LEAD_GROUPS, OUTCOME_LABELS, capturedCount, formatLeadValue } from "../domain/lead";
import { leadRecord, stepStatuses, type CallView } from "../state/callReducer";
import { SectionHead } from "./SectionHead";
import { SolarPanelMeter } from "./SolarPanelMeter";

const GROUP_ICONS: Record<string, LucideIcon> = {
  Caller: UserRoundCheck,
  Property: House,
  Energy: Zap,
  "Location and timing": MapPin,
  Finance: IndianRupee,
  Meeting: CalendarCheck,
};

const OUTCOME_ICONS: Record<Outcome, LucideIcon> = {
  qualified: CircleCheck,
  not_qualified: CircleMinus,
  callback: PhoneForwarded,
  wrong_number: PhoneMissed,
  do_not_call: Ban,
};

export function LeadCard({ view }: { view: CallView }) {
  const outcome = view.outcome;
  const OutcomeIcon = outcome ? OUTCOME_ICONS[outcome.outcome] : CircleDashed;

  return (
    <section className="surface lead" aria-labelledby="lead-h">
      <SectionHead id="lead-h" title="Lead record" count={`${capturedCount(view.lead)} of ${LEAD_FIELD_COUNT}`} />
      <div className="lead__top">
        <SolarPanelMeter steps={stepStatuses(view).map((s) => s.status)} />
        <p className="lead__sub">Captured live from the call. Each panel cell lights up as a step of the call passes.</p>
      </div>

      {/* Re-keyed on the outcome so its reveal plays each time it changes. */}
      <div className="outcome" data-outcome={outcome?.outcome ?? "none"} key={outcome?.outcome ?? "none"}>
        <span className="outcome__icon">
          <OutcomeIcon size={20} />
        </span>
        <div className="outcome__text">
          <span className="outcome__label">Outcome</span>
          <span className="outcome__value">{outcome ? OUTCOME_LABELS[outcome.outcome] : "In progress"}</span>
          {outcome?.reason && <span className="outcome__detail">{outcome.reason}</span>}
          {outcome?.callbackAt && <span className="outcome__detail">Call back: {outcome.callbackAt}</span>}
        </div>
      </div>

      <div className="groups">
        {LEAD_GROUPS.map((group) => {
          const Icon = GROUP_ICONS[group.title] ?? House;
          return (
            <div className="group" key={group.title}>
              <h3 className="group__title">
                <Icon size={16} />
                {group.title}
              </h3>
              {group.fields.map(({ field, label }) => (
                <LeadRow key={field} field={field} label={label} value={view.lead[field]} />
              ))}
            </div>
          );
        })}
      </div>

      <CopyRecordButton disabled={!outcome} text={JSON.stringify(leadRecord(view), null, 2)} />
    </section>
  );
}

function LeadRow<F extends LeadField>({ field, label, value }: { field: F; label: string; value: LeadValues[F] | undefined }) {
  const has = value !== undefined;
  const display = has ? formatLeadValue(field, value) : null;
  // Re-keying on the value restarts the highlight each time the field changes.
  return (
    <div className={`row${has ? " flash" : ""}`} key={display ?? "empty"}>
      <span className="row__k">{label}</span>
      <span className={`row__v${has ? "" : " is-empty"}`}>{display ?? "—"}</span>
    </div>
  );
}

function CopyRecordButton({ text, disabled }: { text: string; disabled: boolean }) {
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
    <button type="button" className="btn btn--ghost btn--sm btn--block" disabled={disabled} onClick={copy}>
      {copied ? <Check size={16} /> : <Copy size={16} />}
      {copied ? "Copied" : "Copy record as JSON"}
    </button>
  );
}
