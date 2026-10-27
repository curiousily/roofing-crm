import type { Lead, LeadActivity, LeadChanges } from "./lead.js";

export interface LeadRepository {
  list(workspaceId: string): Promise<Lead[]>;
  get(workspaceId: string, id: string): Promise<Lead | undefined>;
  findBySubject(
    workspaceId: string,
    propId: number | undefined,
    permitNumber: string | undefined,
  ): Promise<Lead | undefined>;
  save(lead: Lead, activities: readonly LeadActivity[]): Promise<void>;
  update(
    workspaceId: string,
    id: string,
    changes: LeadChanges,
    activities: readonly LeadActivity[],
  ): Promise<void>;
  delete(workspaceId: string, id: string): Promise<void>;
  activities(workspaceId: string, leadId: string): Promise<LeadActivity[]>;
}
