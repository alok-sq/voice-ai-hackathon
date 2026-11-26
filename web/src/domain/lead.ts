import type { FlowState, Lead, LeadField, LeadValues, Outcome } from "../contract/events";

/** Steps shown in the progress bar, in call order (DONE is not a step). */
export type Step = Exclude<FlowState, "DONE">;

export const STEPS: { state: Step; label: string; fields: LeadField[] }[] = [
  { state: "IDENTITY", label: "Identity", fields: ["identity_confirmed"] },
  { state: "INTEREST", label: "Interest", fields: ["solar_interest"] },
  { state: "PROPERTY", label: "Property", fields: ["property_type", "roof_ownership", "roof_access", "shadow_free_area"] },
  { state: "BILL", label: "Bill", fields: ["monthly_bill", "discom"] },
  { state: "LOCATION_TIMELINE", label: "Location", fields: ["city_or_pincode", "timeline"] },
  { state: "FINANCE", label: "Finance", fields: ["loan_interest", "subsidy_interest"] },
  { state: "MEETING_PITCH", label: "Meeting", fields: ["meeting_slot"] },
  { state: "WRAP_UP", label: "Wrap-up", fields: [] },
];

export const LEAD_GROUPS: { title: string; fields: { field: LeadField; label: string }[] }[] = [
  {
    title: "Caller",
    fields: [
      { field: "identity_confirmed", label: "Identity confirmed" },
      { field: "solar_interest", label: "Interested in solar" },
    ],
  },
  {
    title: "Property",
    fields: [
      { field: "property_type", label: "Property type" },
      { field: "roof_ownership", label: "Roof ownership" },
      { field: "roof_access", label: "Roof access" },
      { field: "shadow_free_area", label: "Shadow-free area" },
    ],
  },
  {
    title: "Energy",
    fields: [
      { field: "monthly_bill", label: "Monthly bill" },
      { field: "discom", label: "DISCOM" },
    ],
  },
  {
    title: "Location and timing",
    fields: [
      { field: "city_or_pincode", label: "City or pincode" },
      { field: "timeline", label: "Timeline" },
    ],
  },
  {
    title: "Finance",
    fields: [
      { field: "loan_interest", label: "Loan" },
      { field: "subsidy_interest", label: "PM Surya Ghar subsidy" },
    ],
  },
  { title: "Meeting", fields: [{ field: "meeting_slot", label: "Preferred slot" }] },
];

export const LEAD_FIELD_COUNT = LEAD_GROUPS.reduce((n, g) => n + g.fields.length, 0);

export const OUTCOME_LABELS: Record<Outcome, string> = {
  qualified: "Qualified",
  not_qualified: "Not qualified",
  callback: "Callback",
  wrong_number: "Wrong number",
  do_not_call: "Do not call",
};

const PROPERTY_LABELS: Record<LeadValues["property_type"], string> = {
  independent_house: "Independent house",
  housing_society: "Housing society",
  commercial: "Commercial",
};

const OWNERSHIP_LABELS: Record<LeadValues["roof_ownership"], string> = {
  owned: "Owned",
  rented: "Rented",
  shared: "Shared (society)",
};

const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

export function formatLeadValue<F extends LeadField>(field: F, value: LeadValues[F]): string {
  switch (field) {
    case "monthly_bill":
      return inr(value as number);
    case "shadow_free_area":
      return `${(value as number).toLocaleString("en-IN")} sq ft`;
    case "property_type":
      return PROPERTY_LABELS[value as LeadValues["property_type"]];
    case "roof_ownership":
      return OWNERSHIP_LABELS[value as LeadValues["roof_ownership"]];
    case "meeting_slot": {
      const slot = value as LeadValues["meeting_slot"];
      return slot.location ? `${slot.label} · ${slot.location}` : slot.label;
    }
    default:
      return typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
  }
}

export const isCaptured = (lead: Lead, field: LeadField) => lead[field] !== undefined;

/** How many lead fields have an answer. `false` is an answer, so it counts. */
export const capturedCount = (lead: Lead) =>
  LEAD_GROUPS.reduce((n, g) => n + g.fields.filter(({ field }) => isCaptured(lead, field)).length, 0);

/**
 * Answers that rule a lead out: the wrong person, no interest, or a roof
 * the caller cannot put panels on. Preferences (no loan, no subsidy) are not failures.
 */
export function isBlocking(field: LeadField, value: unknown): boolean {
  switch (field) {
    case "identity_confirmed":
    case "solar_interest":
    case "roof_access":
      return value === false;
    case "roof_ownership":
      return value === "rented";
    default:
      return false;
  }
}

export type CellState = "empty" | "partial" | "full";

/** One solar-panel cell per field group: lit when the group is captured, half-lit when partly. */
export const panelCells = (lead: Lead): CellState[] =>
  LEAD_GROUPS.map((g) => {
    const n = g.fields.filter(({ field }) => isCaptured(lead, field)).length;
    return n === 0 ? "empty" : n === g.fields.length ? "full" : "partial";
  });

/** Indexes of cells that have just become full, to twinkle once. */
export const newlyFull = (prev: CellState[], next: CellState[]): number[] =>
  next.flatMap((s, i) => (s === "full" && prev[i] !== "full" ? [i] : []));
