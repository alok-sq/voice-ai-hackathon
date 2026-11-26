import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LeadField, LeadValues } from "../contract/events";
import { LEAD_FIELD_COUNT, LEAD_GROUPS, OUTCOME_LABELS, formatLeadValue } from "../domain/lead";
import { leadRecord, type CallView } from "../state/callReducer";

export function LeadPanel({ view }: { view: CallView }) {
  const captured = LEAD_GROUPS.flatMap((g) => g.fields).filter(({ field }) => view.lead[field] !== undefined).length;
  const outcome = view.outcome;

  return (
    <section className="card lead" aria-labelledby="lead-h">
      <div className="card__head">
        <h6 id="lead-h">Lead record</h6>
        <span className="caption mono">
          {captured} / {LEAD_FIELD_COUNT}
        </span>
      </div>

      <div className="outcome" data-outcome={outcome?.outcome ?? "none"}>
        <div className="outcome__main">
          <span className="outcome__label">Outcome</span>
          <span className="pill">{outcome ? OUTCOME_LABELS[outcome.outcome] : "Pending"}</span>
        </div>
        {outcome?.reason && <p className="outcome__detail">{outcome.reason}</p>}
        {outcome?.callbackAt && <p className="outcome__detail">Call back: {outcome.callbackAt}</p>}
      </div>

      {LEAD_GROUPS.map((group) => (
        <div className="group" key={group.title}>
          <h6>{group.title}</h6>
          {group.fields.map(({ field, label }) => (
            <LeadRow key={field} field={field} label={label} value={view.lead[field]} />
          ))}
        </div>
      ))}

      <CopyRecordButton disabled={!outcome} text={JSON.stringify(leadRecord(view), null, 2)} />
    </section>
  );
}

function LeadRow<F extends LeadField>({ field, label, value }: { field: F; label: string; value: LeadValues[F] | undefined }) {
  // Re-keying on the value restarts the highlight animation each time the field changes.
  const has = value !== undefined;
  const display = has ? formatLeadValue(field, value) : null;
  return (
    <div className={`row${has ? " flash" : ""}`} key={display ?? "empty"}>
      <span className="row__k">{label}</span>
      <span className={`row__v${has ? "" : " is-empty"}`}>{display ?? "Not captured"}</span>
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
    <button type="button" className="btn btn--ghost btn--sm" disabled={disabled} onClick={copy}>
      {copied ? <Check size={16} /> : <Copy size={16} />}
      {copied ? "Copied" : "Copy record as JSON"}
    </button>
  );
}
