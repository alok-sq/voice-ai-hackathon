import type { CallSource, StartContext } from "../types";
import { SCENARIOS, type Scenario } from "./scenarios";

/** Plays a scripted scenario through the same event pipeline as a live call. */
export function createDemoSource(scenarioId: string): CallSource {
  const scenario: Scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0]!;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let emit: StartContext["emit"] = () => {};

  const stop = () => {
    timers.forEach(clearTimeout);
    timers.length = 0;
    emit = () => {};
  };

  return {
    async start(ctx) {
      emit = ctx.emit;
      ctx.signal.addEventListener("abort", stop, { once: true });
      let t = 0;
      for (const [delay, events] of scenario.script) {
        t += delay;
        timers.push(setTimeout(() => events.forEach((e) => emit(e)), t));
      }
    },
    stop,
    async requestHandoff(reason) {
      emit({ type: "handoff", reason });
      emit({ type: "call_ended", reason: "Transferred to a team member" });
    },
  };
}
