import type { Lead } from "../contract/events";
import { LEAD_FIELD_COUNT, LEAD_GROUPS } from "../domain/lead";

type CellState = "empty" | "partial" | "full";

/**
 * Lead capture as a solar panel that charges: one cell per field group,
 * lit when the group is captured, half-lit when partly captured.
 * A sheen crosses the panel once every field is in.
 */
export function SolarPanelMeter({ lead }: { lead: Lead }) {
  const cells = LEAD_GROUPS.map((g) => {
    const n = g.fields.filter(({ field }) => lead[field] !== undefined).length;
    const state: CellState = n === 0 ? "empty" : n === g.fields.length ? "full" : "partial";
    return { title: g.title, state };
  });
  const captured = LEAD_GROUPS.flatMap((g) => g.fields).filter(({ field }) => lead[field] !== undefined).length;
  const full = captured === LEAD_FIELD_COUNT;

  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={LEAD_FIELD_COUNT} aria-valuenow={captured} aria-label="Lead fields captured">
      <div className="panel" data-full={full} aria-hidden="true">
        <div className="panel__face">
          {cells.map((c) => (
            <span key={c.title} className={`panel__cell is-${c.state}`} title={`${c.title}: ${c.state === "full" ? "captured" : c.state === "partial" ? "partly captured" : "not captured"}`} />
          ))}
        </div>
        <span className="panel__stand" />
      </div>
      <span className="meter__value">
        {captured}
        <span className="meter__total">/{LEAD_FIELD_COUNT}</span>
      </span>
    </div>
  );
}
