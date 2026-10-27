import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Lead, LeadUpdate, NewLeadInput } from "../../worker/leads/lead.js";
import { LeadsApi } from "./leads-api.js";
import { workspaceId } from "./workspace.js";

interface LeadsState {
  api: LeadsApi;
  leads: Lead[];
  error: string | undefined;
  savedKeys: Set<string>;
  add(input: NewLeadInput): Promise<{ lead: Lead; created: boolean }>;
  addMany(inputs: NewLeadInput[]): Promise<{ lead: Lead; created: boolean }[]>;
  update(id: string, update: LeadUpdate): Promise<Lead>;
  remove(id: string): Promise<void>;
  refresh(): Promise<void>;
}

const LeadsContext = createContext<LeadsState | undefined>(undefined);

export function propertyKey(propId: unknown): string {
  return `property:${String(propId)}`;
}

export function permitKey(permitNumber: unknown): string {
  return `permit:${String(permitNumber)}`;
}

export function LeadsProvider({ children }: { children: ReactNode }) {
  const api = useMemo(() => new LeadsApi((input, init) => fetch(input, init), workspaceId), []);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setLeads(await api.list());
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const savedKeys = useMemo(
    () =>
      new Set(
        leads.flatMap((lead) => [
          ...(lead.propId !== undefined ? [propertyKey(lead.propId)] : []),
          ...(lead.permitNumber !== undefined ? [permitKey(lead.permitNumber)] : []),
        ]),
      ),
    [leads],
  );

  const state: LeadsState = {
    api,
    leads,
    error,
    savedKeys,
    add: async (input) => {
      const result = await api.create(input);
      await refresh();
      return result;
    },
    addMany: async (inputs) => {
      const added = await api.createMany(inputs);
      await refresh();
      return added;
    },
    update: async (id, update) => {
      const lead = await api.update(id, update);
      setLeads((current) => current.map((existing) => (existing.id === id ? lead : existing)));
      return lead;
    },
    remove: async (id) => {
      await api.remove(id);
      setLeads((current) => current.filter((lead) => lead.id !== id));
    },
    refresh,
  };

  return <LeadsContext.Provider value={state}>{children}</LeadsContext.Provider>;
}

export function useLeads(): LeadsState {
  const state = useContext(LeadsContext);
  if (!state) throw new Error("useLeads needs a LeadsProvider");
  return state;
}
