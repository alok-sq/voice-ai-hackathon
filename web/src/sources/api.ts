/** Thin client for the console backend (server/main.py). Same-origin `/api`, proxied by Vite. */
import type { Language, PhoneAgent, Pipeline } from "./types";

export interface Health {
  reachable: boolean;
  livekit: boolean;
  phone: boolean;
  /** Demo v3: Cartesia API key and the dashboard agent id are both set. */
  cartesia: boolean;
  /** Demo v4: ElevenLabs API key and the dashboard agent id are both set. */
  elevenlabs: boolean;
  /** Demo v3 can place a phone call: Cartesia agent plus CARTESIA_FROM_NUMBER_ID. */
  cartesiaPhone: boolean;
  /** Demo v4 can place a phone call: ElevenLabs agent plus ELEVENLABS_PHONE_NUMBER_ID. */
  elevenlabsPhone: boolean;
  missing: string[];
}

export interface PhoneCallStart {
  mode: "livekit" | "hosted";
  room?: string;
  callId?: string;
  events?: unknown[];
}

export interface PhoneSync {
  events?: unknown[];
  ended?: boolean;
  reason?: string;
}

const UNREACHABLE: Health = {
  reachable: false,
  livekit: false,
  phone: false,
  cartesia: false,
  elevenlabs: false,
  cartesiaPhone: false,
  elevenlabsPhone: false,
  missing: [],
};

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = await res
      .json()
      .then((j: { detail?: unknown }) => (typeof j.detail === "string" ? j.detail : null))
      .catch(() => null);
    throw new Error(detail ?? `The backend returned ${res.status}.`);
  }
  return res.json() as Promise<T>;
}

export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  try {
    const res = await fetch("/api/health", { signal });
    if (!res.ok) return UNREACHABLE;
    const j = (await res.json()) as Partial<Health>;
    return {
      reachable: true,
      livekit: !!j.livekit,
      phone: !!j.phone,
      cartesia: !!j.cartesia,
      elevenlabs: !!j.elevenlabs,
      cartesiaPhone: !!j.cartesiaPhone,
      elevenlabsPhone: !!j.elevenlabsPhone,
      missing: j.missing ?? [],
    };
  } catch {
    return UNREACHABLE;
  }
}

export function phoneAgentReady(health: Health | null, agent: PhoneAgent): boolean {
  if (!health?.reachable) return false;
  if (agent === "demo" || agent === "demo_v2") return health.phone;
  if (agent === "demo_v3") return health.cartesiaPhone;
  return health.elevenlabsPhone;
}

export const placePhoneCall = (phone: string, language: Language, agent: PhoneAgent, signal?: AbortSignal) =>
  post<PhoneCallStart>("/call", { phone, language, agent }, signal);

export const syncPhoneCall = (callId: string, signal?: AbortSignal) =>
  post<PhoneSync>("/phone/sync", { callId }, signal);

export const endPhoneCall = (callId: string) => post<PhoneSync>("/phone/end", { callId });

export const getRoomToken = (
  language: Language,
  room: string | null,
  listenOnly: boolean,
  pipeline: Pipeline = "cascade",
  signal?: AbortSignal,
) => post<{ url: string; token: string; room: string }>("/token", { language, room, listenOnly, pipeline }, signal);

/** Closes the room for everyone: hangs up the phone leg and ends the agent job. */
export const endRoom = (room: string) => post<{ ok: boolean }>("/end", { room });
