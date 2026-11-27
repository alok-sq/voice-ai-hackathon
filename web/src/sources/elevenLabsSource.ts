import { parseEvent, type CallEvent } from "../contract/events";
import { eventsFromElevenLabs, outputSampleRate, type ElevenClock } from "./elevenLabsEvents";
import { throwIfAborted, type CallSource, type Language, type StartContext } from "./types";

const INPUT_RATE = 16_000;
const FLUSH_SECONDS = 0.1;

const CAPTURE_WORKLET = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel);
    return true;
  }
}
registerProcessor("elevenlabs-capture", CaptureProcessor);
`;

interface SessionResponse {
  url: string;
  callId: string;
  events: CallEvent[];
}

interface SavedCall {
  result?: string;
  events?: unknown[];
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

/** Plays ElevenLabs PCM. A clear drops anything still queued. */
class PcmPlayer {
  rate = INPUT_RATE;
  private next = 0;
  private sources: AudioBufferSourceNode[] = [];

  constructor(private ctx: AudioContext) {}

  play(samples: Int16Array) {
    if (!samples.length) return;
    const buffer = this.ctx.createBuffer(1, samples.length, this.rate);
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
  const res = await fetch("/api/elevenlabs/session", {
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
  if (!body.url || !body.callId) throw new Error("ElevenLabs returned a session without a url.");
  return { url: body.url, callId: body.callId, events: body.events ?? [] };
}

async function postEleven(path: string, body: unknown): Promise<SavedCall> {
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

function agentText(msg: Record<string, unknown>): string {
  const body = (msg.agent_response_event ?? msg.agent_response_correction_event) as Record<string, unknown> | undefined;
  const text = body?.agent_response ?? body?.corrected_agent_response;
  return typeof text === "string" ? text : "";
}

/**
 * Demo v4. The microphone goes to the agent saved in the ElevenLabs dashboard,
 * and that agent is what answers. This console does not write the prompt.
 */
export function createElevenLabsSource(language: Language): CallSource {
  let stopped = false;
  let ws: WebSocket | null = null;
  let audio: AudioContext | null = null;
  let player: PcmPlayer | null = null;
  let mic: MediaStream | null = null;
  let capture: AudioNode | null = null;
  let emit: StartContext["emit"] | null = null;
  let callId: string | null = null;
  let ending: Promise<CallEvent[]> | null = null;
  const clock: ElevenClock = { since: null, n: 0 };

  const saveCall = (reason: string): Promise<CallEvent[]> => {
    if (!callId) return Promise.resolve([]);
    if (!ending) ending = postEleven("/elevenlabs/end", { callId, reason }).then(savedEvents);
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
        const socket = new WebSocket(session.url);
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
          if (!settled) giveUp("Could not connect to the ElevenLabs agent.");
        };
        socket.onclose = () => {
          if (stopped) return;
          if (!settled) giveUp("ElevenLabs closed the connection.");
          else {
            void saveCall("ElevenLabs ended the call").then((events) => {
              if (stopped) return;
              for (const event of events) publish(event);
              onEnd("ElevenLabs ended the call");
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
          if (msg.type === "conversation_initiation_metadata") {
            const meta = msg.conversation_initiation_metadata_event as Record<string, unknown> | undefined;
            if (player) player.rate = outputSampleRate(meta?.agent_output_audio_format);
            return;
          }
          if (msg.type === "ping") {
            const ping = msg.ping_event as Record<string, unknown> | undefined;
            const delay = typeof ping?.ping_ms === "number" ? ping.ping_ms : 0;
            window.setTimeout(() => send({ type: "pong", event_id: ping?.event_id }), delay);
            return;
          }
          if (msg.type === "audio") {
            const body = msg.audio_event as Record<string, unknown> | undefined;
            if (typeof body?.audio_base_64 === "string") player?.play(base64ToPcm(body.audio_base_64));
          }
          if (msg.type === "interruption") player?.clear();
          if (msg.type === "client_tool_call" && callId) {
            const call = (msg.client_tool_call ?? {}) as Record<string, unknown>;
            const toolId = typeof call.tool_call_id === "string" ? call.tool_call_id : "";
            const name = typeof call.tool_name === "string" ? call.tool_name : "";
            void postEleven("/elevenlabs/tool", {
              callId,
              name,
              arguments: call.parameters ?? {},
              toolId,
            }).then((saved) => {
              if (stopped) return;
              for (const savedEvent of savedEvents(saved)) publish(savedEvent);
              if (toolId) {
                const result = saved.result || "Saved.";
                send({
                  type: "client_tool_result",
                  tool_call_id: toolId,
                  result,
                  is_error: result.startsWith("Unknown tool"),
                });
              }
            });
          }
          const spoken =
            msg.type === "user_transcript"
              ? (() => {
                  const body = msg.user_transcription_event as Record<string, unknown> | undefined;
                  return typeof body?.user_transcript === "string" ? body.user_transcript : "";
                })()
              : msg.type === "agent_response" || msg.type === "agent_response_correction"
                ? agentText(msg)
                : "";
          if (spoken && callId) {
            const role = msg.type === "user_transcript" ? "user" : "assistant";
            void postEleven("/elevenlabs/turn", { callId, role, text: spoken, toolCalls: [] }).then((saved) => {
              if (stopped) return;
              for (const savedEvent of savedEvents(saved)) publish(savedEvent);
            });
          }
          for (const callEvent of eventsFromElevenLabs(msg, clock, performance.now())) publish(callEvent);
        };
        socket.onopen = () => {
          send({ type: "conversation_initiation_client_data" });
          if (!settled) {
            settled = true;
            resolve();
          }
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
        text: "Connected to the ElevenLabs agent. It answers from the prompt saved in the ElevenLabs dashboard.",
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
      const node = new AudioWorkletNode(audio, "elevenlabs-capture");
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
          send({ user_audio_chunk: pcmToBase64(downsample(chunk, audio!.sampleRate, INPUT_RATE)) });
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
        text: "Handoff stays with the ElevenLabs agent on this path. This console only carries the audio.",
      });
    },
  };
}
