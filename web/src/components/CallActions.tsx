import { PhoneCall, PhoneOff, UserRoundCheck } from "lucide-react";
import { PHONE_ERROR, isValidPhone } from "../domain/phone";
import type { CallOptions } from "../sources";
import type { CallView } from "../state/callReducer";

interface Props {
  view: CallView;
  options: CallOptions;
  onStart: () => void;
  onEnd: () => void;
  onHandoff: () => void;
  /** The phone field lives in the sidebar, so its error is reported up rather than shown here. */
  onPhoneError: (message: string | null) => void;
}

/** The call's primary actions, kept in the top bar so they stay in reach on every screen size. */
export function CallActions({ view, options, onStart, onEnd, onHandoff, onPhoneError }: Props) {
  const active = view.phase === "connecting" || view.phase === "live";
  const phoneMode = options.source === "live";

  const handleCall = () => {
    if (active) return onEnd();
    if (phoneMode && !isValidPhone(options.phone)) return onPhoneError(PHONE_ERROR);
    onPhoneError(null);
    onStart();
  };

  return (
    <div className="actions">
      <button type="button" className="btn btn--ghost" aria-label="Hand off to a person" disabled={view.phase !== "live" || !!view.handoff} onClick={onHandoff}>
        <UserRoundCheck size={16} />
        <span className="actions__label">Hand off</span>
      </button>
      <button type="button" className="btn btn--primary" data-live={active} onClick={handleCall}>
        {active ? <PhoneOff size={16} /> : <PhoneCall size={16} />}
        {active ? "End call" : "Start call"}
      </button>
    </div>
  );
}
