import { useEffect, useRef, useState } from "react";
import { CallPanel } from "./components/CallPanel";
import { LeadPanel } from "./components/LeadPanel";
import { TopBar } from "./components/TopBar";
import { TranscriptPanel } from "./components/TranscriptPanel";
import { DEFAULT_SCENARIO_ID } from "./sources/demo/scenarios";
import type { CallOptions } from "./sources";
import { useCall } from "./state/useCall";
import { useHealth } from "./state/useHealth";

export function App() {
  const { view, start, end, requestHandoff } = useCall();
  const active = view.phase === "connecting" || view.phase === "live";
  const health = useHealth(active);

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

  return (
    <>
      <TopBar source={options.source} />
      <main className="layout">
        <CallPanel
          view={view}
          health={health}
          options={options}
          onOptionsChange={setOptions}
          onStart={() => void start(options)}
          onEnd={() => end()}
          onHandoff={() => void requestHandoff()}
        />
        <TranscriptPanel view={view} />
        <LeadPanel view={view} />
      </main>
    </>
  );
}
