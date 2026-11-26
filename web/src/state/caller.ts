import type { CallerProfile } from "../domain/agent";
import { maskPhone } from "../domain/phone";
import { findScenario } from "../sources/demo/demoSource";
import type { CallOptions } from "../sources/types";

/** Who is on the other end for these options: the scenario's caller, or a stand-in for real-agent tests. */
export function callerFor(options: CallOptions): CallerProfile {
  if (options.source === "scripted") return findScenario(options.scenarioId).caller;
  if (options.source === "live")
    return { name: "Test caller", phone: options.phone ? maskPhone(options.phone) : "Number not set", city: "Phone line", source: "Team test number" };
  return { name: "You", phone: "Browser microphone", city: "This device", source: "Live test" };
}
