import type {
  ActivityKind,
  Lead,
  LeadActivity,
  LeadChanges,
  LeadPriority,
  LeadSignal,
  LeadStatus,
} from "./lead.js";
import type { LeadRepository } from "./lead-repository.js";

const COLUMNS: [keyof Lead, string][] = [
  ["id", "id"],
  ["workspaceId", "workspace_id"],
  ["propId", "prop_id"],
  ["permitNumber", "permit_number"],
  ["address", "address"],
  ["latitude", "latitude"],
  ["longitude", "longitude"],
  ["ownerName", "owner_name"],
  ["mailingAddress", "mailing_address"],
  ["roofAgeYears", "roof_age_years"],
  ["roofAgeAnchor", "roof_age_anchor"],
  ["roofAgeConfidence", "roof_age_confidence"],
  ["permitState", "permit_state"],
  ["yearsOpen", "years_open"],
  ["contractorName", "contractor_name"],
  ["bbbRating", "bbb_rating"],
  ["hailInches", "hail_inches"],
  ["hailDate", "hail_date"],
  ["signals", "signals"],
  ["status", "status"],
  ["priority", "priority"],
  ["notes", "notes"],
  ["nextActionOn", "next_action_on"],
  ["datasetRootCid", "dataset_root_cid"],
  ["datasetBuildId", "dataset_build_id"],
  ["createdAt", "created_at"],
  ["updatedAt", "updated_at"],
];
const COLUMN_NAMES = COLUMNS.map(([, column]) => column);
const UPSERT = `INSERT INTO leads (${COLUMN_NAMES.join(", ")})
VALUES (${COLUMN_NAMES.map(() => "?").join(", ")})
ON CONFLICT (id) DO UPDATE SET ${COLUMN_NAMES.filter((column) => column !== "id")
  .map((column) => `${column} = excluded.${column}`)
  .join(", ")}`;

type LeadRow = Record<string, string | number | null>;
interface ActivityRow {
  lead_id: string;
  kind: string;
  detail: string;
  at: string;
}

export class D1LeadRepository implements LeadRepository {
  constructor(private readonly db: D1Database) {}

  async list(workspaceId: string): Promise<Lead[]> {
    const { results } = await this.db
      .prepare(
        "SELECT * FROM leads WHERE workspace_id = ? ORDER BY updated_at DESC, created_at DESC, id",
      )
      .bind(workspaceId)
      .all<LeadRow>();
    return results.map(leadOf);
  }

  async get(workspaceId: string, id: string): Promise<Lead | undefined> {
    const row = await this.db
      .prepare("SELECT * FROM leads WHERE workspace_id = ? AND id = ?")
      .bind(workspaceId, id)
      .first<LeadRow>();
    return row ? leadOf(row) : undefined;
  }

  async findBySubject(
    workspaceId: string,
    propId: number | undefined,
    permitNumber: string | undefined,
  ): Promise<Lead | undefined> {
    const statement =
      propId !== undefined
        ? this.db
            .prepare("SELECT * FROM leads WHERE workspace_id = ? AND prop_id = ?")
            .bind(workspaceId, propId)
        : this.db
            .prepare(
              "SELECT * FROM leads WHERE workspace_id = ? AND prop_id IS NULL AND permit_number = ?",
            )
            .bind(workspaceId, permitNumber ?? null);
    const row = await statement.first<LeadRow>();
    return row ? leadOf(row) : undefined;
  }

  async save(lead: Lead, activities: readonly LeadActivity[]): Promise<void> {
    const values = COLUMNS.map(([field]) => {
      const value = lead[field];
      if (field === "signals") return JSON.stringify(value);
      return value ?? null;
    });
    await this.db.batch([
      this.db.prepare(UPSERT).bind(...values),
      ...activities.map((activity) => this.insertActivity(activity)),
    ]);
  }

  async update(
    workspaceId: string,
    id: string,
    changes: LeadChanges,
    activities: readonly LeadActivity[],
  ): Promise<void> {
    const changed = COLUMNS.filter(([field]) => field in changes);
    const assignments = changed.map(([, column]) => `${column} = ?`).join(", ");
    const values = changed.map(([field]) => changes[field as keyof LeadChanges] ?? null);
    await this.db.batch([
      this.db
        .prepare(`UPDATE leads SET ${assignments} WHERE workspace_id = ? AND id = ?`)
        .bind(...values, workspaceId, id),
      ...activities.map((activity) => this.insertActivity(activity)),
    ]);
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          "DELETE FROM lead_activities WHERE lead_id = ? AND lead_id IN (SELECT id FROM leads WHERE workspace_id = ?)",
        )
        .bind(id, workspaceId),
      this.db.prepare("DELETE FROM leads WHERE workspace_id = ? AND id = ?").bind(workspaceId, id),
    ]);
  }

  private insertActivity(activity: LeadActivity): D1PreparedStatement {
    return this.db
      .prepare("INSERT INTO lead_activities (lead_id, kind, detail, at) VALUES (?, ?, ?, ?)")
      .bind(activity.leadId, activity.kind, activity.detail, activity.at);
  }

  async activities(workspaceId: string, leadId: string): Promise<LeadActivity[]> {
    const { results } = await this.db
      .prepare(
        `SELECT activity.lead_id, activity.kind, activity.detail, activity.at
FROM lead_activities activity JOIN leads lead ON lead.id = activity.lead_id
WHERE lead.workspace_id = ? AND activity.lead_id = ?
ORDER BY activity.seq DESC`,
      )
      .bind(workspaceId, leadId)
      .all<ActivityRow>();
    return results.map((row) => ({
      leadId: row.lead_id,
      kind: row.kind as ActivityKind,
      detail: row.detail,
      at: row.at,
    }));
  }
}

function leadOf(row: LeadRow): Lead {
  const entries = COLUMNS.map(([field, column]) => {
    const value = row[column];
    if (field === "signals") return [field, JSON.parse(String(value)) as LeadSignal[]];
    return [field, value ?? undefined];
  });
  const lead = Object.fromEntries(entries) as Lead;
  return {
    ...lead,
    status: lead.status as LeadStatus,
    priority: lead.priority as LeadPriority,
  };
}
