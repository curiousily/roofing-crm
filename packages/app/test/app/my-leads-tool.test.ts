import { describe, expect, it } from "vitest";
import { searchMyLeads } from "../../src/agent/my-leads-tool.js";
import {
  type Lead,
  type LeadFilter,
  LeadPriority,
  LeadSignal,
  LeadStatus,
} from "../../worker/leads/lead.js";

const DATASET = { buildId: "20261027T100024Z", rootCid: "bafybei-root" };

function lead(overrides: Partial<Lead>): Lead {
  return {
    id: "lead",
    workspaceId: "workspace",
    address: "1 MAIN ST",
    signals: [LeadSignal.AgedRoof],
    status: LeadStatus.New,
    priority: LeadPriority.Medium,
    notes: "",
    datasetRootCid: "bafybei-root",
    datasetBuildId: "20261027T100024Z",
    createdAt: "2026-10-27T10:00:00.000Z",
    updatedAt: "2026-10-27T10:00:00.000Z",
    ...overrides,
  };
}

const LEADS = [
  lead({
    id: "a",
    address: "9513 ORIOLE DR",
    roofAgeYears: 45,
    updatedAt: "2026-10-27T12:00:00.000Z",
  }),
  lead({ id: "b", address: "4112 MEDICAL PKWY", roofAgeYears: 58, priority: LeadPriority.High }),
  lead({
    id: "c",
    address: "5929 BALCONES DR",
    signals: [LeadSignal.OpenPermit],
    yearsOpen: 25,
    nextActionOn: "2026-11-02",
    updatedAt: "2026-10-27T11:00:00.000Z",
  }),
];

function api(leads: Lead[]) {
  const filters: LeadFilter[] = [];
  return {
    filters,
    list: async (filter: LeadFilter = {}) => {
      filters.push(filter);
      return leads;
    },
  };
}

describe("searchMyLeads", () => {
  it("finds the lead with the oldest roof when asked to sort by roof age", async () => {
    const result = await searchMyLeads({ sort: "oldest_roof", limit: 1 }, api(LEADS), DATASET);

    expect(result.rows.map((row) => row.address)).toEqual(["4112 MEDICAL PKWY"]);
    expect(result.totalMatches).toBe(3);
  });

  it("sorts by open duration, priority, next action or recency", async () => {
    const order = async (sort: string) =>
      (await searchMyLeads({ sort }, api(LEADS), DATASET)).rows.map((row) => row.id);

    expect(await order("longest_open")).toEqual(["c", "a", "b"]);
    expect(await order("priority")).toEqual(["b", "a", "c"]);
    expect(await order("next_action")).toEqual(["c", "a", "b"]);
    expect(await order("recent")).toEqual(["a", "c", "b"]);
  });

  it("passes the filters to the leads API", async () => {
    const leadsApi = api(LEADS);

    await searchMyLeads(
      { status: "contacted", signal: "open_permit", min_roof_age_years: 20 },
      leadsApi,
      DATASET,
    );

    expect(leadsApi.filters[0]).toEqual({
      statuses: [LeadStatus.Contacted],
      signals: [LeadSignal.OpenPermit],
      minRoofAgeYears: 20,
      minYearsOpen: undefined,
    });
  });
});
