import { useEffect, useRef, useState } from "react";
import { AgentSidebar } from "./components/AgentSidebar";
import { CallActions } from "./components/CallActions";
import { CallProgress } from "./components/CallProgress";
import { Conversation } from "./components/Conversation";
import { LeadCard } from "./components/LeadCard";
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
  const [phoneError, setPhoneError] = useState<string | null>(null);

  const [options, setOptions] = useState<CallOptions>({
    source: "demo",
    mode: "browser",
    language: "hi",
    phone: "",
    scenarioId: DEFAULT_SCENARIO_ID,
  });

  // Prefer live the first time the backend reports it is ready; after that the choice is yours.
  const autoSelected = useRef(false);
  useEffect(() => {
    if (autoSelected.current || !health) return;
    autoSelected.current = true;
    if (health.livekit) setOptions((o) => ({ ...o, source: "live" }));
  }, [health]);

  const callerName = options.source === "demo" ? findScenario(options.scenarioId).caller.name : "Caller";

  return (
    <div className="shell">
      <AgentSidebar view={view} health={health} options={options} onOptionsChange={setOptions} phoneError={phoneError} />
      <div className="main">
        <TopBar source={options.source}>
          <CallActions
            view={view}
            options={options}
            onStart={() => void start(options)}
            onEnd={() => end()}
            onHandoff={() => void requestHandoff()}
            onPhoneError={setPhoneError}
          />
        </TopBar>
        <main className="work">
          <CallProgress view={view} />
          <Conversation view={view} callerName={callerName} />
          <LeadCard view={view} />
          <PerformanceBand view={view} />
        </main>
      </div>
    </div>
  );
}
