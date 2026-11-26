import { Hand, ShieldCheck, Timer, UserRoundCheck } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { AGENT } from "../domain/agent";
import type { CallView, MarkerKind, TimelineItem } from "../state/callReducer";
import { AgentOrb } from "./AgentOrb";
import { RevealText } from "./RevealText";
import { RooftopIllustration } from "./RooftopIllustration";
import { SectionHead } from "./SectionHead";

const MARKER_ICONS: Record<MarkerKind, ReactNode> = {
  interrupted: <Hand size={16} />,
  guardrail: <ShieldCheck size={16} />,
  reprompt: <Timer size={16} />,
  handoff: <UserRoundCheck size={16} />,
};

/** Distance from the bottom (px) within which the log keeps following new lines. */
const FOLLOW_THRESHOLD = 80;

/** `replay` shows a finished call as it ended: no word-by-word reveal. */
export function Conversation({ view, callerName, replay = false }: { view: CallView; callerName: string; replay?: boolean }) {
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
    <section className="surface convo" aria-labelledby="convo-h">
      <SectionHead id="convo-h" title="Conversation" count={view.phase === "idle" ? "no call yet" : `with ${callerName}`} />

      <div className="log" ref={logRef} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
        {view.timeline.length === 0 ? (
          <div className="empty">
            <RooftopIllustration />
            <p className="empty__title">{view.phase === "connecting" ? "Connecting the call" : `${AGENT.name} is ready to call`}</p>
            <p className="empty__body">The conversation appears here as it happens, in the caller's own words.</p>
          </div>
        ) : (
          view.timeline.map((item) => <TimelineRow key={item.id} item={item} callerName={callerName} replay={replay} />)
        )}
      </div>
    </section>
  );
}

function TimelineRow({ item, callerName, replay }: { item: TimelineItem; callerName: string; replay: boolean }) {
  switch (item.kind) {
    case "line":
      return item.role === "agent" ? (
        <div className={`msg msg--agent${item.final ? "" : " is-interim"}`}>
          <AgentOrb state="idle" size="sm" />
          <div className="msg__body">
            <span className="msg__who">{AGENT.name}</span>
            <div className="msg__bubble">{item.final && !replay ? <RevealText text={item.text} /> : item.text}</div>
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
