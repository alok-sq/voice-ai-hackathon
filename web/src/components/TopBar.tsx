import { FlaskConical, Radio } from "lucide-react";
import type { ReactNode } from "react";
import type { SourceKind } from "../sources";

/** Page title on the left, the call's actions on the right. Sticky, so Start/End is always in reach. */
export function TopBar({ source, children }: { source: SourceKind; children: ReactNode }) {
  const live = source === "live";
  return (
    <header className="topbar">
      <div className="topbar__title">
        <img className="topbar__logo" src="/assets/logo.webp" alt="SolarSquare" height={22} />
        <h1 className="topbar__h1">Lead qualification call</h1>
        <span className="chip" data-source={source}>
          {live ? <Radio size={14} /> : <FlaskConical size={14} />}
          {live ? "Live agent" : "Demo mode"}
        </span>
      </div>
      {children}
    </header>
  );
}
