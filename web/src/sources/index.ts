import { createDemoSource } from "./demo/demoSource";
import { throwIfAborted, type CallOptions, type CallSource } from "./types";

export function createSource(opts: CallOptions): CallSource {
  return opts.source === "live" ? createLazyLiveSource(opts) : createDemoSource(opts.scenarioId);
}

/**
 * livekit-client is most of the bundle, so it is only downloaded when a live
 * call starts. Demo mode and first paint stay fast.
 */
function createLazyLiveSource(opts: CallOptions): CallSource {
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
