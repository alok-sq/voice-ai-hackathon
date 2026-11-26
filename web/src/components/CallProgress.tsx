import { STEPS } from "../domain/lead";
import { currentStepLabel, stepStatuses, stepsDone, type CallView } from "../state/callReducer";
import { ProgressTrack } from "./ProgressTrack";
import { SectionHead } from "./SectionHead";

/** Where the call is in the qualification flow, as Sarvam-style "N of M done" plus a connected step strip. */
export function CallProgress({ view }: { view: CallView }) {
  const steps = stepStatuses(view);
  return (
    <section className="surface progress" aria-labelledby="progress-h">
      <SectionHead
        id="progress-h"
        title="Call progress"
        count={`${stepsDone(steps)} of ${STEPS.length} done`}
        aside={<span className="caption">{currentStepLabel(view)}</span>}
      />
      <ProgressTrack steps={steps} />
    </section>
  );
}
