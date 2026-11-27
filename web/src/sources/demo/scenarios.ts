import type { CallEvent, Outcome } from "../../contract/events";
import type { CallerProfile } from "../../domain/agent";

/** [delay after the previous step in ms, events emitted together]. */
export type ScriptStep = [number, CallEvent[]];

export interface Scenario {
  id: string;
  title: string;
  description: string;
  caller: CallerProfile;
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
  caller: { name: "Mr. Nair", phone: "+91 98••• ••521", city: "Pune", source: "Website enquiry" },
  script: [
    [600, [{ type: "system", text: "Agent joined. The call is recorded." }, { type: "state", state: "IDENTITY" }]],
    [900, [agent("Namaste, main SolarSquare se Ajay bol raha hoon. Yeh call record ho rahi hai. Kya meri baat Mr. Nair se ho rahi hai?")]],
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

/* ---------- Robustness scenarios: the cases the brief says judges will test ---------- */

const joined = (): CallEvent[] => [{ type: "system", text: "Agent joined. The call is recorded." }, { type: "state", state: "IDENTITY" }];
const opener = (name: string) => agent(`Namaste, main SolarSquare se Ajay bol raha hoon. Yeh call record ho rahi hai. Kya meri baat ${name} se ho rahi hai?`);
const ended = (reason = "Agent ended the call"): CallEvent => ({ type: "call_ended", reason });

const interruptsCodeMix: Scenario = {
  id: "interrupts-code-mix",
  title: "Interrupts and code-mixes",
  description: "Busy caller, driving. Talks over Ajay twice and says \"teen-saadhe teen hazaar\".",
  caller: { name: "Mr. Sharma", phone: "+91 99••• ••208", city: "Nagpur", source: "Facebook lead form" },
  script: [
    [600, joined()],
    [900, [opener("Mr. Sharma")]],
    [1500, [caller("Haan haan, bolo bolo, jaldi bolo, main gaadi chala raha hoon."), metric(690, 170, 300, 220), { type: "lead", field: "identity_confirmed", value: true }]],
    [1000, [{ type: "state", state: "INTEREST" }, agent("Ji, main jaldi bataati hoon. Aapne rooftop solar ke liye enquiry ki thi, aur hum aapko ek free site survey ke saath poori jaankari—")]],
    [700, [{ type: "interrupted" }, caller("Haan haan, interested hoon. Seedha point pe aao."), metric(610, 150, 260, 200), { type: "lead", field: "solar_interest", value: true }]],
    [1000, [{ type: "state", state: "PROPERTY" }, agent("Zaroor. Ghar aapka apna independent house hai?")]],
    [
      1500,
      [
        caller("Haan, apna ghar hai. Chhat pe pani ki tanki hai bas, baaki khaali."),
        metric(740, 180, 320, 240),
        { type: "lead", field: "property_type", value: "independent_house" },
        { type: "lead", field: "roof_ownership", value: "owned" },
        { type: "lead", field: "roof_access", value: true },
      ],
    ],
    [1000, [{ type: "state", state: "BILL" }, agent("Samajh gayi. Mahine ka bijli bill kitna aata hai, roughly?")]],
    [1700, [caller("Teen-saadhe teen hazaar ke aas paas, summer mein zyada."), metric(820, 210, 360, 250), { type: "lead", field: "monthly_bill", value: 3500 }]],
    [900, [agent("Theek hai. Aur bijli kaunsi company deti hai, MSEDCL ya—")]],
    [
      600,
      [
        { type: "interrupted" },
        caller("MSEDCL hi hai. Aur Nagpur mein hoon."),
        metric(580, 140, 250, 190),
        { type: "lead", field: "discom", value: "MSEDCL" },
        { type: "state", state: "LOCATION_TIMELINE" },
        { type: "lead", field: "city_or_pincode", value: "Nagpur" },
      ],
    ],
    [1000, [{ type: "state", state: "MEETING_PITCH" }, agent("Bahut badhiya. Aapka time bachane ke liye, hamare surveyor Saturday subah 11 baje aa jaayein?")]],
    [1500, [caller("Saturday chalega, 11 baje theek hai."), metric(700, 170, 300, 230), { type: "lead", field: "meeting_slot", value: { label: "Saturday, 11 am", location: "Home" } }]],
    [1000, [{ type: "state", state: "WRAP_UP" }, agent("Done, Saturday 11 baje confirm. Aap safe drive kariye, dhanyavaad.")]],
    [1200, [{ type: "state", state: "DONE" }, { type: "outcome", outcome: "qualified" }, { type: "usage", costInr: 1.6 }]],
    [800, [ended()]],
  ],
};

const subsidyQuestion: Scenario = {
  id: "subsidy-question",
  title: "Asks about subsidy",
  description: "Pushes for a subsidy amount and savings. Ajay deflects without stating any figure.",
  caller: { name: "Mrs. Iyer", phone: "+91 98••• ••764", city: "Bengaluru", source: "Website enquiry" },
  script: [
    [600, joined()],
    [900, [opener("Mrs. Iyer")]],
    [1600, [caller("Haan, main hi hoon."), metric(720, 180, 310, 230), { type: "lead", field: "identity_confirmed", value: true }]],
    [1000, [{ type: "state", state: "INTEREST" }, agent("Aapne solar ke liye form bhara tha. Kya aap abhi bhi solar lagwana chahti hain?")]],
    [1600, [caller("Haan, par pehle yeh batao, subsidy kitni milegi? Suna hai 78 hazaar milta hai?"), metric(760, 190, 330, 240), { type: "lead", field: "solar_interest", value: true }]],
    [300, [{ type: "guardrail", kind: "subsidy" }]],
    [
      700,
      [agent("Bahut accha sawaal hai. Subsidy ki exact rashi aapke system size aur PM Surya Ghar ke niyamon par depend karti hai, isliye main phone par koi rashi nahi bataungi. Survey par hamare expert aapko sahi jaankari denge.")],
    ],
    [1800, [caller("Accha. Aur bill kitna kam ho jaayega?"), metric(800, 200, 350, 250)]],
    [300, [{ type: "guardrail", kind: "savings" }]],
    [700, [agent("Bachat aapke bill aur chhat par depend karti hai. Survey ke baad aapko likhit estimate milega. Kya main pehle aapke ghar ke baare mein do sawaal pooch loon?")]],
    [1500, [caller("Haan, poochiye."), metric(650, 160, 280, 210)]],
    [900, [{ type: "state", state: "PROPERTY" }, agent("Aapka ghar independent house hai ya society mein flat?")]],
    [
      1600,
      [
        caller("Independent house hai, apna hai. Chhat pe kareeb 800 square feet khuli jagah hai."),
        metric(740, 180, 320, 240),
        { type: "lead", field: "property_type", value: "independent_house" },
        { type: "lead", field: "roof_ownership", value: "owned" },
        { type: "lead", field: "roof_access", value: true },
        { type: "lead", field: "shadow_free_area", value: 800 },
      ],
    ],
    [1000, [{ type: "state", state: "BILL" }, agent("Mahine ka bill kitna aata hai, aur bijli company kaunsi hai?")]],
    [1700, [caller("Lagbhag 4,200 aata hai. BESCOM."), metric(790, 200, 340, 250), { type: "lead", field: "monthly_bill", value: 4200 }, { type: "lead", field: "discom", value: "BESCOM" }]],
    [1000, [{ type: "state", state: "LOCATION_TIMELINE" }, agent("Aapka pincode kya hai, aur kab tak lagwana chahengi?")]],
    [
      1600,
      [
        caller("560076. Agle mahine tak."),
        metric(700, 170, 300, 230),
        { type: "lead", field: "city_or_pincode", value: "560076" },
        { type: "lead", field: "timeline", value: "Next month" },
      ],
    ],
    [1000, [{ type: "state", state: "FINANCE" }, agent("Kya aap survey par PM Surya Ghar subsidy ya loan ke baare mein baat karna chahengi?")]],
    [1500, [caller("Subsidy haan, loan nahi."), metric(680, 170, 290, 220), { type: "lead", field: "subsidy_interest", value: true }, { type: "lead", field: "loan_interest", value: false }]],
    [1000, [{ type: "state", state: "MEETING_PITCH" }, agent("Hamare surveyor Sunday shaam 4 baje aa sakte hain. Woh subsidy ki poori process bhi samjha denge. Theek rahega?")]],
    [1500, [caller("Haan, Sunday 4 baje."), metric(660, 160, 280, 220), { type: "lead", field: "meeting_slot", value: { label: "Sunday, 4 pm", location: "Home" } }]],
    [1000, [{ type: "state", state: "WRAP_UP" }, agent("Dhanyavaad Mrs. Iyer. Sunday 4 baje confirm hai. Apna bijli ka bill paas rakhiyega.")]],
    [1300, [{ type: "state", state: "DONE" }, { type: "outcome", outcome: "qualified" }, { type: "usage", costInr: 2.1 }]],
    [800, [ended()]],
  ],
};

const silence: Scenario = {
  id: "silence",
  title: "Goes silent",
  description: "The caller stops responding. Ajay prompts twice, then books a callback.",
  caller: { name: "Mr. Verma", phone: "+91 97••• ••119", city: "Indore", source: "Google ad" },
  script: [
    [600, joined()],
    [900, [opener("Mr. Verma")]],
    [1400, [caller("Haan... haan."), metric(760, 190, 330, 240), { type: "lead", field: "identity_confirmed", value: true }]],
    [1000, [{ type: "state", state: "INTEREST" }, agent("Aapne solar ke liye enquiry ki thi. Kya abhi do minute baat kar sakte hain?")]],
    [700, [{ type: "speaking", who: "none" }]],
    [3200, [{ type: "reprompt", attempt: 1 }, agent("Hello, Mr. Verma? Kya aap mujhe sun pa rahe hain?")]],
    [700, [{ type: "speaking", who: "none" }]],
    [3200, [{ type: "reprompt", attempt: 2 }, agent("Lagta hai line saaf nahi hai. Main aapko thodi der mein dobara call karti hoon.")]],
    [1200, [{ type: "state", state: "DONE" }, { type: "outcome", outcome: "callback", reason: "No response after two prompts", callbackAt: "Today, 6 pm" }, { type: "usage", costInr: 0.7 }]],
    [700, [ended()]],
  ],
};

const askMySon: Scenario = {
  id: "ask-my-son",
  title: "\"Ask my son\"",
  description: "His mother picks up. Ajay records none of her answers and books a callback for the son.",
  caller: { name: "Mr. Rao", phone: "+91 94••• ••352", city: "Hyderabad", source: "Website enquiry" },
  script: [
    [600, joined()],
    [900, [opener("Mr. Rao")]],
    [
      1700,
      [
        caller("Nahi beta, main unki mummy bol rahi hoon. Yeh solar-volar mujhe nahi pata, mere bete se baat karo."),
        metric(780, 200, 340, 240),
        { type: "lead", field: "identity_confirmed", value: false },
      ],
    ],
    [1100, [agent("Ji aunty, koi baat nahi. Kya aap bata sakti hain, unse baat karne ka sahi samay kya hoga?")]],
    [1600, [caller("Shaam ko saat baje ke baad aa jaata hai."), metric(720, 180, 310, 230)]],
    [1000, [{ type: "state", state: "WRAP_UP" }, agent("Bahut dhanyavaad aunty. Main unhe aaj shaam saat baje call karungi. Aapka din shubh ho.")]],
    [
      1300,
      [
        { type: "state", state: "DONE" },
        { type: "outcome", outcome: "callback", reason: "Spoke to the lead's mother. She asked us to call her son.", callbackAt: "Today, 7 pm" },
        { type: "usage", costInr: 0.6 },
      ],
    ],
    [800, [ended()]],
  ],
};

const doNotCall: Scenario = {
  id: "do-not-call",
  title: "Do not call",
  description: "Caller declines and asks not to be called again. Ajay stops at once.",
  caller: { name: "Mr. Desai", phone: "+91 90••• ••481", city: "Ahmedabad", source: "Referral" },
  script: [
    [600, joined()],
    [900, [opener("Mr. Desai")]],
    [1500, [caller("Haan, main hi hoon."), metric(700, 170, 300, 230), { type: "lead", field: "identity_confirmed", value: true }]],
    [1000, [{ type: "state", state: "INTEREST" }, agent("Aapne solar ke baare mein jaankari maangi thi. Kya aap abhi bhi interested hain?")]],
    [1700, [caller("Nahi, mujhe nahi chahiye. Aur please mujhe dobara call mat karna."), metric(690, 170, 290, 230), { type: "lead", field: "solar_interest", value: false }]],
    [900, [agent("Bilkul, maafi chahti hoon. Aapka number hamari calling list se hata diya jaayega. Dhanyavaad.")]],
    [1200, [{ type: "state", state: "DONE" }, { type: "outcome", outcome: "do_not_call", reason: "Caller asked not to be called again." }, { type: "usage", costInr: 0.5 }]],
    [700, [ended("Stopped at the caller's request")]],
  ],
};

const wrongNumber: Scenario = {
  id: "wrong-number",
  title: "Wrong number",
  description: "The number belongs to someone else. Ajay apologises and closes the lead.",
  caller: { name: "Ms. Fernandes", phone: "+91 93••• ••907", city: "Panaji", source: "Website enquiry" },
  script: [
    [600, joined()],
    [900, [opener("Ms. Fernandes")]],
    [1600, [caller("Kaun? Yahan koi Fernandes nahi rehti, aapne galat number lagaya hai."), metric(740, 190, 320, 230), { type: "lead", field: "identity_confirmed", value: false }]],
    [1000, [agent("Maaf kijiye, galti se aapko call laga. Hum yeh number apne record se hata denge. Dhanyavaad.")]],
    [1200, [{ type: "state", state: "DONE" }, { type: "outcome", outcome: "wrong_number", reason: "The number does not belong to the lead." }, { type: "usage", costInr: 0.4 }]],
    [700, [ended()]],
  ],
};

const notQualified: Scenario = {
  id: "not-qualified",
  title: "Not qualified",
  description: "Tenant in a housing society with no roof access. Ajay closes politely.",
  caller: { name: "Mr. Khan", phone: "+91 96••• ••633", city: "Mumbai", source: "Instagram ad" },
  script: [
    [600, joined()],
    [900, [opener("Mr. Khan")]],
    [1500, [caller("Haan, bolo."), metric(700, 170, 300, 230), { type: "lead", field: "identity_confirmed", value: true }]],
    [1000, [{ type: "state", state: "INTEREST" }, agent("Aapne rooftop solar ke liye enquiry ki thi. Kya aap abhi bhi interested hain?")]],
    [1500, [caller("Haan, bijli ka bill bahut aata hai."), metric(680, 170, 290, 220), { type: "lead", field: "solar_interest", value: true }]],
    [1000, [{ type: "state", state: "PROPERTY" }, agent("Aap independent house mein rehte hain ya society mein?")]],
    [
      1700,
      [
        caller("Society mein flat hai, kiraye pe. Chhat society ki hai, hume upar jaane nahi dete."),
        metric(820, 210, 360, 250),
        { type: "lead", field: "property_type", value: "housing_society" },
        { type: "lead", field: "roof_ownership", value: "rented" },
        { type: "lead", field: "roof_access", value: false },
      ],
    ],
    [
      1100,
      [agent("Samajh gayi. Rooftop solar ke liye chhat ka access zaroori hota hai. Agar aapki society solar lagwana chahe, toh hum unse baat kar sakte hain. Kya main aapko iski jaankari SMS kar doon?")],
    ],
    [1500, [caller("Haan, bhej do."), metric(650, 160, 280, 210)]],
    [1000, [{ type: "state", state: "WRAP_UP" }, agent("Zaroor. Dhanyavaad Mr. Khan, aapka din shubh ho.")]],
    [
      1200,
      [
        { type: "state", state: "DONE" },
        { type: "outcome", outcome: "not_qualified", reason: "Tenant in a housing society, with no roof rights or access." },
        { type: "usage", costInr: 0.9 },
      ],
    ],
    [700, [ended()]],
  ],
};

export const SCENARIOS: Scenario[] = [
  happyPath,
  interruptsCodeMix,
  subsidyQuestion,
  silence,
  askMySon,
  doNotCall,
  wrongNumber,
  notQualified,
];
export const DEFAULT_SCENARIO_ID = happyPath.id;

/** The outcome a scenario ends with (its last outcome event). */
export function expectedOutcome(s: Scenario): Outcome | null {
  const outcomes = s.script.flatMap(([, events]) => events).filter((e) => e.type === "outcome");
  const last = outcomes.at(-1);
  return last && last.type === "outcome" ? last.outcome : null;
}
