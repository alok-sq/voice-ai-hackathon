import { ArrowLeft } from "lucide-react";
import { formatWhen } from "../domain/summary";
import { sourceLabel, type SessionRecord } from "../state/sessions";
import { CallProgress } from "./CallProgress";
import { Conversation } from "./Conversation";
import { LeadCard } from "./LeadCard";
import { PerformanceBand } from "./PerformanceBand";
import { SummaryCard } from "./SummaryCard";

/** One past call, read-only, exactly as it ended. */
export function SessionView({ session, onBack }: { session: SessionRecord; onBack: () => void }) {
  return (
    <>
      <div className="session-bar">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onBack}>
          <ArrowLeft size={16} />
          All calls
        </button>
        <span className="caption">
          {formatWhen(session.startedAt)} · {sourceLabel(session.source, session.scenarioTitle)}
        </span>
      </div>
      <SummaryCard session={session} />
      <CallProgress view={session.view} />
      <Conversation view={session.view} callerName={session.caller.name} replay />
      <LeadCard view={session.view} />
      <PerformanceBand view={session.view} />
    </>
  );
}
