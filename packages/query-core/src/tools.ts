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
  summary?: Record<string, number>;
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
  nearby?(input: z.infer<Schema>): NearbyQuery;
}

interface NearbyTool<Schema extends z.ZodType> {
  name: string;
  description: string;
  input: Schema;
  nearby(input: z.infer<Schema>): NearbyQuery;
}

export interface DensityCell {
  latitude: number;
  longitude: number;
  matches: number;
}

function defineTool<Schema extends z.ZodType>(tool: QueryTool<Schema>): QueryTool {
  return tool;
}

function defineNearbyTool<Schema extends z.ZodType>(tool: NearbyTool<Schema>): QueryTool {
  return defineTool<Schema>({
    ...tool,
    run: (context, input) => nearbyRows(context, tool.nearby(input)),
  });
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
const SUMMARY_PREFIX = "summary__";

const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
const ROOF_WORK = ["replacement", "repair", "accessory", "needs_review"] as const;
const NON_LOCAL_OWNERS = ["out_of_state", "regional", "foreign"] as const;
const OWNER_LOCALITIES = ["local", ...NON_LOCAL_OWNERS, "unknown"] as const;
const EXPIRED_STATE = "expired";
const OPEN_STATE = "open";
const ACCESSORY_WORK = "accessory";

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

interface NearbyQuery {
  table: string;
  columns: string;
  center: Center;
  radiusMiles: number;
  conditions: string[];
  orderBy: string;
  rows: number;
  summary: Record<string, string>;
}

async function nearbyRows(
  context: ToolContext,
  { table, columns, center, radiusMiles, conditions, orderBy, rows, summary }: NearbyQuery,
): Promise<ToolOutput> {
  const summaryColumns = Object.entries(summary).map(
    ([name, condition]) =>
      `count(CASE WHEN ${condition} THEN 1 END) OVER () AS ${SUMMARY_PREFIX}${name}`,
  );
  const sql = `WITH nearby AS (
  SELECT *, ${distanceMiles(center)} AS distance_miles FROM ${table}
  WHERE ${withinBox(center, radiusMiles)}
)
SELECT ${columns}, round(distance_miles, ${DISTANCE_DECIMALS}) AS distance_miles,
  ${[`count(*) OVER () AS ${TOTAL_MATCHES}`, ...summaryColumns].join(",\n  ")}
FROM nearby
WHERE ${[`distance_miles <= ${radiusMiles}`, ...conditions].join("\n  AND ")}
ORDER BY ${orderBy}
LIMIT ${rows}`;
  const found = await context.sql.all(sql);
  const first = found[0] ?? {};
  return {
    rows: found.map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(
          ([column]) => column !== TOTAL_MATCHES && !column.startsWith(SUMMARY_PREFIX),
        ),
      ),
    ),
    totalMatches: Number(first[TOTAL_MATCHES] ?? 0),
    summary: Object.fromEntries(
      Object.keys(summary).map((name) => [name, Number(first[`${SUMMARY_PREFIX}${name}`] ?? 0)]),
    ),
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

const findAgedRoofs = defineNearbyTool({
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
  nearby: (input) => {
    const center = centerOf(input);
    const allowed = CONFIDENCE_LEVELS.slice(CONFIDENCE_LEVELS.indexOf(input.min_confidence));
    return {
      table: "properties",
      columns: PROPERTY_COLUMNS,
      center,
      radiusMiles: input.radius_miles,
      conditions: [
        `roof_age_years > ${input.min_roof_age_years}`,
        `roof_age_confidence IN (${list(allowed)})`,
      ],
      orderBy: `list_position([${list([...CONFIDENCE_LEVELS].reverse())}], roof_age_confidence), roof_age_years DESC, distance_miles, prop_id`,
      rows: input.limit,
      summary: Object.fromEntries(
        [...CONFIDENCE_LEVELS]
          .reverse()
          .map((level) => [`${level}_confidence`, `roof_age_confidence = ${literal(level)}`]),
      ),
    };
  },
});

const findOpenRoofingPermits = defineNearbyTool({
  name: "find_open_roofing_permits",
  description:
    "Find roofing permits that are still open within a radius, longest open first, with the contractor and its archived BBB grade. Optionally also never-finished permits that expired without a final inspection. summary counts all matches.",
  input: z.object({
    ...near,
    min_years_open: z
      .number()
      .min(0)
      .default(DEFAULT_YEARS_OPEN)
      .describe("Open at least this many years."),
    include_expired: z
      .boolean()
      .default(false)
      .describe(
        "Also include permits that expired without a final inspection (never finished, but no longer open).",
      ),
    include_accessory: z
      .boolean()
      .default(false)
      .describe("Also include accessory roof work such as patio covers, carports and sheds."),
    roof_work: z.enum(ROOF_WORK).optional().describe("Only this kind of roof work."),
    issued_since_year: z
      .number()
      .int()
      .min(1900)
      .max(2100)
      .optional()
      .describe("Only permits issued in or after this year."),
    with_contractor: z
      .boolean()
      .default(false)
      .describe(
        "Only permits that list a contractor. Use it when the user asks who the contractor is; summary.with_contractor counts them among all matches.",
      ),
    limit,
  }),
  nearby: (input) => {
    const conditions = ["unfinished", `years_open >= ${input.min_years_open}`];
    if (input.with_contractor) conditions.push("contractor_name IS NOT NULL");
    if (!input.include_expired) conditions.push(`permit_state <> ${literal(EXPIRED_STATE)}`);
    if (!input.include_accessory) conditions.push(`roof_work <> ${literal(ACCESSORY_WORK)}`);
    if (input.roof_work) conditions.push(`roof_work = ${literal(input.roof_work)}`);
    if (input.issued_since_year) conditions.push(`year(issue_date) >= ${input.issued_since_year}`);
    return {
      table: "roofing_permits",
      columns: PERMIT_COLUMNS,
      center: centerOf(input),
      radiusMiles: input.radius_miles,
      conditions,
      orderBy: "years_open DESC, distance_miles, permit_number",
      rows: input.limit,
      summary: {
        still_open: `permit_state = ${literal(OPEN_STATE)}`,
        expired_without_final: `permit_state = ${literal(EXPIRED_STATE)}`,
        with_contractor: "contractor_name IS NOT NULL",
        with_bbb_rating: "bbb_rating IS NOT NULL",
      },
    };
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

const findLongHeldProperties = defineNearbyTool({
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
  nearby: (input) => ({
    table: "properties",
    columns: PROPERTY_COLUMNS,
    center: centerOf(input),
    radiusMiles: input.radius_miles,
    conditions: [`ownership_years > ${input.min_ownership_years}`],
    orderBy: "ownership_years DESC, distance_miles, prop_id",
    rows: input.limit,
    summary: Object.fromEntries(
      NON_LOCAL_OWNERS.map((locality) => [
        `${locality}_owners`,
        `owner_locality = ${literal(locality)}`,
      ]),
    ),
  }),
});

const findOutOfAreaOwners = defineNearbyTool({
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
  nearby: (input) => ({
    table: "properties",
    columns: PROPERTY_COLUMNS,
    center: centerOf(input),
    radiusMiles: input.radius_miles,
    conditions: [`owner_locality IN (${list(input.localities)})`],
    orderBy: "distance_miles, prop_id",
    rows: input.limit,
    summary: Object.fromEntries(
      input.localities.map((locality) => [locality, `owner_locality = ${literal(locality)}`]),
    ),
  }),
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
  const tool = toolNamed(name);
  const output = await tool.run(context, parsedInput(tool, rawInput));
  return { tool: name, dataset: context.dataset, ...output };
}

export async function matchDensity(
  name: string,
  rawInput: unknown,
  context: ToolContext,
  cellDegrees: number,
): Promise<DensityCell[]> {
  const tool = toolNamed(name);
  if (!tool.nearby) throw new ToolInputError(`${name} is not a radius search.`);
  const { table, center, radiusMiles, conditions } = tool.nearby(parsedInput(tool, rawInput));
  const cell = (column: string) => `round(${column} / ${cellDegrees}) * ${cellDegrees}`;
  const found = await context.sql.all(`WITH nearby AS (
  SELECT *, ${distanceMiles(center)} AS distance_miles FROM ${table}
  WHERE ${withinBox(center, radiusMiles)}
)
SELECT ${cell("latitude")} AS latitude, ${cell("longitude")} AS longitude, count(*) AS matches
FROM nearby
WHERE ${[`distance_miles <= ${radiusMiles}`, ...conditions].join("\n  AND ")}
GROUP BY ALL
ORDER BY matches DESC, latitude, longitude`);
  return found.map((row) => ({
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    matches: Number(row.matches),
  }));
}

function toolNamed(name: string): QueryTool {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new ToolInputError(`Unknown tool "${name}".`);
  return tool;
}

function parsedInput(tool: QueryTool, rawInput: unknown): unknown {
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw new ToolInputError(`Invalid input for ${tool.name}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
