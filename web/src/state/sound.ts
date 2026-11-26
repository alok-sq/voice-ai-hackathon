/**
 * Progress sounds, synthesised with Web Audio so there are no files to ship.
 * Quiet by design: they sit under a live call, so they must never compete with voices.
 *
 * Browsers only allow audio after the person has interacted with the page;
 * the intro's buttons and Start call are that interaction.
 */
export type Cue = "positive" | "negative";

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined" || !("AudioContext" in window)) return null;
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** Call from a click handler so later cues are allowed to play. */
export function unlockAudio(): void {
  audio();
}

/** One soft voice: an oscillator through a gain envelope (quick attack, exponential fade). */
function tone(ac: AudioContext, opts: { type: OscillatorType; from: number; to?: number; start: number; dur: number; gain: number; filter?: number }) {
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  const t0 = ac.currentTime + opts.start;
  osc.type = opts.type;
  osc.frequency.setValueAtTime(opts.from, t0);
  if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t0 + opts.dur * 0.7);
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(opts.gain, t0 + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
  let out: AudioNode = amp;
  if (opts.filter) {
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = opts.filter;
    amp.connect(lp);
    out = lp;
  }
  osc.connect(amp);
  out.connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + opts.dur + 0.05);
}

export function playCue(cue: Cue, delay = 0): void {
  const ac = audio();
  if (!ac) return;
  if (cue === "positive") {
    // A rising fifth, E5 then B5, with a faint octave shimmer: a small bell.
    tone(ac, { type: "sine", from: 659.25, start: delay, dur: 0.38, gain: 0.11 });
    tone(ac, { type: "sine", from: 987.77, start: delay + 0.09, dur: 0.5, gain: 0.1 });
    tone(ac, { type: "sine", from: 1975.5, start: delay + 0.09, dur: 0.3, gain: 0.015 });
  } else {
    // A low, rounded fall from G4 to E-flat 4: noticed, never alarming.
    tone(ac, { type: "triangle", from: 392, to: 311.13, start: delay, dur: 0.42, gain: 0.09, filter: 1400 });
  }
}
