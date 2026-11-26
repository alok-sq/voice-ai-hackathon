import { useEffect, useRef, useState } from "react";
import { CallStage } from "./components/CallStage";
import { Conversation } from "./components/Conversation";
import { LeadCard } from "./components/LeadCard";
import { PageHeader } from "./components/PageHeader";
import { PerformanceBand } from "./components/PerformanceBand";
import { TopBar } from "./components/TopBar";
import { findScenario } from "./sources/demo/demoSource";
import { DEFAULT_SCENARIO_ID } from "./sources/demo/scenarios";
import type { CallOptions } from "./sources";
import { useCall } from "./state/useCall";
import { useHealth } from "./state/useHealth";

export function App() {
  const { view, start, end, requestHandoff } = useCall();
  const active = view.phase === "connecting" || view.phase === "live";
  const health = useHealth(active);

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

  const callerName = options.source === "scripted" ? findScenario(options.scenarioId).caller.name : "Caller";

  return (
    <div className="page">
      <div className="sunrise" aria-hidden="true" />
      <TopBar source={options.source} />
      <PageHeader />
      <main className="layout">
        <CallStage
          view={view}
          health={health}
          options={options}
          onOptionsChange={setOptions}
          onStart={() => void start(options)}
          onEnd={() => end()}
          onHandoff={() => void requestHandoff()}
        />
        <Conversation view={view} callerName={callerName} />
        <LeadCard view={view} />
        <PerformanceBand view={view} />
      </main>
      <footer className="footer">
        <span>SolarSquare Voice AI Hackathon · Lead qualification</span>
        <span>Calls are recorded. Pari never promises prices, savings or subsidy amounts.</span>
      </footer>
    </div>
  );
}
