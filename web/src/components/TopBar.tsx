import { FlaskConical, Info, Radio, Volume2, VolumeX } from "lucide-react";
import type { ReactNode } from "react";
import type { SourceKind } from "../sources";

export type Tab = "call" | "history";

interface Props {
  source: SourceKind;
  tab: Tab;
  historyCount: number;
  onTab: (tab: Tab) => void;
  soundOn: boolean;
  onToggleSound: () => void;
  onAbout: () => void;
  children: ReactNode;
}

/** Page title on the left, the call's actions on the right. Sticky, so Start/End is always in reach. */
export function TopBar({ source, tab, historyCount, onTab, soundOn, onToggleSound, onAbout, children }: Props) {
  const live = source === "live";
  return (
    <header className="topbar">
      <div className="topbar__title">
        <img className="topbar__logo" src="/assets/logo.webp" alt="SolarSquare" height={22} />
        <h1 className="topbar__h1">Lead qualification</h1>
        <span className="chip" data-source={source}>
          {live ? <Radio size={14} /> : <FlaskConical size={14} />}
          {live ? "Live agent" : "Demo mode"}
        </span>
      </div>
      <nav className="tabs" aria-label="Views">
        <button type="button" className="tab" aria-current={tab === "call" ? "page" : undefined} onClick={() => onTab("call")}>
          Call
        </button>
        <button type="button" className="tab" aria-current={tab === "history" ? "page" : undefined} onClick={() => onTab("history")}>
          History
          {historyCount > 0 && <span className="tab__count">{historyCount}</span>}
        </button>
      </nav>
      <div className="topbar__end">
        <div className="tools">
          <button type="button" className="icon-btn" onClick={onAbout} aria-label="About Pari" title="About Pari">
            <Info size={18} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={onToggleSound}
            aria-pressed={soundOn}
            aria-label="Progress sounds"
            title={soundOn ? "Sound on" : "Sound off"}
          >
            {soundOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </button>
        </div>
        {children}
      </div>
    </header>
  );
}
