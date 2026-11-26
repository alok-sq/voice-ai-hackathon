import { CircleCheck } from "lucide-react";
import { useState } from "react";
import { medianReplyMs, momentCounts, type CallView, type Turn } from "../state/callReducer";
import { useCountUp } from "../state/motion";

/** Reply-time target from the brief: no awkward pause, under a second. */
const TARGET_MS = 1000;

/**
 * The judging criteria as numbers: speed, cost and robustness.
 * Stat tiles use the UI sans (never a display face) per the chart rules.
 */
export function PerformanceBand({ view }: { view: CallView }) {
  const moments = momentCounts(view);
  const median = useCountUp(medianReplyMs(view.turns));
  const cost = useCountUp(view.usage ? view.usage.costInr : null);
  const handled = useCountUp(moments.interrupted + moments.guardrail + moments.reprompt) ?? 0;

  return (
    <section className="card perf" aria-labelledby="perf-h">
      <div className="perf__head">
        <h6 id="perf-h">Call performance</h6>
        <span className="caption">What the judges score, measured on this call</span>
      </div>
      <div className="perf__grid">
        <Tile
          label="Median reply"
          value={median !== null ? `${Math.round(median)} ms` : "—"}
          note={`Target under ${TARGET_MS / 1000} s`}
          good={median !== null && median < TARGET_MS}
        />
        <div className="tile tile--chart">
          <span className="tile__label">Reply time per turn</span>
          <ReplyChart turns={view.turns} />
        </div>
        <Tile label="Cost per call" value={cost !== null ? `₹${cost.toFixed(2)}` : "—"} note="Speech, language and voice" />
        <Tile
          label="Moments handled"
          value={String(Math.round(handled))}
          note={`${moments.interrupted} interruptions · ${moments.guardrail} blocked claims · ${moments.reprompt} re-prompts`}
        />
      </div>
    </section>
  );
}

function Tile({ label, value, note, good }: { label: string; value: string; note: string; good?: boolean }) {
  return (
    <div className="tile">
      <span className="tile__label">{label}</span>
      <span className="tile__value">{value}</span>
      <span className="tile__note">
        {good && <CircleCheck size={16} className="tile__ok" aria-label="On target" />}
        {note}
      </span>
    </div>
  );
}

const CHART_H = 64;
const BAR_W = 14;
const GAP = 6;
/** Room for a typical call's turns, so bars spread across the tile instead of bunching left. */
const MIN_SLOTS = 18;

/**
 * Single-series column chart: one bar per agent reply, the latest in the
 * accent, earlier ones in the de-emphasis hue, and a dashed 1 s target line.
 * Hover or focus a bar for its exact value; a table view sits behind it for screen readers.
 */
function ReplyChart({ turns }: { turns: Turn[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (turns.length === 0) return <p className="chart__empty">Appears after the first reply.</p>;

  const max = Math.max(1500, ...turns.map((t) => t.replyMs));
  const y = (ms: number) => CHART_H - (ms / max) * CHART_H;
  const width = Math.max(MIN_SLOTS, turns.length) * (BAR_W + GAP);
  const shown = hover ?? turns.length - 1;

  return (
    <div className="chart">
      <svg className="chart__svg" viewBox={`0 0 ${width} ${CHART_H}`} height={CHART_H} aria-hidden="true" preserveAspectRatio="xMinYMax meet">
        <line className="chart__base" x1="0" x2={width} y1={CHART_H - 0.5} y2={CHART_H - 0.5} />
        <line className="chart__target" x1="0" x2={width} y1={y(TARGET_MS)} y2={y(TARGET_MS)} />
        <text className="chart__target-label" x={width} y={y(TARGET_MS) - 4} textAnchor="end">
          1 s
        </text>
        {turns.map((t, i) => {
          const h = Math.max(2, CHART_H - y(t.replyMs));
          const x = i * (BAR_W + GAP);
          // 4px rounded top, square at the baseline.
          const d = `M${x} ${CHART_H} V${CHART_H - h + 4} Q${x} ${CHART_H - h} ${x + 4} ${CHART_H - h} H${x + BAR_W - 4} Q${x + BAR_W} ${CHART_H - h} ${x + BAR_W} ${CHART_H - h + 4} V${CHART_H} Z`;
          return (
            <g key={i}>
              <path className={`chart__bar${i === shown ? " is-accent" : ""}`} d={d} />
              {/* Hit target taller and wider than the bar. */}
              <rect
                x={x - GAP / 2}
                y={0}
                width={BAR_W + GAP}
                height={CHART_H}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          );
        })}
      </svg>
      <span className="chart__readout mono">
        Turn {shown + 1}: {turns[shown]!.replyMs} ms
      </span>
      <table className="sr-only">
        <caption>Reply time per turn</caption>
        <tbody>
          {turns.map((t, i) => (
            <tr key={i}>
              <th scope="row">Turn {i + 1}</th>
              <td>{t.replyMs} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
