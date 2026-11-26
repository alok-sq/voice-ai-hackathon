import type { CallEvent } from "../contract/events";

export type Language = "hi" | "mr" | "ta" | "kn" | "en";
export type ConnectMode = "browser" | "phone";
/**
 * demo     talk to the real agent through your browser microphone
 * live     the backend dials a real test number; the console listens in
 * scripted offline playback of a pre-written call (no keys, no agent)
 */
export type SourceKind = "demo" | "live" | "scripted";

export interface CallOptions {
  source: SourceKind;
  language: Language;
  /** Test number, live (phone) source only. */
  phone: string;
  /** Scenario id, scripted source only. */
  scenarioId: string;
}

export interface StartContext {
  emit: (event: CallEvent) => void;
  /** The transport ended on its own (room closed, caller hung up). */
  onEnd: (reason: string) => void;
  /** Aborted when the user ends the call, including while still connecting. */
  signal: AbortSignal;
}

/**
 * A producer of call events. `start` resolves once connected and rejects on
 * failure. After `signal` aborts, a source must emit nothing and release
 * everything it holds.
 */
export interface CallSource {
  start(ctx: StartContext): Promise<void>;
  stop(): void;
  requestHandoff(reason: string): Promise<void>;
}

export class AbortedError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "AbortedError";
  }
}

export function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new AbortedError();
}
