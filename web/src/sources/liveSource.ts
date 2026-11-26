import { ParticipantKind, Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrack } from "livekit-client";
import { COMMANDS_TOPIC, EVENTS_TOPIC, parseEvent, type ConsoleCommand } from "../contract/events";
import { endRoom, getRoomToken, placePhoneCall } from "./api";
import { throwIfAborted, type CallOptions, type CallSource } from "./types";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Joins the agent's LiveKit room and turns its data messages into CallEvents.
 *
 * Browser mode: you talk to the agent through your mic.
 * Phone mode:   the backend dials a test number; you join listen-only to watch.
 */
export function createLiveSource(opts: Pick<CallOptions, "mode" | "language" | "phone">): CallSource {
  let room: Room | null = null;
  let roomName: string | null = null;
  let stopped = false;
  const audioEls = new Set<HTMLMediaElement>();

  const release = () => {
    audioEls.forEach((el) => el.remove());
    audioEls.clear();
    room?.removeAllListeners();
    void room?.disconnect();
    room = null;
  };

  return {
    async start({ emit, onEnd, signal }) {
      if (opts.mode === "phone") {
        roomName = (await placePhoneCall(opts.phone, opts.language, signal)).room;
        throwIfAborted(signal);
      }
      const { url, token, room: joined } = await getRoomToken(opts.language, roomName, opts.mode === "phone", signal);
      roomName = joined;
      throwIfAborted(signal);

      const r = new Room({ adaptiveStream: true });
      room = r;

      r.on(RoomEvent.DataReceived, (payload: Uint8Array, _p?: RemoteParticipant, _k?: unknown, topic?: string) => {
        if (topic !== EVENTS_TOPIC || stopped) return;
        let raw: unknown;
        try {
          raw = JSON.parse(decoder.decode(payload));
        } catch {
          console.warn("[console] Ignored a data message that is not JSON");
          return;
        }
        const event = parseEvent(raw);
        if (event) emit(event);
        else console.warn("[console] Ignored an event that does not match the contract", raw);
      });

      r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach();
        el.hidden = true;
        document.body.appendChild(el);
        audioEls.add(el);
      });
      r.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        track.detach().forEach((el) => {
          el.remove();
          audioEls.delete(el);
        });
      });

      r.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
        if (stopped) return;
        if (p.kind === ParticipantKind.SIP) onEnd("Caller hung up");
        else if (p.kind === ParticipantKind.AGENT) onEnd("Agent left the call");
      });
      r.on(RoomEvent.Disconnected, () => {
        if (!stopped) onEnd("Disconnected from the call");
      });

      await r.connect(url, token);
      if (signal.aborted) {
        release();
        throwIfAborted(signal);
      }
      // Autoplay policies can block audio after the awaits above; this resumes it.
      await r.startAudio().catch(() => {});
      if (opts.mode === "browser") await r.localParticipant.setMicrophoneEnabled(true);
    },

    stop() {
      if (stopped) return;
      stopped = true;
      release();
      // Without this, ending in phone mode would leave the agent and the
      // caller still talking after the console leaves.
      if (roomName) endRoom(roomName).catch((err) => console.warn("[console] Could not close the room", err));
    },

    async requestHandoff(reason) {
      if (!room) return;
      const cmd: ConsoleCommand = { type: "handoff_request", reason };
      await room.localParticipant.publishData(encoder.encode(JSON.stringify(cmd)), {
        reliable: true,
        topic: COMMANDS_TOPIC,
      });
    },
  };
}
