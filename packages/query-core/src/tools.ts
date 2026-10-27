import { z } from "zod";
import { PLACES_SOURCE } from "./places.js";
import { findPlace, ToolInputError } from "./places-lookup.js";
import { type Center, distanceMiles, list, literal, withinBox } from "./sql.js";

export type Row = Record<string, unknown>;

export const TABLES = ["properties", "roofing_permits", "contractors", "permits"] as const;
export type TableName = (typeof TABLES)[number];

export interface SqlRunner {
  all(sql: string): Promise<Row[]>;
}

export interface DatasetInfo {
  buildId: string;
  manifestCid?: string;
  rootCid?: string;
  publishedAt?: string;
  coverage?: unknown;
}

export interface ToolContext {
  sql: SqlRunner;
  dataset: DatasetInfo;
}

export interface ToolResult {
  tool: string;
  rows: Row[];
  related?: Row[];
  totalMatches?: number;
  center?: Center;
  sql: string;
  dataset: DatasetInfo;
}

type ToolOutput = Omit<ToolResult, "tool" | "dataset">;

interface QueryTool<Schema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: Schema;
  run(context: ToolContext, input: z.infer<Schema>): Promise<ToolOutput>;
}

function defineTool<Schema extends z.ZodType>(tool: QueryTool<Schema>): QueryTool {
  return tool;
}

const DEFAULT_RADIUS_MILES = 5;
const MAX_RADIUS_MILES = 30;
const DEFAULT_ROWS = 25;
const MAX_ROWS = 200;
const DEFAULT_ROOF_AGE_YEARS = 15;
const DEFAULT_YEARS_OPEN = 5;
const DEFAULT_OWNERSHIP_YEARS = 10;
const RELATED_ROWS = 10;
const MATCHING_CONTRACTORS = 5;
const DISTANCE_DECIMALS = 2;
const TOTAL_MATCHES = "total_matches";

const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
const ROOF_WORK = ["replacement", "repair", "accessory", "needs_review"] as const;
const NON_LOCAL_OWNERS = ["out_of_state", "regional", "foreign"] as const;
const OWNER_LOCALITIES = ["local", ...NON_LOCAL_OWNERS, "unknown"] as const;
const EXPIRED_STATE = "expired";

const near = {
  place: z
    .string()
    .min(2)
    .optional()
    .describe("A city or community in or near Travis County, for example 'Pflugerville'."),
  latitude: z.number().min(29).max(31).optional().describe("Center latitude (WGS84)."),
  longitude: z.number().min(-99).max(-96).optional().describe("Center longitude (WGS84)."),
  radius_miles: z
    .number()
    .positive()
    .max(MAX_RADIUS_MILES)
    .default(DEFAULT_RADIUS_MILES)
    .describe("Search radius in miles."),
};
const limit = z
  .number()
  .int()
  .positive()
  .max(MAX_ROWS)
  .default(DEFAULT_ROWS)
  .describe("Most rows to return.");

function centerOf({
  place,
  latitude,
  longitude,
}: {
  place?: string | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
}): Center {
  if (place) {
    const found = findPlace(place);
    return { name: found.name, latitude: found.latitude, longitude: found.longitude };
  }
  if (latitude !== undefined && longitude !== undefined) return { latitude, longitude };
  throw new ToolInputError("Give a place or latitude and longitude to search around.");
}

async function nearbyRows(
  context: ToolContext,
  table: string,
  columns: string,
  center: Center,
  radiusMiles: number,
  conditions: string[],
  orderBy: string,
  rows: number,
): Promise<ToolOutput> {
  const sql = `WITH nearby AS (
  SELECT *, ${distanceMiles(center)} AS distance_miles FROM ${table}
  WHERE ${withinBox(center, radiusMiles)}
)
SELECT ${columns}, round(distance_miles, ${DISTANCE_DECIMALS}) AS distance_miles, count(*) OVER () AS ${TOTAL_MATCHES}
FROM nearby
WHERE ${[`distance_miles <= ${radiusMiles}`, ...conditions].join("\n  AND ")}
ORDER BY ${orderBy}
LIMIT ${rows}`;
  const found = await context.sql.all(sql);
  return {
    rows: found.map(({ [TOTAL_MATCHES]: _total, ...row }) => row),
    totalMatches: Number(found[0]?.[TOTAL_MATCHES] ?? 0),
    center,
    sql,
  };
}

const PROPERTY_COLUMNS = `prop_id, situs_address, situs_zip, latitude, longitude, year_built, roof_covering,
  roof_age_years, roof_age_anchor, roof_age_anchor_date, roof_age_anchor_permit, roof_age_confidence,
  owner_name, owner_locality, mailing_state, ownership_years, unfinished_roofing_permits,
  coordinate_source, source, source_run_id`;

const PERMIT_COLUMNS = `permit_number, address, permit_state, roof_work, open_since, years_open, past_expiry,
  issue_date, description, contractor_name, contractor_phone, bbb_rating, bbb_profile_url,
  bbb_snapshot_date, bbb_match_confidence, prop_id, latitude, longitude, source_url, source, source_run_id`;

const findAgedRoofs = defineTool({
  name: "find_aged_roofs",
  description:
    "Find properties whose estimated roof age is above a threshold within a radius, best-evidenced first (completed reroof permit, then new-construction completion, then year built), oldest first within each. Each row gives the roof-age basis and its confidence.",
  input: z.object({
    ...near,
    min_roof_age_years: z
      .number()
      .min(0)
      .default(DEFAULT_ROOF_AGE_YEARS)
      .describe("Only roofs strictly older than this many years."),
    min_confidence: z
      .enum(CONFIDENCE_LEVELS)
      .default("low")
      .describe(
        "Lowest roof-age confidence to include: low = year built only, medium = new-construction permit, high = completed reroof permit.",
      ),
    limit,
  }),
  run: (context, input) => {
    const center = centerOf(input);
    const allowed = CONFIDENCE_LEVELS.slice(CONFIDENCE_LEVELS.indexOf(input.min_confidence));
    return nearbyRows(
      context,
      "properties",
      PROPERTY_COLUMNS,
      center,
      input.radius_miles,
      [`roof_age_years > ${input.min_roof_age_years}`, `roof_age_confidence IN (${list(allowed)})`],
      `list_position([${list([...CONFIDENCE_LEVELS].reverse())}], roof_age_confidence), roof_age_years DESC, distance_miles, prop_id`,
      input.limit,
    );
  },
});

const findOpenRoofingPermits = defineTool({
  name: "find_open_roofing_permits",
  description:
    "Find roofing permits that were never finished (still open, or expired without a final inspection) within a radius, longest open first, with the contractor and its archived BBB grade.",
  input: z.object({
    ...near,
    min_years_open: z
      .number()
      .min(0)
      .default(DEFAULT_YEARS_OPEN)
      .describe("Open at least this many years."),
    include_expired: z
      .boolean()
      .default(true)
      .describe("Include permits that expired without being finaled."),
    roof_work: z.enum(ROOF_WORK).optional().describe("Only this kind of roof work."),
    issued_since_year: z
      .number()
      .int()
      .min(1900)
      .max(2100)
      .optional()
      .describe("Only permits issued in or after this year."),
    limit,
  }),
  run: (context, input) => {
    const conditions = ["unfinished", `years_open >= ${input.min_years_open}`];
    if (!input.include_expired) conditions.push(`permit_state <> ${literal(EXPIRED_STATE)}`);
    if (input.roof_work) conditions.push(`roof_work = ${literal(input.roof_work)}`);
    if (input.issued_since_year) conditions.push(`year(issue_date) >= ${input.issued_since_year}`);
    return nearbyRows(
      context,
      "roofing_permits",
      PERMIT_COLUMNS,
      centerOf(input),
      input.radius_miles,
      conditions,
      "years_open DESC, distance_miles, permit_number",
      input.limit,
    );
  },
});

const propertyDetails = defineTool({
  name: "property_details",
  description:
    "Everything known about one property (by TCAD prop_id): owners, mailing address, roof, roof-age basis, coordinates and its roofing permits.",
  input: z.object({ prop_id: z.number().int().positive().describe("TCAD property id.") }),
  run: async (context, input) => {
    const sql = `SELECT * FROM properties WHERE prop_id = ${input.prop_id}`;
    const relatedSql = `SELECT permit_number, permit_state, roof_work, years_open, issue_date, description, contractor_name, bbb_rating, source_url
FROM roofing_permits WHERE prop_id = ${input.prop_id}
ORDER BY issue_date DESC NULLS LAST, permit_number LIMIT ${RELATED_ROWS}`;
    return {
      rows: await context.sql.all(sql),
      related: await context.sql.all(relatedSql),
      sql: `${sql};\n${relatedSql}`,
    };
  },
});

const contractorDetails = defineTool({
  name: "contractor_details",
  description:
    "Look up roofing contractors by name: names used on permits, phones, permit counts, the archived BBB grade with how it was matched, and recent roofing permits of the best match.",
  input: z.object({
    name: z.string().min(2).describe("Contractor or business name, or part of it."),
  }),
  run: async (context, input) => {
    const term = literal(input.name.trim().toLowerCase());
    const sql = `SELECT * FROM contractors
WHERE contains(lower(contractor_key), ${term})
  OR contains(lower(array_to_string(names, ' | ')), ${term})
  OR contains(lower(coalesce(bbb_business_name, '')), ${term})
ORDER BY roofing_permits DESC, contractor_key LIMIT ${MATCHING_CONTRACTORS}`;
    const rows = await context.sql.all(sql);
    const best = rows[0]?.contractor_key;
    const relatedSql =
      typeof best === "string"
        ? `SELECT permit_number, address, permit_state, roof_work, years_open, issue_date, source_url
FROM roofing_permits WHERE contractor_key = ${literal(best)}
ORDER BY issue_date DESC NULLS LAST, permit_number LIMIT ${RELATED_ROWS}`
        : undefined;
    return {
      rows,
      related: relatedSql ? await context.sql.all(relatedSql) : [],
      sql: relatedSql ? `${sql};\n${relatedSql}` : sql,
    };
  },
});

const findLongHeldProperties = defineTool({
  name: "find_long_held_properties",
  description:
    "Find properties whose current owner has held them longer than a number of years (from the TCAD deed date) within a radius.",
  input: z.object({
    ...near,
    min_ownership_years: z
      .number()
      .min(0)
      .default(DEFAULT_OWNERSHIP_YEARS)
      .describe("Owned strictly longer than this many years."),
    limit,
  }),
  run: (context, input) =>
    nearbyRows(
      context,
      "properties",
      PROPERTY_COLUMNS,
      centerOf(input),
      input.radius_miles,
      [`ownership_years > ${input.min_ownership_years}`],
      "ownership_years DESC, distance_miles, prop_id",
      input.limit,
    ),
});

const findOutOfAreaOwners = defineTool({
  name: "find_out_of_area_owners",
  description:
    "Find properties whose owner's mailing address is outside the Austin area: regional (elsewhere in Texas), out of state or foreign.",
  input: z.object({
    ...near,
    localities: z
      .array(z.enum(OWNER_LOCALITIES))
      .min(1)
      .default([...NON_LOCAL_OWNERS])
      .describe("Owner localities to include."),
    limit,
  }),
  run: (context, input) =>
    nearbyRows(
      context,
      "properties",
      PROPERTY_COLUMNS,
      centerOf(input),
      input.radius_miles,
      [`owner_locality IN (${list(input.localities)})`],
      "distance_miles, prop_id",
      input.limit,
    ),
});

const locatePlace = defineTool({
  name: "locate_place",
  description:
    "Coordinates of a city or community in or near Travis County (Census internal point).",
  input: z.object({ name: z.string().min(2).describe("Place name.") }),
  run: async (_context, input) => {
    const place = findPlace(input.name);
    return { rows: [{ ...place, source: PLACES_SOURCE }], sql: "" };
  },
});

const datasetSummary = defineTool({
  name: "dataset_summary",
  description:
    "What dataset answers come from: build id, IPFS manifest and root CIDs, publication time and coverage counts.",
  input: z.object({}),
  run: async (context) => ({
    rows: [
      {
        build_id: context.dataset.buildId,
        manifest_cid: context.dataset.manifestCid ?? null,
        root_cid: context.dataset.rootCid ?? null,
        published_at: context.dataset.publishedAt ?? null,
        coverage: context.dataset.coverage ?? null,
      },
    ],
    sql: "",
  }),
});

export const TOOLS = [
  findAgedRoofs,
  findOpenRoofingPermits,
  propertyDetails,
  contractorDetails,
  findLongHeldProperties,
  findOutOfAreaOwners,
  locatePlace,
  datasetSummary,
];

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function toolSchemas(): ToolSchema[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown>,
  }));
}

export async function runTool(
  name: string,
  rawInput: unknown,
  context: ToolContext,
): Promise<ToolResult> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new ToolInputError(`Unknown tool "${name}".`);
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw new ToolInputError(`Invalid input for ${name}: ${z.prettifyError(parsed.error)}`);
  }
  const output = await tool.run(context, parsed.data);
  return { tool: name, dataset: context.dataset, ...output };
}
