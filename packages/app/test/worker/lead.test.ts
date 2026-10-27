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
