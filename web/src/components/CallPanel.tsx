import { CircleAlert, CircleDot, FlaskConical, Mic, Phone, PhoneCall, PhoneOff, Radio, UserRoundCheck } from "lucide-react";
import { useState } from "react";
import { SCENARIOS } from "../sources/demo/scenarios";
import type { Health } from "../sources/api";
import type { CallOptions, Language } from "../sources";
import { medianReplyMs, type CallView, type Phase } from "../state/callReducer";
import { useElapsed } from "../state/useElapsed";
import { Segmented } from "./Segmented";

const LANGUAGES: { value: Language; label: string }[] = [
  { value: "hi", label: "Hindi" },
  { value: "mr", label: "Marathi" },
  { value: "ta", label: "Tamil" },
  { value: "kn", label: "Kannada" },
  { value: "en", label: "English" },
];

// Matches the backend's check after stripping spaces, brackets and dashes.
const PHONE_RE = /^\+?[0-9]{10,15}$/;
const normalisePhone = (p: string) => p.replace(/[\s()-]/g, "");

interface Props {
  view: CallView;
  health: Health | null;
  options: CallOptions;
  onOptionsChange: (next: CallOptions) => void;
  onStart: () => void;
  onEnd: () => void;
  onHandoff: () => void;
}

function statusText(phase: Phase, phoneMode: boolean): string {
  switch (phase) {
    case "idle":
      return "Ready";
    case "connecting":
      return phoneMode ? "Dialling" : "Connecting";
    case "live":
      return "On call";
    case "ended":
      return "Call ended";
    case "error":
      return "Could not connect";
  }
}

function liveHint(health: Health | null): string | null {
  if (!health) return "Checking the backend.";
  if (!health.reachable) return "Backend is not running. Start it to make live calls.";
  if (!health.livekit) return `Backend is missing ${health.missing.join(", ")}.`;
  return null;
}

export function CallPanel({ view, health, options, onOptionsChange, onStart, onEnd, onHandoff }: Props) {
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const active = view.phase === "connecting" || view.phase === "live";
  const isLive = options.source === "live";
  const phoneMode = isLive && options.mode === "phone";
  const elapsed = useElapsed(view.startedAt, view.endedAt);
  const set = (patch: Partial<CallOptions>) => onOptionsChange({ ...options, ...patch });

  const median = medianReplyMs(view.turns);
  const last = view.turns.at(-1)?.replyMs;
  // Always explain why live is unavailable, even while Demo is selected.
  const hint = liveHint(health);

  const handleCall = () => {
    if (active) return onEnd();
    if (phoneMode && !PHONE_RE.test(normalisePhone(options.phone))) {
      setPhoneError("Enter a 10 to 15 digit number, with the country code.");
      return;
    }
    setPhoneError(null);
    onStart();
  };

  return (
    <section className="card call" aria-labelledby="call-h">
      <h6 id="call-h">Call</h6>

      <div className="status" data-state={view.phase} role="status">
        <span className="status__dot" />
        <span className="status__text">{statusText(view.phase, phoneMode)}</span>
        <span className="status__time mono">{elapsed}</span>
      </div>

      <div className="field">
        <span className="label">Source</span>
        <Segmented
          label="Call source"
          value={options.source}
          disabled={active}
          onChange={(source) => set({ source })}
          options={[
            { value: "live", label: "Live agent", icon: <Radio size={16} />, disabled: !health?.livekit },
            { value: "demo", label: "Demo", icon: <FlaskConical size={16} /> },
          ]}
        />
        {hint && <small>{hint}</small>}
      </div>

      {!isLive && (
        <div className="field">
          <label htmlFor="scenario">Scenario</label>
          <select id="scenario" value={options.scenarioId} disabled={active} onChange={(e) => set({ scenarioId: e.target.value })}>
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
          <small>{SCENARIOS.find((s) => s.id === options.scenarioId)?.description}</small>
        </div>
      )}

      <div className="field">
        <label htmlFor="language">Language</label>
        <select id="language" value={options.language} disabled={active} onChange={(e) => set({ language: e.target.value as Language })}>
          {LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      {isLive && (
        <div className="field">
          <span className="label">Connect through</span>
          <Segmented
            label="Connection type"
            value={options.mode}
            disabled={active}
            onChange={(mode) => set({ mode })}
            options={[
              { value: "browser", label: "Browser", icon: <Mic size={16} /> },
              { value: "phone", label: "Phone", icon: <Phone size={16} />, disabled: !health?.phone },
            ]}
          />
        </div>
      )}

      {phoneMode && (
        <div className="field">
          <label htmlFor="phone">Test number</label>
          <input
            id="phone"
            type="tel"
            inputMode="tel"
            placeholder="+91 98XXX XXXXX"
            autoComplete="off"
            value={options.phone}
            disabled={active}
            aria-invalid={!!phoneError}
            aria-describedby="phone-help"
            onChange={(e) => set({ phone: e.target.value })}
          />
          <small id="phone-help" className={phoneError ? "is-error" : undefined}>
            {phoneError ?? "Use a team member's number. Never a real customer's."}
          </small>
        </div>
      )}

      <button type="button" className="btn btn--primary btn--lg" data-live={active} onClick={handleCall}>
        {active ? <PhoneOff size={20} /> : <PhoneCall size={20} />}
        {active ? "End call" : "Start call"}
      </button>
      <button type="button" className="btn btn--ghost" disabled={view.phase !== "live" || !!view.handoff} onClick={onHandoff}>
        <UserRoundCheck size={20} />
        Hand off to a person
      </button>

      {view.phase === "error" && view.error && (
        <p className="alert" role="alert">
          <CircleAlert size={16} />
          {view.error}
        </p>
      )}

      <dl className="metrics">
        <div>
          <dt>Last reply</dt>
          <dd className="mono">{last !== undefined ? `${last} ms` : "—"}</dd>
        </div>
        <div>
          <dt>Median</dt>
          <dd className="mono">{median !== null ? `${median} ms` : "—"}</dd>
        </div>
        <div>
          <dt>Turns</dt>
          <dd className="mono">{view.turns.length}</dd>
        </div>
      </dl>
      <p className="hint">
        <CircleDot size={16} />
        Calls are recorded. The agent says so at the start.
      </p>
    </section>
  );
}
