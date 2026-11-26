import { AudioLines, CircleAlert, FlaskConical, Languages, MapPin, Mic, Phone } from "lucide-react";
import { AGENT } from "../domain/agent";
import { LANGUAGES, languageLabel } from "../domain/language";
import { OUTCOME_LABELS } from "../domain/lead";
import type { Health } from "../sources/api";
import { findScenario } from "../sources/demo/demoSource";
import { SCENARIOS, expectedOutcome } from "../sources/demo/scenarios";
import type { CallOptions, Language } from "../sources";
import { callerFor } from "../state/caller";
import { orbState, type CallView } from "../state/callReducer";
import { useElapsed } from "../state/useElapsed";
import { AgentOrb, orbLabel } from "./AgentOrb";
import { GroundRules } from "./GroundRules";
import { Segmented } from "./Segmented";


interface Props {
  view: CallView;
  health: Health | null;
  options: CallOptions;
  onOptionsChange: (next: CallOptions) => void;
  phoneError: string | null;
}

function sourceHint(health: Health | null, source: CallOptions["source"]): string | null {
  if (source === "scripted") return "Plays a pre-written call. No agent, no microphone, no keys.";
  if (!health) return "Checking the backend.";
  if (!health.reachable) return "Backend is not running. Start it to talk to the agent.";
  if (!health.livekit) return "This needs the LiveKit keys in .env. Check /api/health for which are missing.";
  if (source === "live" && !health.phone)
    return "Phone calls need SIP_OUTBOUND_TRUNK_ID and TEST_NUMBER_ALLOWLIST in .env. Check /api/health.";
  if (source === "demo")
    return "Talk to the cascaded agent (speech → text → language → voice). Use headphones so it does not hear itself.";
  if (source === "demo_v2")
    return "Speech-to-speech: Gemini hears you and speaks back in one hop. No Sarvam or Cartesia on this path. Use headphones.";
  return "The backend dials the test number below and this console listens in.";
}

function ExpectedOutcome({ scenarioId }: { scenarioId: string }) {
  const outcome = expectedOutcome(findScenario(scenarioId));
  if (!outcome) return null;
  return (
    <span className="expected" data-outcome={outcome}>
      Ends as <strong>{OUTCOME_LABELS[outcome]}</strong>
    </span>
  );
}

/** Pari, the caller and how the call is set up. During a call the setup gives way to the ground rules. */
export function AgentSidebar({ view, health, options, onOptionsChange, phoneError }: Props) {
  const active = view.phase === "connecting" || view.phase === "live";
  const scripted = options.source === "scripted";
  const phoneMode = options.source === "live";
  const s2s = options.source === "demo_v2";
  const elapsed = useElapsed(view.startedAt, view.endedAt);
  const orb = orbState(view);
  const caller = callerFor(options);
  const hint = sourceHint(health, options.source);
  const set = (patch: Partial<CallOptions>) => onOptionsChange({ ...options, ...patch });

  return (
    <aside className="sidebar" aria-label="Agent and call setup">
      <div className="sidebar__brand">
        <img src="/assets/logo.webp" alt="SolarSquare" height={24} />
        <span className="sidebar__product">Voice agent</span>
      </div>

      <section className="presence" aria-labelledby="agent-h">
        <AgentOrb state={orb} />
        <h2 id="agent-h" className="presence__name">
          {AGENT.name}
        </h2>
        <p className="presence__role">{AGENT.role}</p>
        <div className="status" data-state={view.phase} role="status">
          <span className="status__dot" />
          <span>{orbLabel(orb)}</span>
          <span className="status__sep" aria-hidden="true">·</span>
          <span className="mono">{elapsed}</span>
        </div>
      </section>

      <section className="side-section" aria-labelledby="caller-h">
        <h3 id="caller-h" className="side-title">Caller</h3>
        <div className="caller">
          <span className="caller__avatar" aria-hidden="true">
            {caller.name.replace(/^(Mr\.|Ms\.|Mrs\.)\s*/, "").charAt(0)}
          </span>
          <div className="caller__body">
            <span className="caller__name">{caller.name}</span>
            <span className="caller__meta">{caller.phone}</span>
          </div>
          <span className="caller__place">
            <MapPin size={14} />
            {caller.city}
          </span>
        </div>
      </section>

      {view.phase === "error" && view.error && (
        <p className="alert" role="alert">
          <CircleAlert size={16} />
          {view.error}
        </p>
      )}

      {/* Stays up after the call so the final state of each rule can be read. */}
      {view.phase !== "idle" && <GroundRules view={view} />}

      <section className="side-section setup" aria-labelledby="setup-h">
        <h3 id="setup-h" className="side-title">Call setup</h3>
        {active ? (
          <p className="setup__summary">
            {scripted
              ? `Scripted · ${findScenario(options.scenarioId).title}`
              : phoneMode
                ? "Live · Phone call"
                : s2s
                  ? "Demo v2 · Speech to speech"
                  : "Demo · Cascaded"} ·{" "}
            {languageLabel(options.language)}
          </p>
        ) : (
          <>
            <div className="field">
              <span className="label">Source</span>
              <Segmented
                label="Call source"
                value={options.source}
                onChange={(source) => set({ source })}
                options={[
                  { value: "demo", label: "Demo", icon: <Mic size={16} />, disabled: !health?.livekit },
                  { value: "demo_v2", label: "Demo v2", icon: <AudioLines size={16} />, disabled: !health?.livekit },
                  { value: "live", label: "Live", icon: <Phone size={16} />, disabled: !health?.phone },
                  { value: "scripted", label: "Scripted", icon: <FlaskConical size={16} /> },
                ]}
              />
              {hint && <small>{hint}</small>}
            </div>

            {scripted && (
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
                <ExpectedOutcome scenarioId={options.scenarioId} />
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
      </section>

      <div className="note">
        <Languages size={16} />
        <p className="note__title">Speaks the caller's language</p>
        <p className="note__body">
          Hindi, Marathi, Tamil, Kannada and English. {AGENT.name} never promises prices, savings or subsidy amounts.
        </p>
      </div>
    </aside>
  );
}
