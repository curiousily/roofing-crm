export enum LeadStatus {
  New = "new",
  Contacted = "contacted",
  Qualified = "qualified",
  Proposal = "proposal",
  Won = "won",
  Lost = "lost",
}

export enum LeadSignal {
  AgedRoof = "aged_roof",
  OpenPermit = "open_permit",
}

export enum LeadPriority {
  Low = "low",
  Medium = "medium",
  High = "high",
}

export enum ActivityKind {
  Created = "created",
  SignalAdded = "signal_added",
  PermitAdded = "permit_added",
  StatusChanged = "status_changed",
  PriorityChanged = "priority_changed",
  NotesUpdated = "notes_updated",
  NextActionSet = "next_action_set",
}

export interface DatasetRef {
  rootCid: string;
  buildId: string;
}

export interface LeadFacts {
  propId?: number | undefined;
  permitNumber?: string | undefined;
  address: string;
  latitude?: number | undefined;
  longitude?: number | undefined;
  ownerName?: string | undefined;
  mailingAddress?: string | undefined;
  roofAgeYears?: number | undefined;
  roofAgeAnchor?: string | undefined;
  roofAgeConfidence?: string | undefined;
  permitState?: string | undefined;
  yearsOpen?: number | undefined;
  contractorName?: string | undefined;
  bbbRating?: string | undefined;
}

export interface NewLeadInput extends LeadFacts {
  signal: LeadSignal;
  dataset: DatasetRef;
}

export interface Lead extends LeadFacts {
  id: string;
  workspaceId: string;
  signals: LeadSignal[];
  status: LeadStatus;
  priority: LeadPriority;
  notes: string;
  nextActionOn?: string | undefined;
  datasetRootCid: string;
  datasetBuildId: string;
  createdAt: string;
  updatedAt: string;
}

export interface LeadActivity {
  leadId: string;
  kind: ActivityKind;
  detail: string;
  at: string;
}

export interface LeadChange {
  lead: Lead;
  activities: LeadActivity[];
}

export type EditableField = "status" | "priority" | "notes" | "nextActionOn";
export type LeadChanges = Partial<Pick<Lead, EditableField | "updatedAt">>;

export interface LeadEdit extends LeadChange {
  changes: LeadChanges;
}

export interface LeadUpdate {
  status?: LeadStatus | undefined;
  priority?: LeadPriority | undefined;
  notes?: string | undefined;
  nextActionOn?: string | null | undefined;
}

export interface LeadFilter {
  statuses?: LeadStatus[] | undefined;
  signals?: LeadSignal[] | undefined;
  permitStates?: string[] | undefined;
  minRoofAgeYears?: number | undefined;
  minYearsOpen?: number | undefined;
  near?: { latitude: number; longitude: number; radiusMiles: number } | undefined;
}

const HIGH_PRIORITY_ROOF_AGE_YEARS = 20;
const HIGH_PRIORITY_YEARS_OPEN = 5;
const WELL_EVIDENCED_ROOF_AGE = new Set(["high", "medium"]);
const EARTH_RADIUS_MILES = 3958.8;
const CLEARED = "cleared";
const PRIORITY_ORDER = [LeadPriority.Low, LeadPriority.Medium, LeadPriority.High];
const PERMIT_FIELDS: (keyof LeadFacts)[] = [
  "permitNumber",
  "permitState",
  "yearsOpen",
  "contractorName",
  "bbbRating",
];

const FACT_FIELDS: (keyof LeadFacts)[] = [
  "propId",
  "permitNumber",
  "address",
  "latitude",
  "longitude",
  "ownerName",
  "mailingAddress",
  "roofAgeYears",
  "roofAgeAnchor",
  "roofAgeConfidence",
  "permitState",
  "yearsOpen",
  "contractorName",
  "bbbRating",
];

export function newLead(
  id: string,
  workspaceId: string,
  { signal, dataset, ...facts }: NewLeadInput,
  now: string,
): LeadChange {
  const lead: Lead = {
    ...facts,
    id,
    workspaceId,
    signals: [signal],
    status: LeadStatus.New,
    priority: priorityOf(facts),
    notes: "",
    datasetRootCid: dataset.rootCid,
    datasetBuildId: dataset.buildId,
    createdAt: now,
    updatedAt: now,
  };
  return {
    lead,
    activities: [
      activity(lead, ActivityKind.Created, `from ${signal} in dataset ${dataset.rootCid}`, now),
    ],
  };
}

export function mergeLead(existing: Lead, input: NewLeadInput, now: string): LeadChange {
  const anotherPermit =
    input.signal === LeadSignal.OpenPermit &&
    input.permitNumber !== undefined &&
    existing.permitNumber !== undefined &&
    input.permitNumber !== existing.permitNumber;
  if (existing.signals.includes(input.signal) && !anotherPermit) {
    return { lead: existing, activities: [] };
  }

  if (anotherPermit) {
    const longerOpen = (input.yearsOpen ?? 0) > (existing.yearsOpen ?? 0);
    const permitFacts = longerOpen
      ? Object.fromEntries(PERMIT_FIELDS.map((field) => [field, input[field]]))
      : {};
    const merged = { ...existing, ...permitFacts };
    const lead: Lead = {
      ...merged,
      priority: higher(existing.priority, priorityOf(merged)),
      updatedAt: now,
    };
    const detail = `${input.permitNumber} (open ${input.yearsOpen ?? "?"} years)`;
    return { lead, activities: [activity(lead, ActivityKind.PermitAdded, detail, now)] };
  }

  const missing = Object.fromEntries(
    FACT_FIELDS.filter((field) => existing[field] === undefined && input[field] !== undefined).map(
      (field) => [field, input[field]],
    ),
  );
  const merged = { ...existing, ...missing };
  const lead: Lead = {
    ...merged,
    signals: [...existing.signals, input.signal],
    priority: higher(existing.priority, priorityOf(merged)),
    updatedAt: now,
  };
  return { lead, activities: [activity(lead, ActivityKind.SignalAdded, input.signal, now)] };
}

export function applyUpdate(lead: Lead, update: LeadUpdate, now: string): LeadEdit {
  const activities: LeadActivity[] = [];
  const changes: LeadChanges = {};
  const change = <Field extends EditableField>(
    field: Field,
    value: Lead[Field],
    kind: ActivityKind,
    detail: string,
  ) => {
    changes[field] = value;
    activities.push(activity(lead, kind, detail, now));
  };

  if (update.status !== undefined && update.status !== lead.status) {
    change(
      "status",
      update.status,
      ActivityKind.StatusChanged,
      `${lead.status} → ${update.status}`,
    );
  }
  if (update.priority !== undefined && update.priority !== lead.priority) {
    change(
      "priority",
      update.priority,
      ActivityKind.PriorityChanged,
      `${lead.priority} → ${update.priority}`,
    );
  }
  if (update.notes !== undefined && update.notes !== lead.notes) {
    change("notes", update.notes, ActivityKind.NotesUpdated, update.notes);
  }
  if (
    update.nextActionOn !== undefined &&
    (update.nextActionOn ?? undefined) !== lead.nextActionOn
  ) {
    const nextActionOn = update.nextActionOn ?? undefined;
    change("nextActionOn", nextActionOn, ActivityKind.NextActionSet, nextActionOn ?? CLEARED);
  }
  if (activities.length === 0) return { lead, activities, changes };
  const timestamped = { ...changes, updatedAt: now };
  return { lead: { ...lead, ...timestamped }, activities, changes: timestamped };
}

export function matchesFilter(lead: Lead, filter: LeadFilter): boolean {
  const atLeast = (value: number | undefined, minimum: number | undefined) =>
    minimum === undefined || (value !== undefined && value >= minimum);
  const oneOf = <T>(value: T | undefined, allowed: T[] | undefined) =>
    allowed === undefined || (value !== undefined && allowed.includes(value));

  return (
    oneOf(lead.status, filter.statuses) &&
    (filter.signals === undefined ||
      filter.signals.some((signal) => lead.signals.includes(signal))) &&
    oneOf(lead.permitState, filter.permitStates) &&
    atLeast(lead.roofAgeYears, filter.minRoofAgeYears) &&
    atLeast(lead.yearsOpen, filter.minYearsOpen) &&
    (filter.near === undefined || isNear(lead, filter.near))
  );
}

function isNear(lead: Lead, near: NonNullable<LeadFilter["near"]>): boolean {
  if (lead.latitude === undefined || lead.longitude === undefined) return false;
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(lead.latitude - near.latitude);
  const longitudeDelta = radians(lead.longitude - near.longitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(near.latitude)) *
      Math.cos(radians(lead.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(haversine)) <= near.radiusMiles;
}

function priorityOf(facts: LeadFacts): LeadPriority {
  const longOpen = (facts.yearsOpen ?? 0) >= HIGH_PRIORITY_YEARS_OPEN;
  const oldRoof =
    (facts.roofAgeYears ?? 0) >= HIGH_PRIORITY_ROOF_AGE_YEARS &&
    WELL_EVIDENCED_ROOF_AGE.has(facts.roofAgeConfidence ?? "");
  return longOpen || oldRoof ? LeadPriority.High : LeadPriority.Medium;
}

function higher(first: LeadPriority, second: LeadPriority): LeadPriority {
  return PRIORITY_ORDER.indexOf(first) >= PRIORITY_ORDER.indexOf(second) ? first : second;
}

function activity(lead: Lead, kind: ActivityKind, detail: string, at: string): LeadActivity {
  return { leadId: lead.id, kind, detail, at };
}
