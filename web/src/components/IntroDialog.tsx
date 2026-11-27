import { ArrowRight, Gauge, Play, ShieldCheck, SunMedium, Volume2 } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { AGENT } from "../domain/agent";
import { AgentOrb } from "./AgentOrb";

const LANGUAGES = ["Hindi", "Marathi", "Tamil", "Kannada", "English"];

const WATCH: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <SunMedium size={18} />,
    title: "The lead fills in",
    body: `Each step lights up as ${AGENT.name} asks it, and the solar panel charges as answers come in. You hear a chime when a step passes.`,
  },
  {
    icon: <ShieldCheck size={18} />,
    title: "Hard moments, handled",
    body: "Interruptions, silence and price questions he won't answer are flagged in the conversation as they happen.",
  },
  {
    icon: <Gauge size={18} />,
    title: "Speed and cost",
    body: "Reply time for every turn against a 1 second target, and what the call cost in rupees.",
  },
];

interface Props {
  open: boolean;
  /** True while a call is running: the main action returns to it instead of starting a new one. */
  callActive: boolean;
  soundOn: boolean;
  onClose: () => void;
  onWatchDemo: () => void;
}

/**
 * First thing anyone sees: who Ajay is, what to watch, and one click to a call.
 * A native modal <dialog>, so focus, Escape and the inert page behind come from the browser.
 */
export function IntroDialog({ open, callActive, soundOn, onClose, onWatchDemo }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="intro"
      aria-labelledby="intro-h"
      aria-describedby="intro-lede"
      onClose={onClose}
      // A click on the backdrop lands on the <dialog> itself; clicks inside land on its content.
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="intro__inner">
        <div className="intro__glow" aria-hidden="true" />
        <div className="intro__hero">
          <AgentOrb state="idle" />
          <p className="intro__eyebrow">SolarSquare voice agent</p>
          <h2 id="intro-h" className="intro__title">
            Meet <em>{AGENT.name}</em>
          </h2>
          <p id="intro-lede" className="intro__lede">
            {AGENT.intro}
          </p>
        </div>

        <section className="intro__watch" aria-labelledby="watch-h">
          <h3 id="watch-h" className="intro__label">
            What to watch
          </h3>
          <ol className="intro__list">
            {WATCH.map((w) => (
              <li key={w.title} className="intro__item">
                <span className="intro__icon" aria-hidden="true">
                  {w.icon}
                </span>
                <span className="intro__text">
                  <span className="intro__item-title">{w.title}</span>
                  <span className="intro__item-body">{w.body}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        <ul className="intro__langs" aria-label={`Languages ${AGENT.name} speaks`}>
          {LANGUAGES.map((l) => (
            <li key={l} className="intro__lang">
              {l}
            </li>
          ))}
        </ul>

        <div className="intro__actions">
          {callActive ? (
            <button type="button" className="btn btn--primary btn--lg" autoFocus onClick={onClose}>
              Back to the call
              <ArrowRight size={16} />
            </button>
          ) : (
            <>
              <button type="button" className="btn btn--primary btn--lg" autoFocus onClick={onWatchDemo}>
                <Play size={16} />
                Watch a demo call
              </button>
              <button type="button" className="btn btn--ghost btn--lg" onClick={onClose}>
                Explore the console
              </button>
            </>
          )}
        </div>
        <p className="intro__foot">
          <Volume2 size={14} />
          {soundOn ? "Sound is on. Turn it off from the top bar." : "Sound is off. Turn it on from the top bar."}
        </p>
      </div>
    </dialog>
  );
}
