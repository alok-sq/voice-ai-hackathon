import { Hand, ShieldCheck, Timer, UserRoundCheck } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { AGENT } from "../domain/agent";
import { currentStepLabel, stepStatuses, type CallView, type MarkerKind, type TimelineItem } from "../state/callReducer";
import { AgentOrb } from "./AgentOrb";
import { ProgressTrack } from "./ProgressTrack";
import { RooftopIllustration } from "./RooftopIllustration";

const MARKER_ICONS: Record<MarkerKind, ReactNode> = {
  interrupted: <Hand size={16} />,
  guardrail: <ShieldCheck size={16} />,
  reprompt: <Timer size={16} />,
  handoff: <UserRoundCheck size={16} />,
};

/** Distance from the bottom (px) within which the log keeps following new lines. */
const FOLLOW_THRESHOLD = 80;

export function Conversation({ view, callerName }: { view: CallView; callerName: string }) {
  const logRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const last = view.timeline.at(-1);

  // Follow new lines, unless the reader has scrolled up to look at something.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && following.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [view.timeline.length, last?.kind === "line" ? last.text : null]);

  const onScroll = () => {
    const el = logRef.current;
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD;
  };

  return (
    <section className="card convo" aria-labelledby="convo-h">
      <div className="card__head">
        <h6 id="convo-h">Conversation</h6>
        <span className="caption">{currentStepLabel(view)}</span>
      </div>

      <ProgressTrack steps={stepStatuses(view)} />

      <div className="log" ref={logRef} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
        {view.timeline.length === 0 ? (
          <div className="empty">
            <RooftopIllustration />
            <p className="empty__title">{view.phase === "connecting" ? "Connecting the call" : `${AGENT.name} is ready to call`}</p>
            <p className="empty__body">The conversation appears here as it happens, in the caller's own words.</p>
          </div>
        ) : (
          view.timeline.map((item) => <TimelineRow key={item.id} item={item} callerName={callerName} />)
        )}
      </div>
    </section>
  );
}

function TimelineRow({ item, callerName }: { item: TimelineItem; callerName: string }) {
  switch (item.kind) {
    case "line":
      return item.role === "agent" ? (
        <div className={`msg msg--agent${item.final ? "" : " is-interim"}`}>
          <AgentOrb state="idle" size="sm" />
          <div className="msg__body">
            <span className="msg__who">{AGENT.name}</span>
            <div className="msg__bubble">{item.text}</div>
          </div>
        </div>
      ) : (
        <div className={`msg msg--caller${item.final ? "" : " is-interim"}`}>
          <div className="msg__body">
            <span className="msg__who">{callerName}</span>
            <div className="msg__bubble">{item.text}</div>
          </div>
        </div>
      );
    case "system":
      return <div className="sys">{item.text}</div>;
    case "marker":
      return (
        <div className="marker" data-marker={item.marker}>
          {MARKER_ICONS[item.marker]}
          {item.text}
        </div>
      );
  }
}
