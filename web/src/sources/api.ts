/** Thin client for the console backend (server/main.py). Same-origin `/api`, proxied by Vite. */
import type { Language } from "./types";

export interface Health {
  reachable: boolean;
  livekit: boolean;
  phone: boolean;
  missing: string[];
}

const UNREACHABLE: Health = { reachable: false, livekit: false, phone: false, missing: [] };

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
    return { reachable: true, livekit: !!j.livekit, phone: !!j.phone, missing: j.missing ?? [] };
  } catch {
    return UNREACHABLE;
  }
}

export const placePhoneCall = (phone: string, language: Language, signal?: AbortSignal) =>
  post<{ room: string }>("/call", { phone, language }, signal);

export const getRoomToken = (language: Language, room: string | null, listenOnly: boolean, signal?: AbortSignal) =>
  post<{ url: string; token: string; room: string }>("/token", { language, room, listenOnly }, signal);

/** Closes the room for everyone: hangs up the phone leg and ends the agent job. */
export const endRoom = (room: string) => post<{ ok: boolean }>("/end", { room });
