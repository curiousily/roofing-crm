import {
  applyUpdate,
  type Lead,
  type LeadActivity,
  type LeadFilter,
  type LeadUpdate,
  matchesFilter,
  mergeLead,
  type NewLeadInput,
  newLead,
} from "./lead.js";
import type { LeadRepository } from "./lead-repository.js";

export interface LeadServiceDependencies {
  repository: LeadRepository;
  now: () => string;
  newId: () => string;
}

export interface CreatedLead {
  lead: Lead;
  created: boolean;
}

export class LeadService {
  constructor(private readonly dependencies: LeadServiceDependencies) {}

  async list(workspaceId: string, filter: LeadFilter): Promise<Lead[]> {
    const leads = await this.dependencies.repository.list(workspaceId);
    return leads.filter((lead) => matchesFilter(lead, filter));
  }

  async create(workspaceId: string, input: NewLeadInput): Promise<CreatedLead> {
    const { repository, now, newId } = this.dependencies;
    const existing = await repository.findBySubject(workspaceId, input.propId, input.permitNumber);
    const change = existing
      ? mergeLead(existing, input, now())
      : newLead(newId(), workspaceId, input, now());
    if (change.activities.length > 0) await repository.save(change.lead, change.activities);
    return { lead: change.lead, created: existing === undefined };
  }

  async update(workspaceId: string, id: string, update: LeadUpdate): Promise<Lead | undefined> {
    const { repository, now } = this.dependencies;
    const lead = await repository.get(workspaceId, id);
    if (!lead) return undefined;
    const edit = applyUpdate(lead, update, now());
    if (edit.activities.length === 0) return lead;
    await repository.update(workspaceId, id, edit.changes, edit.activities);
    return repository.get(workspaceId, id);
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    const { repository } = this.dependencies;
    if (!(await repository.get(workspaceId, id))) return false;
    await repository.delete(workspaceId, id);
    return true;
  }

  async activities(workspaceId: string, id: string): Promise<LeadActivity[] | undefined> {
    const { repository } = this.dependencies;
    if (!(await repository.get(workspaceId, id))) return undefined;
    return repository.activities(workspaceId, id);
  }
}
