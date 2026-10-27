import { toolSchemas } from "@travis-oracle/query-core";
import { z } from "zod";
import { LeadSignal, LeadStatus } from "../leads/lead.js";
import type { ToolDefinition } from "./agent-route.js";

export const SEARCH_MY_LEADS = "search_my_leads";

export enum LeadSort {
  Recent = "recent",
  OldestRoof = "oldest_roof",
  LongestOpen = "longest_open",
  Priority = "priority",
  NextAction = "next_action",
}

const DEFAULT_LEADS = 20;
const MAX_LEADS = 50;

export const searchMyLeadsInput = z.object({
  status: z.enum(LeadStatus).optional().describe("Only leads in this pipeline stage."),
  signal: z.enum(LeadSignal).optional().describe("Only leads found through this signal."),
  min_roof_age_years: z
    .number()
    .min(0)
    .optional()
    .describe("Only leads whose roof is at least this old."),
  min_years_open: z
    .number()
    .min(0)
    .optional()
    .describe("Only leads whose roofing permit has been open at least this long."),
  sort: z
    .enum(LeadSort)
    .default(LeadSort.Recent)
    .describe(
      "Order of the leads: oldest_roof finds the oldest roofs, longest_open the longest-open permits, next_action the soonest follow-ups.",
    ),
  limit: z.number().int().positive().max(MAX_LEADS).default(DEFAULT_LEADS),
});

const SEARCH_MY_LEADS_DESCRIPTION =
  "Search the user's own CRM leads (saved properties and permits with their pipeline status, priority, notes and next action).";

export function agentTools(): ToolDefinition[] {
  const datasetTools = toolSchemas().map(({ name, description, inputSchema }) =>
    toolDefinition(name, description, inputSchema),
  );
  return [
    ...datasetTools,
    toolDefinition(
      SEARCH_MY_LEADS,
      SEARCH_MY_LEADS_DESCRIPTION,
      z.toJSONSchema(searchMyLeadsInput, { io: "input" }) as Record<string, unknown>,
    ),
  ];
}

function toolDefinition(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): ToolDefinition {
  const { $schema: _dialect, ...parameters } = inputSchema;
  return { type: "function", function: { name, description, parameters } };
}
