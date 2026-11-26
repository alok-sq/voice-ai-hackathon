import { CircleCheck, CircleDashed, ShieldCheck, type LucideIcon } from "lucide-react";
import { momentCounts, recordingDisclosed, type CallView } from "../state/callReducer";

interface Rule {
  text: string;
  status: string;
  met: boolean;
}

/** The brief's "build it like a good SolarSquare caller" rules, checked live during the call. */
export function GroundRules({ view }: { view: CallView }) {
  const moments = momentCounts(view);
  const disclosed = recordingDisclosed(view);
  const rules: Rule[] = [
    { text: "Says the call is recorded", status: disclosed ? "Done" : "Pending", met: disclosed },
    {
      text: "Never promises prices or subsidy amounts",
      status: moments.guardrail ? `${moments.guardrail} blocked` : "Guarded",
      met: true,
    },
    { text: "Stops when the caller asks", status: view.outcome?.outcome === "do_not_call" ? "Stopped" : "Guarded", met: true },
    { text: "Hands over when stuck", status: view.handoff ? "Handed over" : "Ready", met: true },
  ];

  return (
    <div className="rules">
      <h6 className="rules__title">
        <ShieldCheck size={16} />
        Ground rules
      </h6>
      <ul className="rules__list">
        {rules.map((r) => {
          const Icon: LucideIcon = r.met ? CircleCheck : CircleDashed;
          return (
            <li key={r.text} className={`rules__item${r.met ? " is-met" : ""}`}>
              <Icon size={16} />
              <span className="rules__text">{r.text}</span>
              <span className="rules__status">{r.status}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
