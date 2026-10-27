import { AgentRoute, type ChatCompletion, type ChatModel } from "./agent/agent-route.js";
import { CRM_AGENT_PROMPT } from "./agent/crm-agent-prompt.js";
import { agentTools } from "./agent/crm-tools.js";
import { D1LeadRepository } from "./leads/d1-lead-repository.js";
import { leadRoutes } from "./leads/lead-routes.js";

interface Env {
  ASSETS: Fetcher;
  DATASET: Fetcher;
  DB: D1Database;
  AGENT_STORE: KVNamespace;
  AI: Ai;
  AGENT_MODEL: string;
  AGENT_DAILY_NEURONS: string;
}

const APP = "crm";
const ISO_DATE_LENGTH = 10;
const TOOLS = agentTools();

enum Route {
  Leads = "/api/leads",
  Agent = "/api/agent",
  AgentBudget = "/api/agent/budget",
  Publications = "/api/publications",
  Ipfs = "/ipfs/",
}

function agentOf(env: Env): AgentRoute {
  const model: ChatModel = async (request) =>
    (await env.AI.run(
      env.AGENT_MODEL as Parameters<Ai["run"]>[0],
      request as never,
    )) as unknown as ChatCompletion;
  return new AgentRoute({
    model,
    modelName: env.AGENT_MODEL,
    store: env.AGENT_STORE,
    app: APP,
    dailyNeurons: Number(env.AGENT_DAILY_NEURONS),
    today: () => new Date().toISOString().slice(0, ISO_DATE_LENGTH),
    systemPrompt: CRM_AGENT_PROMPT,
    tools: TOOLS,
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === Route.Leads || pathname.startsWith(`${Route.Leads}/`)) {
      return leadRoutes({
        repository: new D1LeadRepository(env.DB),
        now: () => new Date().toISOString(),
        newId: () => crypto.randomUUID(),
      }).fetch(request);
    }
    if (pathname === Route.AgentBudget) return agentOf(env).budget();
    if (pathname === Route.Agent && request.method === "POST") return agentOf(env).handle(request);
    if (pathname === Route.Publications || pathname.startsWith(Route.Ipfs)) {
      return env.DATASET.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
