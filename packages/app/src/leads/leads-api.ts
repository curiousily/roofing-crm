import type {
  Lead,
  LeadActivity,
  LeadFilter,
  LeadUpdate,
  NewLeadInput,
} from "../../worker/leads/lead.js";

const LEADS_PATH = "/api/leads";
const BATCH_PATH = "/batch";
const WORKSPACE_HEADER = "x-workspace-id";
const LIST_SEPARATOR = ",";
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;

export class LeadsApi {
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly workspace: () => string,
  ) {}

  async list(filter: LeadFilter = {}): Promise<Lead[]> {
    const query = new URLSearchParams();
    const add = (key: string, value: string | number | undefined) => {
      if (value !== undefined) query.set(key, String(value));
    };
    add("status", filter.statuses?.join(LIST_SEPARATOR));
    add("signal", filter.signals?.join(LIST_SEPARATOR));
    add("permit_state", filter.permitStates?.join(LIST_SEPARATOR));
    add("min_roof_age", filter.minRoofAgeYears);
    add("min_years_open", filter.minYearsOpen);
    add("latitude", filter.near?.latitude);
    add("longitude", filter.near?.longitude);
    add("radius_miles", filter.near?.radiusMiles);
    const search = query.toString();
    return (await this.send(`${LEADS_PATH}${search ? `?${search}` : ""}`)).json();
  }

  async create(input: NewLeadInput): Promise<{ lead: Lead; created: boolean }> {
    const response = await this.send(LEADS_PATH, { method: "POST", body: JSON.stringify(input) });
    return { lead: await response.json(), created: response.status === HTTP_CREATED };
  }

  async createMany(inputs: NewLeadInput[]): Promise<{ lead: Lead; created: boolean }[]> {
    const body = JSON.stringify({ leads: inputs });
    return (await this.send(`${LEADS_PATH}${BATCH_PATH}`, { method: "POST", body })).json();
  }

  async update(id: string, update: LeadUpdate): Promise<Lead> {
    return (
      await this.send(`${LEADS_PATH}/${id}`, { method: "PATCH", body: JSON.stringify(update) })
    ).json();
  }

  async remove(id: string): Promise<void> {
    await this.send(`${LEADS_PATH}/${id}`, { method: "DELETE" });
  }

  async activities(id: string): Promise<LeadActivity[]> {
    return (await this.send(`${LEADS_PATH}/${id}/activities`)).json();
  }

  private async send(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetchImpl(path, {
      ...init,
      headers: { "content-type": "application/json", [WORKSPACE_HEADER]: this.workspace() },
    });
    if (!response.ok && response.status !== HTTP_NO_CONTENT) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `${path} answered ${response.status}`);
    }
    return response;
  }
}
