import { useEffect, useRef, useState } from "react";
import { stepCues, stepStatuses, type CallView, type StepStatus } from "./callReducer";
import { playCue } from "./sound";

const STORAGE_KEY = "console.sound";

/** Sound on or off, remembered in this browser. On by default. */
export function useSoundPreference(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const set = (next: boolean) => {
    setOn(next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
    } catch {
      // Storage can be blocked; the choice still holds for this visit.
    }
  };
  return [on, set];
}

/**
 * Plays one chime when a step passes and one low tone when steps fail.
 * Several failures in one update (a call ending early) are a single tone.
 */
export function useStepSounds(view: CallView, enabled: boolean): void {
  const statuses = stepStatuses(view).map((s) => s.status);
  const key = statuses.join(",");
  const prev = useRef<StepStatus[] | null>(null);

  useEffect(() => {
    const before = prev.current;
    prev.current = statuses;
    if (!before || !enabled) return;
    const { passed, failed } = stepCues(before, statuses);
    if (passed) playCue("positive");
    if (failed) playCue("negative", passed ? 0.32 : 0);
    // `key` stands in for `statuses`, compared by value.
  }, [key, enabled]);
}
