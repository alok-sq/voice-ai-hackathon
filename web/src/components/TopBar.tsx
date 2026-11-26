import { FlaskConical, Radio } from "lucide-react";
import type { SourceKind } from "../sources";

export function TopBar({ source }: { source: SourceKind }) {
  const live = source === "live";
  return (
    <header className="topbar">
      <div className="topbar__brand">
        <img src="/assets/logo.webp" alt="SolarSquare" height={28} />
        <span className="topbar__divider" />
        <span className="topbar__title">Voice agent console</span>
      </div>
      <span className="chip" data-source={source}>
        {live ? <Radio size={16} /> : <FlaskConical size={16} />}
        {live ? "Live agent" : "Demo mode"}
      </span>
    </header>
  );
}
