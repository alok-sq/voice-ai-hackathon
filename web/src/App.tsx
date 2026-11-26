import { useEffect, useRef, useState } from "react";
import { AgentSidebar } from "./components/AgentSidebar";
import { CallActions } from "./components/CallActions";
import { CallProgress } from "./components/CallProgress";
import { Conversation } from "./components/Conversation";
import { HistoryView } from "./components/HistoryView";
import { IntroDialog } from "./components/IntroDialog";
import { LeadCard } from "./components/LeadCard";
import { PerformanceBand } from "./components/PerformanceBand";
import { SessionView } from "./components/SessionView";
import { SummaryCard } from "./components/SummaryCard";
import { TopBar } from "./components/TopBar";
import { findScenario } from "./sources/demo/demoSource";
import { DEFAULT_SCENARIO_ID } from "./sources/demo/scenarios";
import type { CallOptions } from "./sources";
import { callerFor } from "./state/caller";
import { unlockAudio } from "./state/sound";
import { useCall } from "./state/useCall";
import { useHealth } from "./state/useHealth";
import { useSessions } from "./state/useSessions";
import { useSoundPreference, useStepSounds } from "./state/useStepSounds";

type Route = { name: "call" } | { name: "history" } | { name: "session"; id: string };

export function App() {
  const { view, start, end, requestHandoff } = useCall();
  const active = view.phase === "connecting" || view.phase === "live";
  const health = useHealth(active);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  // Shown on every visit, as the first thing anyone sees.
  const [introOpen, setIntroOpen] = useState(true);
  const [route, setRoute] = useState<Route>({ name: "call" });
  const [soundOn, setSoundOn] = useSoundPreference();
  useStepSounds(view, soundOn);

  const [options, setOptions] = useState<CallOptions>({
    source: "scripted",
    language: "hi",
    phone: "",
    scenarioId: DEFAULT_SCENARIO_ID,
  });

  // Prefer Demo (talk to the real agent) the first time the backend reports it is ready; after that the choice is yours.
  const autoSelected = useRef(false);
  useEffect(() => {
    if (autoSelected.current || !health) return;
    autoSelected.current = true;
    if (health.livekit) setOptions((o) => ({ ...o, source: "demo" }));
  }, [health]);

  const caller = callerFor(options);
  const { sessions, clear } = useSessions(view, {
    source: options.source,
    language: options.language,
    scenarioTitle: options.source === "scripted" ? findScenario(options.scenarioId).title : null,
    caller,
  });
  const finished = view.phase === "ended" || view.phase === "error";
  const currentSummary = finished ? sessions.find((s) => s.id === String(view.startedAt)) : undefined;
  const openSession = route.name === "session" ? sessions.find((s) => s.id === route.id) : undefined;

  // Each view starts at the top.
  const routeKey = route.name === "session" ? `session:${route.id}` : route.name;
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [routeKey]);

  const startCall = (opts: CallOptions) => {
    unlockAudio();
    setRoute({ name: "call" });
    void start(opts);
  };
  const closeIntro = () => {
    unlockAudio();
    setIntroOpen(false);
  };
  // "Watch a demo call" always plays the scripted happy path: no keys, no mic, works offline.
  const watchDemo = () => {
    const demo: CallOptions = { ...options, source: "scripted", scenarioId: DEFAULT_SCENARIO_ID };
    setOptions(demo);
    setIntroOpen(false);
    startCall(demo);
  };

  return (
    <div className="shell" data-route={route.name}>
      <AgentSidebar view={view} health={health} options={options} onOptionsChange={setOptions} phoneError={phoneError} />
      <div className="main">
        <TopBar
          source={options.source}
          tab={route.name === "call" ? "call" : "history"}
          historyCount={sessions.length}
          onTab={(tab) => setRoute(tab === "call" ? { name: "call" } : { name: "history" })}
          soundOn={soundOn}
          onToggleSound={() => setSoundOn(!soundOn)}
          onAbout={() => setIntroOpen(true)}
        >
          <CallActions
            view={view}
            options={options}
            onStart={() => startCall(options)}
            onEnd={() => end()}
            onHandoff={() => void requestHandoff()}
            onPhoneError={setPhoneError}
          />
        </TopBar>
        <main className="work" key={routeKey}>
          {route.name === "call" && (
            <>
              {currentSummary && <SummaryCard session={currentSummary} />}
              <CallProgress view={view} />
              <Conversation view={view} callerName={caller.name} />
              <LeadCard view={view} />
              <PerformanceBand view={view} />
            </>
          )}
          {(route.name === "history" || (route.name === "session" && !openSession)) && (
            <HistoryView sessions={sessions} onOpen={(id) => setRoute({ name: "session", id })} onClear={clear} onWatchDemo={watchDemo} />
          )}
          {openSession && <SessionView session={openSession} onBack={() => setRoute({ name: "history" })} />}
        </main>
      </div>
      <IntroDialog open={introOpen} callActive={active} soundOn={soundOn} onClose={closeIntro} onWatchDemo={watchDemo} />
    </div>
  );
}
