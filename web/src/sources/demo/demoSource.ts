import type { CallEvent } from "../../contract/events";
import type { CallSource, StartContext } from "../types";
import { SCENARIOS, type Scenario } from "./scenarios";

export const findScenario = (id: string): Scenario => SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0]!;

/**
 * Plays a scripted scenario through the same event pipeline as a live call.
 * Like a live room's speaker detection, it marks who holds the floor before
 * each spoken line, so the agent orb animates in demos too.
 */
export function createDemoSource(scenarioId: string): CallSource {
  const scenario = findScenario(scenarioId);
  const timers: ReturnType<typeof setTimeout>[] = [];
  let emit: StartContext["emit"] = () => {};

  const stop = () => {
    timers.forEach(clearTimeout);
    timers.length = 0;
    emit = () => {};
  };

  const play = (e: CallEvent) => {
    if (e.type === "transcript" && e.final) emit({ type: "speaking", who: e.role });
    emit(e);
  };

  return {
    async start(ctx) {
      emit = ctx.emit;
      ctx.signal.addEventListener("abort", stop, { once: true });
      let t = 0;
      for (const [delay, events] of scenario.script) {
        t += delay;
        timers.push(setTimeout(() => events.forEach(play), t));
      }
    },
    stop,
    async requestHandoff(reason) {
      emit({ type: "handoff", reason });
      emit({ type: "call_ended", reason: "Transferred to a team member" });
    },
  };
}
