import { FlaskConical, Mic, PhoneCall } from "lucide-react";
import type { SourceKind } from "../sources";

export function TopBar({ source }: { source: SourceKind }) {
  return (
    <header className="topbar">
      <div className="topbar__brand">
        <img src="/assets/logo.webp" alt="SolarSquare" height={28} />
        <span className="topbar__divider" />
        <span className="topbar__title">Voice agent console</span>
      </div>
      <span className="chip" data-source={source}>
        {source === "live" ? <PhoneCall size={16} /> : source === "demo" ? <Mic size={16} /> : <FlaskConical size={16} />}
        {source === "live" ? "Live call" : source === "demo" ? "Demo · talk to the agent" : "Scripted playback"}
      </span>
    </header>
  );
}
