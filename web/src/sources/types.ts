import type { CallEvent } from "../contract/events";

export type Language = "hi" | "mr" | "ta" | "kn" | "en";
export type ConnectMode = "browser" | "phone";
export type SourceKind = "live" | "demo";

export interface CallOptions {
  source: SourceKind;
  mode: ConnectMode;
  language: Language;
  /** Test number, phone mode only. */
  phone: string;
  /** Demo scenario id, demo source only. */
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
