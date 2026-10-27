import { DuckDBInstance } from "@duckdb/node-api";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type DatasetInfo,
  runTool,
  type SqlRunner,
  TOOLS,
  ToolInputError,
  toolSchemas,
} from "../src/index.js";

const CENTER = { latitude: 30.2649, longitude: -97.7472 };
const DEGREES_PER_MILE = 1 / 69.0;
const north = (miles: number) => CENTER.latitude + miles * DEGREES_PER_MILE;

const DATASET: DatasetInfo = {
  buildId: "20261027T130000Z",
  manifestCid: "bafkrei-manifest",
  rootCid: "bafybei-root",
  publishedAt: "2026-10-27T13:05:00.000Z",
  coverage: { properties: { rows: 5 } },
};

let runner: SqlRunner;

beforeAll(async () => {
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  await connection.run(`
    CREATE TABLE properties AS SELECT * FROM (VALUES
      (1::BIGINT, '100 NEAR ST', '78701', ${north(1)}, ${CENTER.longitude}, 1990::BIGINT, 'COMPOSITIO', 30, 'year_built', '1996', NULL, 'high', 'NEAR OWNER', 'out_of_state', 'CA', 22, 1::BIGINT, 'parcel_centroid', 'tcad-appraisal-export', 'run-a'),
      (2::BIGINT, '300 YOUNG ST', '78701', ${north(3)}, ${CENTER.longitude}, 2016::BIGINT, 'METAL', 10, 'year_built', '2016', NULL, 'low', 'YOUNG OWNER', 'local', 'TX', 3, 0::BIGINT, 'parcel_centroid', 'tcad-appraisal-export', 'run-a'),
      (3::BIGINT, '800 FAR ST', '78660', ${north(8)}, ${CENTER.longitude}, 1980::BIGINT, 'COMPOSITIO', 46, 'year_built', '1980', NULL, 'low', 'FAR OWNER', 'regional', 'TX', 30, 0::BIGINT, 'address_point', 'tcad-appraisal-export', 'run-a'),
      (4::BIGINT, '200 MID ST', '78701', ${north(2)}, ${CENTER.longitude}, 2006::BIGINT, 'COMPOSITIO', 20, 'year_built', '2006', NULL, 'low', 'MID OWNER', 'local', 'TX', 12, 0::BIGINT, 'parcel_centroid', 'tcad-appraisal-export', 'run-a'),
      (5::BIGINT, '1 NOWHERE', NULL, NULL, NULL, 1970::BIGINT, NULL, 56, 'year_built', '1970', NULL, 'low', 'LOST OWNER', 'local', 'TX', 40, 0::BIGINT, NULL, 'tcad-appraisal-export', 'run-a')
    ) AS t(prop_id, situs_address, situs_zip, latitude, longitude, year_built, roof_covering, roof_age_years, roof_age_anchor, roof_age_anchor_date, roof_age_anchor_permit, roof_age_confidence, owner_name, owner_locality, mailing_state, ownership_years, unfinished_roofing_permits, coordinate_source, source, source_run_id);

    CREATE TABLE roofing_permits AS SELECT * FROM (VALUES
      ('2014-1 BP', '100 NEAR ST', 'expired', 'replacement', true, DATE '2014-03-01', 12, true, DATE '2014-03-01', 'Centec Holdings dba Wilson Roofing', '5125550142', 'wilson roofing', 'A+', 'https://www.bbb.org/x', DATE '2026-07-10', 'high', 1::BIGINT, ${north(1)}, ${CENTER.longitude}, 'https://abc.austintexas.gov/1', 'austin-permits', 'run-p', 'Reroof residence'),
      ('2024-2 BP', '200 MID ST', 'open', 'replacement', true, DATE '2024-05-01', 2, false, DATE '2024-05-01', 'Quick Roofing', NULL, 'quick roofing', NULL, NULL, NULL, NULL, 4::BIGINT, ${north(2)}, ${CENTER.longitude}, 'https://abc.austintexas.gov/2', 'austin-permits', 'run-p', 'Re-roof'),
      ('2006-3 BP', '800 FAR ST', 'open', 'repair', true, DATE '2006-01-01', 20, true, DATE '2006-01-01', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 3::BIGINT, ${north(9)}, ${CENTER.longitude}, 'https://abc.austintexas.gov/3', 'austin-permits', 'run-p', 'Roof repair'),
      ('2010-4 BP', '150 DONE ST', 'completed', 'replacement', false, NULL, NULL, false, DATE '2010-01-01', 'Quick Roofing', NULL, 'quick roofing', NULL, NULL, NULL, NULL, 1::BIGINT, ${north(1.5)}, ${CENTER.longitude}, 'https://abc.austintexas.gov/4', 'austin-permits', 'run-p', 'Reroof')
    ) AS t(permit_number, address, permit_state, roof_work, unfinished, open_since, years_open, past_expiry, issue_date, contractor_name, contractor_phone, contractor_key, bbb_rating, bbb_profile_url, bbb_snapshot_date, bbb_match_confidence, prop_id, latitude, longitude, source_url, source, source_run_id, description);

    CREATE TABLE contractors AS SELECT * FROM (VALUES
      ('wilson roofing', ['Centec Holdings dba Wilson Roofing'], ['5125550142'], 103::BIGINT, 1::BIGINT, 90::BIGINT, 'A+', 'Wilson Roofing', true, 'https://www.bbb.org/x', DATE '2026-07-10', 'phone', 'medium'),
      ('quick roofing', ['Quick Roofing'], [], 82::BIGINT, 1::BIGINT, 40::BIGINT, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
    ) AS t(contractor_key, names, phones, roofing_permits, unfinished_roofing_permits, properties, bbb_rating, bbb_business_name, bbb_accredited, bbb_profile_url, bbb_snapshot_date, bbb_match_method, bbb_match_confidence);
  `);
  runner = {
    all: async (sql) =>
      (await connection.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[],
  };
});

const run = (name: string, input: unknown) =>
  runTool(name, input, { sql: runner, dataset: DATASET });
const ids = (rows: Record<string, unknown>[], key: string) => rows.map((row) => row[key]);

describe("find_aged_roofs", () => {
  it("returns roofs older than the threshold within the radius, oldest first, with their basis", async () => {
    const result = await run("find_aged_roofs", {
      ...CENTER,
      radius_miles: 5,
      min_roof_age_years: 15,
    });

    expect(ids(result.rows, "prop_id")).toEqual(["1", "4"]);
    expect(result.rows[0]).toMatchObject({
      roof_age_years: 30,
      roof_age_anchor: "year_built",
      roof_age_confidence: "high",
      coordinate_source: "parcel_centroid",
      source: "tcad-appraisal-export",
    });
    expect(Number(result.rows[0]?.distance_miles)).toBeCloseTo(1, 1);
    expect(result.totalMatches).toBe(2);
    expect(result.dataset.manifestCid).toBe("bafkrei-manifest");
    expect(result.sql).toContain("FROM properties");
  });

  it("ranks the best-evidenced roof ages first, then the oldest", async () => {
    const result = await run("find_aged_roofs", {
      ...CENTER,
      radius_miles: 10,
      min_roof_age_years: 15,
    });

    expect(ids(result.rows, "prop_id")).toEqual(["1", "3", "4"]);
  });

  it("can require a minimum confidence in the roof age", async () => {
    const result = await run("find_aged_roofs", { ...CENTER, min_confidence: "medium" });

    expect(ids(result.rows, "prop_id")).toEqual(["1"]);
  });

  it("searches around a named place", async () => {
    const result = await run("find_aged_roofs", { place: "austin", radius_miles: 25 });

    expect(result.center).toMatchObject({
      name: "Austin",
      latitude: 30.298622,
      longitude: -97.754134,
    });
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it("rejects an unknown place and suggests known ones", async () => {
    await expect(run("find_aged_roofs", { place: "Atlantis" })).rejects.toThrow(ToolInputError);
    await expect(run("find_aged_roofs", { place: "pflug" })).resolves.toMatchObject({
      center: { name: "Pflugerville" },
    });
  });

  it("needs a place or coordinates", async () => {
    await expect(run("find_aged_roofs", { radius_miles: 5 })).rejects.toThrow(/place or latitude/i);
  });
});

describe("find_open_roofing_permits", () => {
  it("lists never-finished roofing permits open long enough, longest open first, with contractor and BBB", async () => {
    const result = await run("find_open_roofing_permits", {
      ...CENTER,
      radius_miles: 5,
      min_years_open: 5,
    });

    expect(ids(result.rows, "permit_number")).toEqual(["2014-1 BP"]);
    expect(result.rows[0]).toMatchObject({
      permit_state: "expired",
      years_open: 12,
      contractor_name: "Centec Holdings dba Wilson Roofing",
      bbb_rating: "A+",
      source_url: "https://abc.austintexas.gov/1",
    });
  });

  it("can leave out permits that expired without being finished", async () => {
    const result = await run("find_open_roofing_permits", {
      ...CENTER,
      min_years_open: 1,
      include_expired: false,
    });

    expect(ids(result.rows, "permit_number")).toEqual(["2024-2 BP"]);
  });
});

describe("details", () => {
  it("returns a property with its roofing permits", async () => {
    const result = await run("property_details", { prop_id: 1 });

    expect(result.rows[0]).toMatchObject({ prop_id: "1", situs_address: "100 NEAR ST" });
    expect(ids(result.related ?? [], "permit_number")).toEqual(["2014-1 BP", "2010-4 BP"]);
  });

  it("finds a contractor by any of its names, with its BBB grade and recent permits", async () => {
    const result = await run("contractor_details", { name: "Wilson Roofing" });

    expect(result.rows[0]).toMatchObject({
      contractor_key: "wilson roofing",
      bbb_rating: "A+",
      bbb_match_method: "phone",
    });
    expect(ids(result.related ?? [], "permit_number")).toEqual(["2014-1 BP"]);
  });
});

describe("owner tools", () => {
  it("finds properties held longer than a number of years", async () => {
    const result = await run("find_long_held_properties", { ...CENTER, min_ownership_years: 10 });

    expect(ids(result.rows, "prop_id")).toEqual(["1", "4"]);
  });

  it("finds properties whose owners live outside the Austin area", async () => {
    const result = await run("find_out_of_area_owners", { ...CENTER, radius_miles: 10 });

    expect(ids(result.rows, "prop_id")).toEqual(["1", "3"]);
  });
});

describe("catalog", () => {
  it("summarizes the published dataset", async () => {
    const result = await run("dataset_summary", {});

    expect(result.rows[0]).toMatchObject({
      build_id: "20261027T130000Z",
      manifest_cid: "bafkrei-manifest",
    });
  });

  it("locates a place by name", async () => {
    const result = await run("locate_place", { name: "Lakeway" });

    expect(result.rows[0]).toMatchObject({ name: "Lakeway", kind: "city" });
  });

  it("describes every tool with a JSON schema for agents and MCP clients", () => {
    const schemas = toolSchemas();

    expect(schemas.map((schema) => schema.name)).toEqual(TOOLS.map((tool) => tool.name));
    const aged = schemas.find((schema) => schema.name === "find_aged_roofs");
    expect(aged?.description).toMatch(/roof/i);
    expect(aged?.inputSchema).toMatchObject({
      type: "object",
      properties: { radius_miles: { type: "number" }, min_roof_age_years: { type: "number" } },
    });
  });

  it("rejects invalid input before running any SQL", async () => {
    await expect(run("find_aged_roofs", { ...CENTER, radius_miles: 500 })).rejects.toThrow(
      ToolInputError,
    );
    await expect(run("no_such_tool", {})).rejects.toThrow(/unknown tool/i);
  });
});
