import { parseEvent, type CallEvent } from "../contract/events";
import { endPhoneCall, placePhoneCall, syncPhoneCall, type PhoneSync } from "./api";
import { throwIfAborted, type CallOptions, type CallSource, type PhoneAgent } from "./types";

const POLL_MS = 2000;

function eventsOf(body: PhoneSync | { events?: unknown[] }): CallEvent[] {
  return (body.events ?? []).flatMap((raw) => {
    const event = parseEvent(raw);
    return event ? [event] : [];
  });
}

/**
 * A phone call answered by the Cartesia or ElevenLabs dashboard agent.
 * Audio is on the handset. This console follows the transcript.
 */
export function createPhoneAgentSource(opts: Pick<CallOptions, "language" | "phone"> & { phoneAgent: PhoneAgent }): CallSource {
  let callId: string | null = null;
  let stopped = false;
  let timer: number | null = null;
  let emit: ((event: CallEvent) => void) | null = null;

  const stopTimer = () => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  };

  return {
    async start({ emit: publish, onEnd, signal }) {
      emit = publish;
      const started = await placePhoneCall(opts.phone, opts.language, opts.phoneAgent, signal);
      throwIfAborted(signal);
      if (started.mode !== "hosted" || !started.callId) throw new Error("The phone call did not start.");
      callId = started.callId;
      if (stopped) return;
      for (const event of eventsOf(started)) publish(event);
      publish({
        type: "system",
        text: "Calling the test number. You will hear the agent on the phone. This screen follows the transcript.",
      });

      let failures = 0;
      const poll = async () => {
        if (stopped || signal.aborted || !callId) return;
        try {
          const status = await syncPhoneCall(callId, signal);
          if (stopped || signal.aborted) return;
          failures = 0;
          for (const event of eventsOf(status)) publish(event);
          if (status.ended) {
            stopped = true;
            stopTimer();
            onEnd(status.reason || "Call ended");
          }
        } catch (err) {
          if (stopped || signal.aborted || (err as Error)?.name === "AbortError") return;
          failures += 1;
          if (failures < 3) return;
          stopped = true;
          stopTimer();
          onEnd((err as Error)?.message || "Lost the phone call.");
        }
      };

      await poll();
      if (!stopped) timer = window.setInterval(() => void poll(), POLL_MS);
    },

    async stop() {
      const id = callId;
      const already = stopped;
      stopped = true;
      stopTimer();
      if (!id || already) return [];
      try {
        return eventsOf(await endPhoneCall(id));
      } catch {
        return [];
      }
    },

    async requestHandoff() {
      emit?.({
        type: "system",
        text: "This agent does not take a handoff from the console. Ask Ajay to have a person call back.",
      });
    },
  };
}
