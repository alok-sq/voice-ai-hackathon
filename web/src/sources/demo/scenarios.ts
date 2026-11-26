import type { CallEvent } from "../../contract/events";

/** [delay after the previous step in ms, events emitted together]. */
export type ScriptStep = [number, CallEvent[]];

export interface Scenario {
  id: string;
  title: string;
  description: string;
  script: ScriptStep[];
}

const agent = (text: string): CallEvent => ({ type: "transcript", role: "agent", text, final: true });
const caller = (text: string): CallEvent => ({ type: "transcript", role: "caller", text, final: true });
const metric = (replyMs: number, sttMs: number, llmTtftMs: number, ttsTtfbMs: number): CallEvent => ({
  type: "metric",
  replyMs,
  sttMs,
  llmTtftMs,
  ttsTtfbMs,
});

const happyPath: Scenario = {
  id: "happy-path",
  title: "Qualified lead",
  description: "Interested homeowner in Pune. Every field captured, survey booked.",
  script: [
    [600, [{ type: "system", text: "Agent joined. The call is recorded." }, { type: "state", state: "IDENTITY" }]],
    [900, [agent("Namaste, main SolarSquare se bol rahi hoon. Yeh call record ho rahi hai. Kya meri baat Mr. Nair se ho rahi hai?")]],
    [1900, [caller("Haan ji, bol raha hoon."), metric(740, 180, 310, 250), { type: "lead", field: "identity_confirmed", value: true }]],
    [1200, [{ type: "state", state: "INTEREST" }, agent("Aapne solar ke liye enquiry ki thi. Kya aap abhi bhi interested hain?")]],
    [1800, [caller("Haan, bill bahut aa raha hai."), metric(690, 170, 290, 230), { type: "lead", field: "solar_interest", value: true }]],
    [1200, [{ type: "state", state: "PROPERTY" }, agent("Aapka ghar independent house hai ya society mein flat?")]],
    [
      1700,
      [
        caller("Independent house hai, apna hai."),
        metric(810, 200, 350, 260),
        { type: "lead", field: "property_type", value: "independent_house" },
        { type: "lead", field: "roof_ownership", value: "owned" },
      ],
    ],
    [1000, [agent("Chhat par jaana aasaan hai? Aur dhoop ke time koi shadow aata hai?")]],
    [
      1600,
      [
        caller("Haan, seedhi hai. Shadow nahi, chhat khuli hai, kareeb 600 square feet."),
        metric(720, 190, 300, 230),
        { type: "lead", field: "roof_access", value: true },
        { type: "lead", field: "shadow_free_area", value: 600 },
      ],
    ],
    [1100, [{ type: "state", state: "BILL" }, agent("Mahine ka bijli bill kitna aata hai, aur provider kaun sa hai?")]],
    [
      2000,
      [
        caller("Around 3 hazaar aata hai, MSEDCL hai."),
        metric(860, 220, 370, 270),
        { type: "lead", field: "monthly_bill", value: 3000 },
        { type: "lead", field: "discom", value: "MSEDCL" },
      ],
    ],
    [1100, [{ type: "state", state: "LOCATION_TIMELINE" }, agent("Aap kis shehar mein hain, aur install kab tak karwana chahenge?")]],
    [
      1900,
      [
        caller("Pune, agle do mahine mein."),
        metric(700, 180, 290, 230),
        { type: "lead", field: "city_or_pincode", value: "Pune" },
        { type: "lead", field: "timeline", value: "Within 2 months" },
      ],
    ],
    [1100, [{ type: "state", state: "FINANCE" }, agent("Kya aap loan ya PM Surya Ghar subsidy ke baare mein jaanna chahenge?")]],
    [
      1700,
      [
        caller("Subsidy ke baare mein batayein, loan nahi chahiye."),
        metric(780, 200, 330, 250),
        { type: "lead", field: "loan_interest", value: false },
        { type: "lead", field: "subsidy_interest", value: true },
      ],
    ],
    [1100, [{ type: "state", state: "MEETING_PITCH" }, agent("Hamare surveyor aapke ghar aa sakte hain. Kal shaam 5 baje theek rahega?")]],
    [
      1700,
      [
        caller("Haan, kal shaam 5 baje chalega."),
        metric(650, 160, 270, 220),
        { type: "lead", field: "meeting_slot", value: { label: "Tomorrow, 5 pm", location: "Home" } },
      ],
    ],
    [1100, [{ type: "state", state: "WRAP_UP" }, agent("Dhanyavaad. Aapka slot confirm hai. Surveyor aapko call karenge.")]],
    [1400, [{ type: "state", state: "DONE" }, { type: "outcome", outcome: "qualified" }, { type: "usage", costInr: 2.4 }]],
    [800, [{ type: "call_ended", reason: "Agent ended the call" }]],
  ],
};

export const SCENARIOS: Scenario[] = [happyPath];
export const DEFAULT_SCENARIO_ID = happyPath.id;
