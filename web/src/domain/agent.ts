/** The agent's persona, as introduced in the hackathon brief ("Meet Pari"). */
export const AGENT = {
  name: "Pari",
  role: "AI lead qualification",
  intro: "Pari calls every new solar lead within minutes, qualifies them in their own language and books a site survey.",
} as const;

/** Who is on the other end of the line, shown on the caller card. */
export interface CallerProfile {
  name: string;
  /** Masked for display; never a real customer's number. */
  phone: string;
  city: string;
  source: string;
}
