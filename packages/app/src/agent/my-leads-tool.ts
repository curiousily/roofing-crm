import type { DatasetInfo, Row, ToolResult } from "@travis-oracle/query-core";
import { LeadSort, SEARCH_MY_LEADS, searchMyLeadsInput } from "../../worker/agent/crm-tools.js";
import { type Lead, type LeadFilter, LeadPriority } from "../../worker/leads/lead.js";

type LeadsSource = { list(filter?: LeadFilter): Promise<Lead[]> };

const PRIORITY_RANK = [LeadPriority.High, LeadPriority.Medium, LeadPriority.Low];
const UNKNOWN_LAST = Number.NEGATIVE_INFINITY;
const NO_DATE = "9999-12-31";

const COMPARATORS: Record<LeadSort, (a: Lead, b: Lead) => number> = {
  [LeadSort.Recent]: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  [LeadSort.OldestRoof]: (a, b) =>
    (b.roofAgeYears ?? UNKNOWN_LAST) - (a.roofAgeYears ?? UNKNOWN_LAST),
  [LeadSort.LongestOpen]: (a, b) => (b.yearsOpen ?? UNKNOWN_LAST) - (a.yearsOpen ?? UNKNOWN_LAST),
  [LeadSort.Priority]: (a, b) =>
    PRIORITY_RANK.indexOf(a.priority) - PRIORITY_RANK.indexOf(b.priority),
  [LeadSort.NextAction]: (a, b) =>
    (a.nextActionOn ?? NO_DATE).localeCompare(b.nextActionOn ?? NO_DATE),
};

export async function searchMyLeads(
  input: unknown,
  leads: LeadsSource,
  dataset: DatasetInfo,
): Promise<ToolResult> {
  const query = searchMyLeadsInput.parse(input ?? {});
  const found = await leads.list({
    statuses: query.status ? [query.status] : undefined,
    signals: query.signal ? [query.signal] : undefined,
    minRoofAgeYears: query.min_roof_age_years,
    minYearsOpen: query.min_years_open,
  });
  const ordered = [...found].sort(COMPARATORS[query.sort]);
  return {
    tool: SEARCH_MY_LEADS,
    rows: ordered.slice(0, query.limit).map(leadRow),
    totalMatches: found.length,
    sql: "",
    dataset,
  };
}

function leadRow(lead: Lead): Row {
  return {
    id: lead.id,
    address: lead.address,
    owner_name: lead.ownerName ?? null,
    status: lead.status,
    priority: lead.priority,
    signals: lead.signals.join(", "),
    roof_age_years: lead.roofAgeYears ?? null,
    roof_age_confidence: lead.roofAgeConfidence ?? null,
    permit_number: lead.permitNumber ?? null,
    permit_state: lead.permitState ?? null,
    years_open: lead.yearsOpen ?? null,
    contractor_name: lead.contractorName ?? null,
    bbb_rating: lead.bbbRating ?? null,
    hail_inches: lead.hailInches ?? null,
    hail_date: lead.hailDate ?? null,
    next_action_on: lead.nextActionOn ?? null,
    notes: lead.notes || null,
  };
}
