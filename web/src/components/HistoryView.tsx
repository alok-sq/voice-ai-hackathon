import { ChevronRight, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Outcome } from "../contract/events";
import { languageLabel } from "../domain/language";
import { OUTCOME_LABELS } from "../domain/lead";
import { callDuration, formatWhen, outcomeLabel } from "../domain/summary";
import { medianReplyMs } from "../state/callReducer";
import { historyStats, sourceLabel, type SessionRecord } from "../state/sessions";
import { RooftopIllustration } from "./RooftopIllustration";
import { SectionHead } from "./SectionHead";
import { OUTCOME_ICONS } from "./SummaryCard";

const ORDER: (Outcome | "none")[] = ["qualified", "callback", "not_qualified", "wrong_number", "do_not_call", "none"];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Props {
  sessions: SessionRecord[];
  onOpen: (id: string) => void;
  onClear: () => void;
  onWatchDemo: () => void;
}

/** Every call made in this browser, newest first, with the totals that matter across them. */
export function HistoryView({ sessions, onOpen, onClear, onWatchDemo }: Props) {
  const stats = historyStats(sessions);
  const totals = ORDER.filter((k) => stats.outcomes[k]).map(
    (k) => `${stats.outcomes[k]} ${k === "none" ? "no outcome" : OUTCOME_LABELS[k].toLowerCase()}`,
  );

  return (
    <section className="history" aria-labelledby="history-h">
      <SectionHead
        id="history-h"
        title="History"
        count={plural(stats.total, "call")}
        aside={
          stats.total > 0 && (
            <span className="caption">
              {totals.join(" · ")}
              {stats.medianReplyMs !== null && ` · median reply ${stats.medianReplyMs} ms`}
            </span>
          )
        }
      />

      {sessions.length === 0 ? (
        <div className="surface history__empty">
          <RooftopIllustration />
          <p className="empty__title">No calls yet</p>
          <p className="empty__body">Every call you make here is saved in this browser, with its summary and full conversation.</p>
          <button type="button" className="btn btn--primary" onClick={onWatchDemo}>
            <Play size={16} />
            Watch a demo call
          </button>
        </div>
      ) : (
        <>
          <div className="history__cols" aria-hidden="true">
            <span>Outcome</span>
            <span>Caller</span>
            <span className="history__when">When</span>
            <span className="session__nums">
              <span>Length</span>
              <span>Reply</span>
              <span>Cost</span>
            </span>
            <span />
          </div>
          <ol className="history__list">
            {sessions.map((s) => (
              <li key={s.id}>
                <SessionRow session={s} onOpen={() => onOpen(s.id)} />
              </li>
            ))}
          </ol>
          <ClearHistory count={sessions.length} onClear={onClear} />
        </>
      )}
    </section>
  );
}

function SessionRow({ session: s, onOpen }: { session: SessionRecord; onOpen: () => void }) {
  const outcome = s.view.outcome?.outcome ?? "none";
  const Icon = OUTCOME_ICONS[outcome];
  const median = medianReplyMs(s.view.turns);
  return (
    <button type="button" className="session" data-outcome={outcome} onClick={onOpen}>
      <span className="session__outcome">
        <Icon size={16} />
        {outcomeLabel(s.view)}
      </span>
      <span className="session__who">
        <span className="session__name">{s.caller.name}</span>
        <span className="session__meta">
          {s.caller.city} · {sourceLabel(s.source, s.scenarioTitle)} · {languageLabel(s.language)}
        </span>
      </span>
      <span className="session__when">{formatWhen(s.startedAt)}</span>
      <span className="session__nums mono">
        <span>{callDuration(s.view)}</span>
        <span>{median !== null ? `${median} ms` : "—"}</span>
        <span>{s.view.usage ? `₹${s.view.usage.costInr.toFixed(2)}` : "—"}</span>
      </span>
      <ChevronRight size={18} className="session__go" />
    </button>
  );
}

/** Two-step clear, inline: no browser confirm box in the middle of a demo. */
function ClearHistory({ count, onClear }: { count: number; onClear: () => void }) {
  const [asking, setAsking] = useState(false);
  return (
    <div className="history__clear">
      {asking ? (
        <>
          <span className="caption">Delete {plural(count, "saved call")} from this browser?</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAsking(false)}>
            Keep them
          </button>
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={() => {
              setAsking(false);
              onClear();
            }}
          >
            Delete
          </button>
        </>
      ) : (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAsking(true)}>
          <Trash2 size={16} />
          Clear history
        </button>
      )}
    </div>
  );
}
