import { describe, expect, it } from "vitest";
import {
  ActivityKind,
  applyUpdate,
  type Lead,
  type LeadFilter,
  LeadPriority,
  LeadSignal,
  LeadStatus,
  matchesFilter,
  mergeLead,
  type NewLeadInput,
  newLead,
} from "../../worker/leads/lead.js";

const NOW = "2026-10-27T12:00:00.000Z";
const LATER = "2026-10-28T09:30:00.000Z";
const DATASET = { rootCid: "bafybei-root", buildId: "20261027T100024Z" };

const agedRoof: NewLeadInput = {
  signal: LeadSignal.AgedRoof,
  propId: 276120,
  address: "202 WALNUT ST",
  latitude: 30.4392,
  longitude: -97.6196,
  ownerName: "JANE DOE",
  mailingAddress: "202 WALNUT ST, PFLUGERVILLE, TX 78660",
  roofAgeYears: 41,
  roofAgeAnchor: "completed_replacement",
  roofAgeConfidence: "high",
  dataset: DATASET,
};

const openPermit: NewLeadInput = {
  signal: LeadSignal.OpenPermit,
  propId: 276120,
  permitNumber: "2007-105523 BP",
  address: "202 WALNUT ST",
  permitState: "expired",
  yearsOpen: 19,
  contractorName: "Wilson Roofing",
  bbbRating: "A+",
  dataset: DATASET,
};

const hail: NewLeadInput = {
  signal: LeadSignal.Hail,
  propId: 276120,
  address: "202 WALNUT ST",
  roofAgeYears: 12,
  roofAgeAnchor: "year_built",
  roofAgeConfidence: "low",
  hailInches: 1.75,
  hailDate: "2026-05-09",
  dataset: DATASET,
};

function lead(overrides: Partial<Lead> = {}): Lead {
  return { ...newLead("lead-1", "workspace-1", agedRoof, NOW).lead, ...overrides };
}

describe("newLead", () => {
  it("captures the property snapshot, its source dataset and a creation activity", () => {
    const { lead: created, activities } = newLead("lead-1", "workspace-1", agedRoof, NOW);

    expect(created).toMatchObject({
      id: "lead-1",
      workspaceId: "workspace-1",
      propId: 276120,
      address: "202 WALNUT ST",
      roofAgeYears: 41,
      signals: [LeadSignal.AgedRoof],
      status: LeadStatus.New,
      datasetRootCid: "bafybei-root",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(activities).toEqual([
      expect.objectContaining({ leadId: "lead-1", kind: ActivityKind.Created, at: NOW }),
    ]);
  });

  it("ranks long-open permits and well-evidenced old roofs as high priority", () => {
    expect(newLead("a", "w", agedRoof, NOW).lead.priority).toBe(LeadPriority.High);
    expect(newLead("b", "w", openPermit, NOW).lead.priority).toBe(LeadPriority.High);
    expect(
      newLead("c", "w", { ...agedRoof, roofAgeYears: 17, roofAgeConfidence: "low" }, NOW).lead
        .priority,
    ).toBe(LeadPriority.Medium);
  });
});

describe("hail leads", () => {
  it("keep the largest reported hail and its date, and rank inch-or-larger hail as high priority", () => {
    const { lead: created } = newLead("lead-2", "workspace-1", hail, NOW);

    expect(created).toMatchObject({
      signals: [LeadSignal.Hail],
      hailInches: 1.75,
      hailDate: "2026-05-09",
      priority: LeadPriority.High,
    });
    expect(newLead("lead-3", "workspace-1", { ...hail, hailInches: 0.75 }, NOW).lead.priority).toBe(
      LeadPriority.Medium,
    );
  });

  it("add hail to an existing lead and raise its priority", () => {
    const young = newLead("lead-4", "workspace-1", { ...agedRoof, roofAgeYears: 8 }, NOW).lead;

    const { lead: merged, activities } = mergeLead(young, hail, LATER);

    expect(merged).toMatchObject({
      signals: [LeadSignal.AgedRoof, LeadSignal.Hail],
      hailInches: 1.75,
      priority: LeadPriority.High,
    });
    expect(activities[0]).toMatchObject({
      kind: ActivityKind.SignalAdded,
      detail: LeadSignal.Hail,
    });
  });
});

describe("mergeLead", () => {
  it("adds a second signal and the permit facts to an existing lead", () => {
    const { lead: merged, activities } = mergeLead(lead(), openPermit, LATER);

    expect(merged.signals).toEqual([LeadSignal.AgedRoof, LeadSignal.OpenPermit]);
    expect(merged).toMatchObject({
      roofAgeYears: 41,
      permitNumber: "2007-105523 BP",
      yearsOpen: 19,
      bbbRating: "A+",
      updatedAt: LATER,
    });
    expect(activities.map((activity) => activity.kind)).toEqual([ActivityKind.SignalAdded]);
  });

  it("raises the priority when the new signal warrants it, but never lowers it", () => {
    const young = newLead(
      "lead-1",
      "workspace-1",
      { ...agedRoof, roofAgeYears: 17, roofAgeConfidence: "low" },
      NOW,
    ).lead;

    expect(young.priority).toBe(LeadPriority.Medium);
    expect(mergeLead(young, openPermit, LATER).lead.priority).toBe(LeadPriority.High);
    expect(
      mergeLead({ ...lead(), priority: LeadPriority.High }, { ...openPermit, yearsOpen: 1 }, LATER)
        .lead.priority,
    ).toBe(LeadPriority.High);
  });

  it("records another open permit on the same property and keeps the longest-open one", () => {
    const withPermit = mergeLead(lead(), openPermit, LATER).lead;

    const shorter = mergeLead(
      withPermit,
      { ...openPermit, permitNumber: "2015-1 BP", yearsOpen: 11 },
      LATER,
    );
    const longer = mergeLead(
      withPermit,
      { ...openPermit, permitNumber: "2001-9 BP", yearsOpen: 25 },
      LATER,
    );

    expect(shorter.lead.permitNumber).toBe("2007-105523 BP");
    expect(shorter.activities.map((activity) => [activity.kind, activity.detail])).toEqual([
      [ActivityKind.PermitAdded, "2015-1 BP (open 11 years)"],
    ]);
    expect(longer.lead).toMatchObject({ permitNumber: "2001-9 BP", yearsOpen: 25 });
  });

  it("changes nothing when the same signal is added again", () => {
    const { lead: merged, activities } = mergeLead(lead(), agedRoof, LATER);

    expect(merged.updatedAt).toBe(NOW);
    expect(activities).toEqual([]);
  });
});

describe("applyUpdate", () => {
  it("records every change as an activity", () => {
    const { lead: updated, activities } = applyUpdate(
      lead(),
      { status: LeadStatus.Contacted, notes: "Left a voicemail", nextActionOn: "2026-10-30" },
      LATER,
    );

    expect(updated).toMatchObject({
      status: LeadStatus.Contacted,
      notes: "Left a voicemail",
      nextActionOn: "2026-10-30",
      updatedAt: LATER,
    });
    expect(activities.map((activity) => [activity.kind, activity.detail])).toEqual([
      [ActivityKind.StatusChanged, "new → contacted"],
      [ActivityKind.NotesUpdated, "Left a voicemail"],
      [ActivityKind.NextActionSet, "2026-10-30"],
    ]);
  });

  it("ignores fields that did not change", () => {
    const { activities } = applyUpdate(lead(), { status: LeadStatus.New }, LATER);

    expect(activities).toEqual([]);
  });
});

describe("matchesFilter", () => {
  const all: LeadFilter = {};

  it("filters by status, roof age, permit state and open duration", () => {
    const old = lead({ roofAgeYears: 30 });
    const stalled = lead({ permitState: "expired", yearsOpen: 12, roofAgeYears: undefined });

    expect(matchesFilter(old, all)).toBe(true);
    expect(matchesFilter(old, { statuses: [LeadStatus.Won] })).toBe(false);
    expect(matchesFilter(old, { minRoofAgeYears: 25 })).toBe(true);
    expect(matchesFilter(old, { minRoofAgeYears: 31 })).toBe(false);
    expect(matchesFilter(stalled, { minYearsOpen: 10 })).toBe(true);
    expect(matchesFilter(old, { minYearsOpen: 1 })).toBe(false);
    expect(matchesFilter(stalled, { permitStates: ["expired"] })).toBe(true);
    expect(matchesFilter(stalled, { permitStates: ["open"] })).toBe(false);
  });

  it("filters by distance from a center", () => {
    const near = { latitude: 30.4392, longitude: -97.6196 };
    const sixMilesNorth = { latitude: 30.4392 + 6 / 69, longitude: -97.6196 };

    expect(matchesFilter(lead(), { near: { ...near, radiusMiles: 5 } })).toBe(true);
    expect(matchesFilter(lead(), { near: { ...sixMilesNorth, radiusMiles: 5 } })).toBe(false);
    expect(
      matchesFilter(lead({ latitude: undefined }), { near: { ...near, radiusMiles: 5 } }),
    ).toBe(false);
  });
});
