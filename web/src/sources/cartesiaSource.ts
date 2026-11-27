import { parseEvent, type CallEvent } from "../contract/events";
import { eventsFromCartesia, replyLatency, type OpenTurn, type ReplyClock } from "./cartesiaEvents";
import { throwIfAborted, type CallSource, type Language, type StartContext } from "./types";

const SAMPLE_RATE = 16_000;
const CARTESIA_VERSION = "2026-08-14";
const FLUSH_SECONDS = 0.04;

const CAPTURE_WORKLET = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel);
    return true;
  }
}
registerProcessor("cartesia-capture", CaptureProcessor);
`;

interface SessionResponse {
  url: string;
  token: string;
  callId: string;
  events: CallEvent[];
}

interface SavedCall {
  result?: string;
  events?: unknown[];
}

function socketUrl(url: string, token: string): string {
  const next = new URL(url);
  next.searchParams.set("cartesia_version", CARTESIA_VERSION);
  next.searchParams.set("access_token", token);
  return next.toString();
}

function downsample(input: Float32Array, inRate: number, outRate: number): Int16Array {
  if (inRate === outRate) {
    const same = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) same[i] = floatToPcm(input[i] ?? 0);
    return same;
  }
  const ratio = inRate / outRate;
  const length = Math.floor(input.length / ratio);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const index = i * ratio;
    const left = Math.floor(index);
    const frac = index - left;
    const right = Math.min(left + 1, input.length - 1);
    out[i] = floatToPcm((input[left] ?? 0) * (1 - frac) + (input[right] ?? 0) * frac);
  }
  return out;
}

function floatToPcm(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

function pcmToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] ?? 0, true);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToPcm(encoded: string): Int16Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const samples = new Int16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
  return samples;
}

/** Plays Cartesia's paced PCM. A clear drops anything still queued. */
class PcmPlayer {
  private next = 0;
  private sources: AudioBufferSourceNode[] = [];

  constructor(private ctx: AudioContext) {}

  play(samples: Int16Array) {
    if (!samples.length) return;
    const buffer = this.ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = (samples[i] ?? 0) / 32768;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const start = Math.max(this.ctx.currentTime + 0.02, this.next);
    source.start(start);
    this.next = start + buffer.duration;
    this.sources.push(source);
    source.onended = () => {
      this.sources = this.sources.filter((item) => item !== source);
    };
  }

  clear() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources = [];
    this.next = 0;
  }

  close() {
    this.clear();
  }
}

async function openSession(language: Language, signal: AbortSignal): Promise<SessionResponse> {
  const res = await fetch("/api/cartesia/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language }),
    signal,
  });
  if (!res.ok) {
    const detail = await res
      .json()
      .then((body: { detail?: unknown }) => (typeof body.detail === "string" ? body.detail : null))
      .catch(() => null);
    throw new Error(detail ?? `The backend returned ${res.status}.`);
  }
  const body = (await res.json()) as Partial<SessionResponse>;
  if (!body.url || !body.token || !body.callId) throw new Error("Cartesia returned a session without a url and token.");
  return { url: body.url, token: body.token, callId: body.callId, events: body.events ?? [] };
}

async function postCartesia(path: string, body: unknown): Promise<SavedCall> {
  try {
    const res = await fetch(`/api${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    });
    if (!res.ok) return {};
    return (await res.json()) as SavedCall;
  } catch {
    return {};
  }
}

function savedEvents(body: SavedCall): CallEvent[] {
  return (body.events ?? []).flatMap((raw) => {
    const event = parseEvent(raw);
    return event ? [event] : [];
  });
}

/**
 * Demo v3. The microphone goes to the agent saved in the Cartesia dashboard,
 * and that agent is what answers. This console does not write the prompt.
 */
export function createCartesiaSource(language: Language): CallSource {
  let stopped = false;
  let ws: WebSocket | null = null;
  let audio: AudioContext | null = null;
  let player: PcmPlayer | null = null;
  let mic: MediaStream | null = null;
  let capture: AudioNode | null = null;
  let emit: StartContext["emit"] | null = null;
  let callId: string | null = null;
  let ending: Promise<CallEvent[]> | null = null;
  const open = new Map<number, OpenTurn>();
  const clock: ReplyClock = { since: null };

  const saveCall = (reason: string): Promise<CallEvent[]> => {
    if (!callId) return Promise.resolve([]);
    if (!ending) ending = postCartesia("/cartesia/end", { callId, reason }).then(savedEvents);
    return ending;
  };

  const release = () => {
    stopped = true;
    mic?.getTracks().forEach((track) => track.stop());
    mic = null;
    capture?.disconnect();
    capture = null;
    player?.close();
    player = null;
    void audio?.close();
    audio = null;
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
    ws = null;
  };

  const send = (payload: unknown) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  return {
    async start({ emit: publish, onEnd, signal }: StartContext) {
      emit = publish;
      const session = await openSession(language, signal);
      throwIfAborted(signal);
      callId = session.callId;
      for (const event of session.events) publish(event);

      audio = new AudioContext();
      player = new PcmPlayer(audio);
      await audio.resume();

      let settled = false;
      const ready = new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(socketUrl(session.url, session.token));
        ws = socket;
        const giveUp = (message: string) => {
          if (settled) {
            if (!stopped) onEnd(message);
            return;
          }
          settled = true;
          reject(new Error(message));
        };
        socket.onerror = () => {
          if (!settled) giveUp("Could not connect to the Cartesia agent.");
        };
        socket.onclose = () => {
          if (stopped) return;
          if (!settled) giveUp("Cartesia closed the connection.");
          else {
            void saveCall("Cartesia ended the call").then((events) => {
              if (stopped) return;
              for (const event of events) publish(event);
              onEnd("Cartesia ended the call");
            });
          }
        };
        socket.onmessage = (event) => {
          if (stopped) return;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(String(event.data)) as Record<string, unknown>;
          } catch {
            return;
          }
          const metric = replyLatency(msg, clock, performance.now());
          if (metric) publish(metric);
          if (msg.type === "session_ready") {
            if (!settled) {
              settled = true;
              resolve();
            }
            return;
          }
          if (msg.type === "audio_output" && typeof msg.audio === "string") {
            player?.play(base64ToPcm(msg.audio));
            return;
          }
          if (msg.type === "audio_output_clear") {
            player?.clear();
            return;
          }
          if (msg.type === "client_tool_call" && typeof msg.tool_name === "string") {
            const toolId = typeof msg.tool_call_id === "string" ? msg.tool_call_id : "";
            void postCartesia("/cartesia/tool", {
              callId,
              name: msg.tool_name,
              arguments: msg.parameters ?? {},
              toolId,
            }).then((savedCall) => {
              if (stopped) return;
              for (const event of savedEvents(savedCall)) publish(event);
              if (msg.expects_response === true && toolId) {
                const result = savedCall.result || "Saved.";
                send({
                  type: "client_tool_result",
                  tool_call_id: toolId,
                  result,
                  is_error: result.startsWith("Unknown tool"),
                });
              }
            });
            return;
          }
          if (msg.type === "turn_ended" && callId) {
            void postCartesia("/cartesia/turn", {
              callId,
              role: msg.role,
              text: typeof msg.text === "string" ? msg.text : "",
              toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
            }).then((savedCall) => {
              if (stopped) return;
              for (const event of savedEvents(savedCall)) publish(event);
            });
          }
          if (msg.type === "error" && msg.fatal === true) {
            giveUp(typeof msg.message === "string" ? msg.message : "The Cartesia agent failed.");
            return;
          }
          for (const callEvent of eventsFromCartesia(msg, open) as CallEvent[]) publish(callEvent);
        };
        socket.onopen = () => {
          send({
            type: "session_create",
            audio: { input_format: "pcm_16000", output_delivery: "speaking_pace", continuous_input: true },
          });
        };
        signal.addEventListener("abort", () => {
          release();
          if (!settled) {
            settled = true;
            reject(new DOMException("Cancelled", "AbortError"));
          }
        });
      });

      await ready;
      throwIfAborted(signal);
      publish({
        type: "system",
        text: "Connected to the Cartesia agent. It answers from the prompt saved in the Cartesia dashboard.",
      });

      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      throwIfAborted(signal);
      const workletUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "application/javascript" }));
      try {
        await audio.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }
      const source = audio.createMediaStreamSource(mic);
      const node = new AudioWorkletNode(audio, "cartesia-capture");
      const mute = audio.createGain();
      mute.gain.value = 0;
      node.connect(mute);
      mute.connect(audio.destination);
      const pending: number[] = [];
      const flushAt = Math.floor(audio.sampleRate * FLUSH_SECONDS);
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (stopped || ws?.readyState !== WebSocket.OPEN) return;
        pending.push(...event.data);
        while (pending.length >= flushAt) {
          const chunk = Float32Array.from(pending.splice(0, flushAt));
          send({ type: "audio_input", audio: pcmToBase64(downsample(chunk, audio!.sampleRate, SAMPLE_RATE)) });
        }
      };
      source.connect(node);
      capture = node;
    },

    async stop() {
      const events = await saveCall("Call ended by you");
      release();
      return events;
    },

    async requestHandoff() {
      emit?.({
        type: "system",
        text: "Handoff stays with the Cartesia agent on this path. This console only carries the audio.",
      });
    },
  };
}
