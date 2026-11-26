import { AudioLines, FlaskConical, Mic, PhoneCall } from "lucide-react";
import type { ReactNode } from "react";
import type { SourceKind } from "../sources";

const CHIP: Record<SourceKind, { icon: ReactNode; label: string }> = {
  demo: { icon: <Mic size={16} />, label: "Demo · cascaded" },
  demo_v2: { icon: <AudioLines size={16} />, label: "Demo v2 · speech to speech" },
  live: { icon: <PhoneCall size={16} />, label: "Live call" },
  scripted: { icon: <FlaskConical size={16} />, label: "Scripted playback" },
};

export function TopBar({ source }: { source: SourceKind }) {
  const chip = CHIP[source];
  return (
    <header className="topbar">
      <div className="topbar__brand">
        <img src="/assets/logo.webp" alt="SolarSquare" height={28} />
        <span className="topbar__divider" />
        <span className="topbar__title">Voice agent console</span>
      </div>
      <span className="chip" data-source={source}>
        {chip.icon}
        {chip.label}
      </span>
    </header>
  );
}
