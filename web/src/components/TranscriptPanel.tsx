import { AudioLines, Hand, ShieldCheck, Timer, UserRoundCheck } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { currentStepLabel, stepStatuses, type CallView, type MarkerKind, type TimelineItem } from "../state/callReducer";

const MARKER_ICONS: Record<MarkerKind, ReactNode> = {
  interrupted: <Hand size={16} />,
  guardrail: <ShieldCheck size={16} />,
  reprompt: <Timer size={16} />,
  handoff: <UserRoundCheck size={16} />,
};

const STEP_STATUS_TEXT = {
  done: "captured",
  partial: "partly captured",
  current: "in progress",
  pending: "not reached",
  skipped: "not captured",
} as const;

/** Distance from the bottom (px) within which the log keeps following new lines. */
const FOLLOW_THRESHOLD = 80;

export function TranscriptPanel({ view }: { view: CallView }) {
  const logRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const last = view.timeline.at(-1);

  // Follow new lines, unless the reader has scrolled up to look at something.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [view.timeline.length, last?.kind === "line" ? last.text : null]);

  const onScroll = () => {
    const el = logRef.current;
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD;
  };

  return (
    <section className="card transcript" aria-labelledby="tr-h">
      <div className="card__head">
        <h6 id="tr-h">Live transcript</h6>
        <span className="caption">{currentStepLabel(view)}</span>
      </div>

      <ol className="steps" aria-label="Call progress">
        {stepStatuses(view).map((s) => (
          <li key={s.state} className={`step is-${s.status}`} aria-current={s.status === "current" ? "step" : undefined}>
            {s.label}
            <span className="sr-only">, {STEP_STATUS_TEXT[s.status]}</span>
          </li>
        ))}
      </ol>

      <div className="log" ref={logRef} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
        {view.timeline.length === 0 ? (
          <div className="empty">
            <AudioLines size={24} />
            <p>{view.phase === "connecting" ? "Connecting." : "Start a call to see the conversation here."}</p>
          </div>
        ) : (
          view.timeline.map((item) => <TimelineRow key={item.id} item={item} />)
        )}
      </div>
    </section>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case "line":
      return (
        <div className={`msg msg--${item.role}${item.final ? "" : " is-interim"}`}>
          <span className="msg__who">{item.role === "agent" ? "Agent" : "Caller"}</span>
          <div className="msg__bubble">{item.text}</div>
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
