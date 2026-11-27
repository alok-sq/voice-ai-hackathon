import { createCartesiaSource } from "./cartesiaSource";
import { createDemoSource } from "./demo/demoSource";
import { throwIfAborted, type CallOptions, type CallSource, type ConnectMode, type Pipeline } from "./types";

export function createSource(opts: CallOptions): CallSource {
  if (opts.source === "scripted") return createDemoSource(opts.scenarioId);
  if (opts.source === "demo_v3") return createCartesiaSource(opts.language);
  const mode: ConnectMode = opts.source === "live" ? "phone" : "browser";
  const pipeline: Pipeline = opts.source === "demo_v2" ? "s2s" : "cascade";
  return createLazyLiveSource({ mode, language: opts.language, phone: opts.phone, pipeline });
}

/**
 * livekit-client is most of the bundle, so it is only downloaded when a live
 * call starts. Scripted mode and first paint stay fast.
 */
function createLazyLiveSource(
  opts: Pick<CallOptions, "language" | "phone"> & { mode: ConnectMode; pipeline: Pipeline },
): CallSource {
  let inner: CallSource | null = null;
  return {
    async start(ctx) {
      const { createLiveSource } = await import("./liveSource");
      throwIfAborted(ctx.signal);
      inner = createLiveSource(opts);
      await inner.start(ctx);
    },
    stop() {
      inner?.stop();
    },
    async requestHandoff(reason) {
      await inner?.requestHandoff(reason);
    },
  };
}

export * from "./types";
