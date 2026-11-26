import type { OrbState } from "../state/callReducer";

const LABELS: Record<OrbState, string> = {
  idle: "Ready",
  connecting: "Connecting",
  listening: "Listening",
  agent: "Speaking",
  caller: "Caller speaking",
  ended: "Call ended",
};

/**
 * Pari's presence: a small sun. It breathes at rest, its rays turn while she
 * speaks, and blue ripples spread while the caller speaks. All motion is CSS,
 * keyed off `data-state`, and switches off under prefers-reduced-motion.
 */
export function AgentOrb({ state, size = "lg" }: { state: OrbState; size?: "lg" | "sm" }) {
  return (
    <div className={`orb orb--${size}`} data-state={state} role="img" aria-label={`Pari: ${LABELS[state]}`}>
      {size === "lg" && (
        <>
          <span className="orb__ripple" />
          <span className="orb__ripple orb__ripple--2" />
          <span className="orb__rays" />
        </>
      )}
      <span className="orb__core" />
    </div>
  );
}

export const orbLabel = (state: OrbState) => LABELS[state];
