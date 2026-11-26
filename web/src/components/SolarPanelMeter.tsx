import { useEffect, useRef, useState } from "react";
import type { Lead } from "../contract/events";
import { LEAD_FIELD_COUNT, LEAD_GROUPS, capturedCount, newlyFull, panelCells, type CellState } from "../domain/lead";

/** How long one twinkle lives. Matches the CSS animation; also clears it under reduced motion. */
const TWINKLE_MS = 1400;
/** Cell centres over the tilted 3 × 2 face, as % of the face box (the top row sits higher under perspective). */
const CELL_POS = [
  { x: 19, y: 30 }, { x: 50, y: 30 }, { x: 81, y: 30 },
  { x: 17, y: 74 }, { x: 50, y: 74 }, { x: 83, y: 74 },
];

interface Sparkle {
  id: number;
  x: number;
  y: number;
  big: boolean;
}

/**
 * Lead capture as a solar panel that charges: one cell per field group,
 * lit when the group is captured, half-lit when partly captured.
 * Each cell twinkles once as it lights; the whole panel gets a bigger
 * twinkle and a slow sheen once every field is in.
 */
export function SolarPanelMeter({ lead }: { lead: Lead }) {
  const cells = panelCells(lead);
  const captured = capturedCount(lead);
  const full = captured === LEAD_FIELD_COUNT;
  const sparkles = useTwinkles(cells, full);

  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={LEAD_FIELD_COUNT} aria-valuenow={captured} aria-label="Lead fields captured">
      <div className="panel" data-full={full} aria-hidden="true">
        <div className="panel__face">
          {cells.map((state, i) => (
            <span key={LEAD_GROUPS[i]!.title} className={`panel__cell is-${state}`} title={`${LEAD_GROUPS[i]!.title}: ${cellText(state)}`} />
          ))}
        </div>
        <span className="panel__stand" />
        <span className="panel__sparkles">
          {sparkles.map((s) => (
            <span key={s.id} className={`twinkle${s.big ? " twinkle--big" : ""}`} style={{ left: `${s.x}%`, top: `${s.y}%` }}>
              <Star className="twinkle__star" />
              <Star className="twinkle__mini twinkle__mini--a" />
              <Star className="twinkle__mini twinkle__mini--b" />
            </span>
          ))}
        </span>
      </div>
      <span className="meter__value">
        {captured}
        <span className="meter__total">/{LEAD_FIELD_COUNT}</span>
      </span>
    </div>
  );
}

const cellText = (s: CellState) => (s === "full" ? "captured" : s === "partial" ? "partly captured" : "not captured");

/** A four-point star: long vertical and horizontal points with soft concave sides. */
function Star({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24">
      <path d="M12 0 C13 8 16 11 24 12 C16 13 13 16 12 24 C11 16 8 13 0 12 C8 11 11 8 12 0 Z" />
    </svg>
  );
}

/** Emits one short-lived sparkle per cell that just lit, plus a big one when the panel fills. Silent on first render. */
function useTwinkles(cells: CellState[], full: boolean): Sparkle[] {
  const [sparkles, setSparkles] = useState<Sparkle[]>([]);
  const prev = useRef<{ cells: CellState[]; full: boolean } | null>(null);
  const nextId = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const key = cells.join(",");

  useEffect(() => {
    const before = prev.current;
    prev.current = { cells, full };
    if (!before) return;
    const born: Sparkle[] = newlyFull(before.cells, cells).map((i) => ({ id: nextId.current++, ...CELL_POS[i]!, big: false }));
    if (full && !before.full) born.push({ id: nextId.current++, x: 50, y: 50, big: true });
    if (born.length === 0) return;
    setSparkles((s) => [...s, ...born]);
    const ids = new Set(born.map((b) => b.id));
    timers.current.push(setTimeout(() => setSparkles((s) => s.filter((x) => !ids.has(x.id))), TWINKLE_MS));
    // `key` stands in for `cells`, so a new array with the same states does not re-run this.
  }, [key, full]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return sparkles;
}
