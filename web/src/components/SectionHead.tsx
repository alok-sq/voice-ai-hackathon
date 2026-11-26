import type { ReactNode } from "react";

/** Sentence-case section title with a quiet counter, e.g. "Lead record · 4 of 13". */
export function SectionHead({ id, title, count, aside }: { id: string; title: string; count?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="section-head">
      <h2 id={id} className="section-title">
        {title}
        {count !== undefined && <span className="section-count"> · {count}</span>}
      </h2>
      {aside}
    </div>
  );
}
