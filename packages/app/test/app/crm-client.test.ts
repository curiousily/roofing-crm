import { describe, expect, it } from "vitest";
import { loadDataset } from "../../src/data/dataset.js";
import {
  leadFromHail,
  leadFromPermit,
  leadFromProperty,
  leadsFromTopLead,
  withPropertyDetails,
} from "../../src/leads/lead-input.js";
import { LeadsApi } from "../../src/leads/leads-api.js";
import { LeadSignal, LeadStatus } from "../../worker/leads/lead.js";

const ORIGIN = "https://crm.test";
const WORKSPACE = "6f1f1b8e-6a2c-4c55-9d5b-2a8f3c1e0a11";
const DATASET = { rootCid: "bafybei-three", buildId: "20261027T100024Z" };

function recording(respond: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond(String(input), init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("loadDataset", () => {
  it("loads the latest published dataset with its build and coverage", async () => {
    const files: Record<string, unknown> = {
      [`${ORIGIN}/api/publications`]: [
        {
          buildId: "20261027T082005Z",
          manifestCid: "bafkrei-two",
          rootCid: "bafybei-two",
          publishedAt: "x",
        },
        {
          buildId: "20261027T100024Z",
          manifestCid: "bafkrei-three",
          rootCid: "bafybei-three",
          publishedAt: "y",
        },
      ],
      [`${ORIGIN}/ipfs/bafybei-three/build.json`]: {
        buildId: "20261027T100024Z",
        asOf: "2026-10-27",
      },
      [`${ORIGIN}/ipfs/bafybei-three/coverage.json`]: { properties: { rows: 453713 } },
    };
    const { fetchImpl } = recording((url) =>
      url in files ? Response.json(files[url]) : new Response("missing", { status: 404 }),
    );

    const dataset = await loadDataset(fetchImpl, ORIGIN);

    expect(dataset.ref).toEqual(DATASET);
    expect(dataset.publication.manifestCid).toBe("bafkrei-three");
    expect(dataset.coverage.properties?.rows).toBe(453713);
    expect(dataset.tableUrl("properties")).toBe(
      `${ORIGIN}/ipfs/bafybei-three/tables/properties.parquet`,
    );
  });
});

describe("LeadsApi", () => {
  it("sends the workspace with every request and the filters as query parameters", async () => {
    const { calls, fetchImpl } = recording(() => Response.json([]));
    const api = new LeadsApi(fetchImpl, () => WORKSPACE);

    await api.list({
      statuses: [LeadStatus.New, LeadStatus.Contacted],
      minRoofAgeYears: 20,
      near: { latitude: 30.4, longitude: -97.6, radiusMiles: 5 },
    });

    expect(calls[0]?.url).toBe(
      "/api/leads?status=new%2Ccontacted&min_roof_age=20&latitude=30.4&longitude=-97.6&radius_miles=5",
    );
    expect(new Headers(calls[0]?.init?.headers).get("x-workspace-id")).toBe(WORKSPACE);
  });

  it("tells a new lead from one merged into an existing lead", async () => {
    const { fetchImpl } = recording(() => Response.json({ id: "lead-1" }, { status: 200 }));

    const { created } = await new LeadsApi(fetchImpl, () => WORKSPACE).create({
      signal: LeadSignal.AgedRoof,
      propId: 1,
      address: "1 MAIN ST",
      dataset: DATASET,
    });

    expect(created).toBe(false);
  });

  it("adds many candidates in one batch request", async () => {
    const { calls, fetchImpl } = recording(() =>
      Response.json([{ lead: { id: "lead-1" }, created: true }]),
    );
    const input = { signal: LeadSignal.Hail, propId: 1, address: "1 MAIN ST", dataset: DATASET };

    const added = await new LeadsApi(fetchImpl, () => WORKSPACE).createMany([input]);

    expect(calls[0]?.url).toBe("/api/leads/batch");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ leads: [input] });
    expect(added).toEqual([{ lead: { id: "lead-1" }, created: true }]);
  });

  it("surfaces the server's validation message", async () => {
    const { fetchImpl } = recording(() =>
      Response.json({ error: "Invalid lead" }, { status: 400 }),
    );

    await expect(
      new LeadsApi(fetchImpl, () => WORKSPACE).update("x", { status: LeadStatus.Won }),
    ).rejects.toThrow("Invalid lead");
  });
});

const HAIL_ROW = {
  prop_id: 866295,
  situs_address: "1703 ALGUNO RD A",
  latitude: 30.33,
  longitude: -97.72,
  roof_age_years: 12,
  roof_age_anchor: "year_built",
  roof_age_confidence: "low",
  max_hail_inches: 2.5,
  last_hail_date: "2025-05-28",
};

describe("lead input", () => {
  it("turns a hail row into a hail lead with the largest reported hail and its date", () => {
    expect(leadFromHail(HAIL_ROW, undefined, DATASET)).toEqual({
      signal: "hail",
      propId: 866295,
      address: "1703 ALGUNO RD A",
      latitude: 30.33,
      longitude: -97.72,
      roofAgeYears: 12,
      roofAgeAnchor: "year_built",
      roofAgeConfidence: "low",
      hailInches: 2.5,
      hailDate: "2025-05-28",
      dataset: DATASET,
    });
  });

  it("turns a top lead into one lead input per signal that scored", () => {
    const row = {
      ...HAIL_ROW,
      roof_age_years: 39,
      roof_age_confidence: "high",
      max_years_open: 30,
      roof_points: 40,
      permit_points: 30,
      hail_points: 30,
    };

    const inputs = leadsFromTopLead(row, undefined, DATASET);
    const silent = leadsFromTopLead(
      { ...row, permit_points: 0, hail_points: 0 },
      undefined,
      DATASET,
    );

    expect(inputs.map((input) => input.signal)).toEqual(["aged_roof", "open_permit", "hail"]);
    expect(inputs[1]).toMatchObject({ propId: 866295, yearsOpen: 30 });
    expect(inputs[2]).toMatchObject({ hailInches: 2.5 });
    expect(silent.map((input) => input.signal)).toEqual(["aged_roof"]);
  });

  it("turns an aged-roof row and its property details into a lead with the owner's mailing address", () => {
    const row = {
      prop_id: 276120,
      situs_address: "202 WALNUT ST",
      latitude: 30.4392,
      longitude: -97.6196,
      roof_age_years: 41,
      roof_age_anchor: "completed_replacement",
      roof_age_confidence: "high",
      owner_name: "JANE DOE",
    };
    const details = {
      mailing_line1: "PO BOX 12",
      mailing_line2: null,
      mailing_line3: null,
      mailing_city: "PFLUGERVILLE",
      mailing_state: "TX",
      mailing_zip: "78660",
    };

    expect(leadFromProperty(row, details, DATASET)).toEqual({
      signal: "aged_roof",
      propId: 276120,
      address: "202 WALNUT ST",
      latitude: 30.4392,
      longitude: -97.6196,
      ownerName: "JANE DOE",
      mailingAddress: "PO BOX 12, PFLUGERVILLE, TX 78660",
      roofAgeYears: 41,
      roofAgeAnchor: "completed_replacement",
      roofAgeConfidence: "high",
      dataset: DATASET,
    });
  });

  it("turns an open-permit row into a lead with its contractor and BBB grade", () => {
    const row = {
      permit_number: "2007-105523 BP",
      address: "202 WALNUT ST",
      permit_state: "expired",
      years_open: 19,
      contractor_name: "Wilson Roofing",
      bbb_rating: null,
      prop_id: 276120,
      latitude: 30.4392,
      longitude: -97.6196,
    };

    expect(leadFromPermit(row, DATASET)).toEqual({
      signal: "open_permit",
      propId: 276120,
      permitNumber: "2007-105523 BP",
      address: "202 WALNUT ST",
      latitude: 30.4392,
      longitude: -97.6196,
      permitState: "expired",
      yearsOpen: 19,
      contractorName: "Wilson Roofing",
      dataset: DATASET,
    });
  });

  it("adds the owner, mailing address and roof age of the linked property to a permit lead", () => {
    const permit = leadFromPermit(
      { permit_number: "P-1", address: "1 MAIN ST", prop_id: 7, years_open: 9 },
      DATASET,
    );

    const enriched = withPropertyDetails(permit, {
      owner_name: "JOHN ROE",
      mailing_line1: "1 MAIN ST",
      mailing_city: "AUSTIN",
      mailing_state: "TX",
      mailing_zip: "78701",
      roof_age_years: 33,
      roof_age_anchor: "year_built",
      roof_age_confidence: "low",
    });

    expect(enriched).toMatchObject({
      signal: "open_permit",
      permitNumber: "P-1",
      ownerName: "JOHN ROE",
      mailingAddress: "1 MAIN ST, AUSTIN, TX 78701",
      roofAgeYears: 33,
      roofAgeConfidence: "low",
    });
  });
});
