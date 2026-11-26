import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "../state/motion";

const MS_PER_WORD = 55;
const MAX_MS = 2200;

/**
 * Reveals a line word by word, like speech, the first time it mounts.
 * Screen readers get the full text at once; the animation is visual only.
 */
export function RevealText({ text }: { text: string }) {
  const reduced = usePrefersReducedMotion();
  const words = text.split(/(\s+)/); // keep whitespace tokens so spacing is exact
  const wordCount = words.filter((w) => w.trim()).length;
  const step = Math.min(MS_PER_WORD, MAX_MS / Math.max(1, wordCount));
  const [shown, setShown] = useState(reduced ? Infinity : 0);

  useEffect(() => {
    if (reduced) return setShown(Infinity);
    setShown(0);
    const id = setInterval(() => {
      setShown((n) => {
        if (n >= wordCount) {
          clearInterval(id);
          return n;
        }
        return n + 1;
      });
    }, step);
    return () => clearInterval(id);
  }, [text, reduced, step, wordCount]);

  // Once fully shown (or with reduced motion), plain text: copy-paste and screen readers get it once.
  if (shown >= wordCount) return <>{text}</>;

  let seen = 0;
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {words.map((w, i) => {
          if (!w.trim()) return w;
          const visible = seen++ < shown;
          return (
            <span key={i} className={`word${visible ? " is-in" : ""}`}>
              {w}
            </span>
          );
        })}
      </span>
    </>
  );
}
