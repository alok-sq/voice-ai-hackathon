import { CircleAlert, FlaskConical, MapPin, Mic, Phone, PhoneCall, PhoneOff, Radio, UserRoundCheck } from "lucide-react";
import { useState } from "react";
import { AGENT, type CallerProfile } from "../domain/agent";
import { findScenario } from "../sources/demo/demoSource";
import { SCENARIOS } from "../sources/demo/scenarios";
import type { Health } from "../sources/api";
import type { CallOptions, Language } from "../sources";
import { orbState, type CallView } from "../state/callReducer";
import { useElapsed } from "../state/useElapsed";
import { AgentOrb, orbLabel } from "./AgentOrb";
import { GroundRules } from "./GroundRules";
import { Segmented } from "./Segmented";

const LANGUAGES: { value: Language; label: string }[] = [
  { value: "hi", label: "Hindi" },
  { value: "mr", label: "Marathi" },
  { value: "ta", label: "Tamil" },
  { value: "kn", label: "Kannada" },
  { value: "en", label: "English" },
];
const languageLabel = (l: Language) => LANGUAGES.find((x) => x.value === l)?.label ?? l;

// Matches the backend's check after stripping spaces, brackets and dashes.
const PHONE_RE = /^\+?[0-9]{10,15}$/;
const normalisePhone = (p: string) => p.replace(/[\s()-]/g, "");
const maskPhone = (p: string) => {
  const d = normalisePhone(p);
  return d.length < 6 ? p : `${d.slice(0, 5)}•••${d.slice(-3)}`;
};

interface Props {
  view: CallView;
  health: Health | null;
  options: CallOptions;
  onOptionsChange: (next: CallOptions) => void;
  onStart: () => void;
  onEnd: () => void;
  onHandoff: () => void;
}

function liveHint(health: Health | null): string | null {
  if (!health) return "Checking the backend.";
  if (!health.reachable) return "Backend is not running. Start it to make live calls.";
  if (!health.livekit) return "Live calls need the LiveKit keys in .env. Check /api/health for which are missing.";
  return null;
}

function callerFor(options: CallOptions): CallerProfile {
  if (options.source === "demo") return findScenario(options.scenarioId).caller;
  if (options.mode === "phone")
    return { name: "Test caller", phone: options.phone ? maskPhone(options.phone) : "Number not set", city: "Phone line", source: "Team test number" };
  return { name: "You", phone: "Browser microphone", city: "This device", source: "Live test" };
}

export function CallStage({ view, health, options, onOptionsChange, onStart, onEnd, onHandoff }: Props) {
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const active = view.phase === "connecting" || view.phase === "live";
  const isLive = options.source === "live";
  const phoneMode = isLive && options.mode === "phone";
  const elapsed = useElapsed(view.startedAt, view.endedAt);
  const orb = orbState(view);
  const caller = callerFor(options);
  const hint = liveHint(health);
  const set = (patch: Partial<CallOptions>) => onOptionsChange({ ...options, ...patch });

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
    <section className="card stage" aria-labelledby="stage-h">
      <div className="stage__presence">
        <AgentOrb state={orb} />
        <h2 id="stage-h" className="stage__name">
          {AGENT.name}
        </h2>
        <p className="stage__role">{AGENT.role}</p>
        <div className="stage__status" data-state={view.phase} role="status">
          <span className="stage__dot" />
          <span>{orbLabel(orb)}</span>
          <span className="stage__sep" aria-hidden="true">·</span>
          <span className="mono">{elapsed}</span>
        </div>
      </div>

      <div className="caller" aria-label="Caller">
        <span className="caller__avatar" aria-hidden="true">
          {caller.name.replace(/^(Mr\.|Ms\.|Mrs\.)\s*/, "").charAt(0)}
        </span>
        <div className="caller__body">
          <span className="caller__name">{caller.name}</span>
          <span className="caller__meta">{caller.phone}</span>
        </div>
        <span className="caller__place">
          <MapPin size={16} />
          {caller.city}
        </span>
      </div>

      <div className="stage__actions">
        <button type="button" className="btn btn--primary btn--xl" data-live={active} onClick={handleCall}>
          {active ? <PhoneOff size={20} /> : <PhoneCall size={20} />}
          {active ? "End call" : "Start call"}
        </button>
        <button type="button" className="btn btn--ghost" disabled={view.phase !== "live" || !!view.handoff} onClick={onHandoff}>
          <UserRoundCheck size={20} />
          Hand off to a person
        </button>
      </div>

      {view.phase === "error" && view.error && (
        <p className="alert" role="alert">
          <CircleAlert size={16} />
          {view.error}
        </p>
      )}

      <div className="setup">
        <h6 className="setup__title">Call setup</h6>
        {active ? (
          <>
            <p className="setup__summary">
              {isLive ? (phoneMode ? "Live · Phone" : "Live · Browser") : `Demo · ${findScenario(options.scenarioId).title}`} ·{" "}
              {languageLabel(options.language)}
            </p>
            <GroundRules view={view} />
          </>
        ) : (
          <>
            <div className="field">
              <span className="label">Source</span>
              <Segmented
                label="Call source"
                value={options.source}
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
                <select id="scenario" value={options.scenarioId} onChange={(e) => set({ scenarioId: e.target.value })}>
                  {SCENARIOS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
                </select>
                <small>{findScenario(options.scenarioId).description}</small>
              </div>
            )}

            <div className="field">
              <label htmlFor="language">Language</label>
              <select id="language" value={options.language} onChange={(e) => set({ language: e.target.value as Language })}>
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
                  aria-invalid={!!phoneError}
                  aria-describedby="phone-help"
                  onChange={(e) => set({ phone: e.target.value })}
                />
                <small id="phone-help" className={phoneError ? "is-error" : undefined}>
                  {phoneError ?? "Use a team member's number. Never a real customer's."}
                </small>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
