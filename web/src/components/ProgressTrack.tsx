import { Check, X } from "lucide-react";
import type { StepStatus } from "../state/callReducer";

const STATUS_TEXT: Record<StepStatus, string> = {
  done: "captured",
  failed: "ruled out",
  partial: "partly captured",
  current: "in progress",
  pending: "not reached",
  skipped: "not captured",
};

/** Connected step track: one node per qualification step, linked by a line that fills as steps complete. */
export function ProgressTrack({ steps }: { steps: { state: string; label: string; status: StepStatus }[] }) {
  return (
    <ol className="track" aria-label="Call progress">
      {steps.map((s, i) => (
        <li key={s.state} className={`track__step is-${s.status}`} aria-current={s.status === "current" ? "step" : undefined}>
          <span className="track__node" aria-hidden="true">
            {s.status === "done" ? <Check size={16} /> : s.status === "failed" ? <X size={16} /> : <span className="track__num">{i + 1}</span>}
          </span>
          <span className="track__label">
            {s.label}
            <span className="sr-only">, {STATUS_TEXT[s.status]}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
