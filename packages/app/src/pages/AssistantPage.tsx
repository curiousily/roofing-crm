import { type Row, runTool, type ToolResult } from "@travis-oracle/query-core";
import { useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SEARCH_MY_LEADS, searchMyLeadsInput } from "../../worker/agent/crm-tools.js";
import {
  type AgentEvent,
  type AgentReply,
  askAgent,
  type ChatMessage,
} from "../agent/agent-loop.js";
import { httpBackend } from "../agent/http-backend.js";
import { Badge, Card, Cid, Disclosure, ErrorNote, Spinner } from "../components/ui.js";
import type { Dataset } from "../data/dataset.js";
import type { Database } from "../data/duckdb.js";
import { formatCount, formatValue } from "../format.js";
import { leadFromPermit, leadFromProperty, withPropertyDetails } from "../leads/lead-input.js";
import { permitKey, propertyKey, useLeads } from "../leads/leads-context.js";
import { datasetInfo } from "./dataset-info.js";

const EXAMPLES = [
  "Show me open roofing permits older than five years within five miles of Pflugerville.",
  "Which properties within three miles of Manor have roofs older than 15 years?",
  "Which of my leads are still new, and what should I follow up on first?",
  "Find long-held properties near Lakeway owned for more than 20 years.",
];
const EVIDENCE_ROWS = 10;
const ROOF_TOOL = "find_aged_roofs";
const PERMIT_TOOL = "find_open_roofing_permits";
const EVIDENCE_COLUMNS: Record<string, string[]> = {
  [ROOF_TOOL]: [
    "situs_address",
    "roof_age_years",
    "roof_age_anchor",
    "roof_age_confidence",
    "owner_name",
    "distance_miles",
  ],
  [PERMIT_TOOL]: [
    "permit_number",
    "address",
    "permit_state",
    "years_open",
    "contractor_name",
    "bbb_rating",
    "distance_miles",
  ],
  find_long_held_properties: ["situs_address", "ownership_years", "owner_name", "distance_miles"],
  find_out_of_area_owners: [
    "situs_address",
    "owner_name",
    "owner_locality",
    "mailing_state",
    "distance_miles",
  ],
  [SEARCH_MY_LEADS]: [
    "address",
    "status",
    "priority",
    "signals",
    "roofAgeYears",
    "yearsOpen",
    "nextActionOn",
  ],
};
const CONVERTIBLE = new Set([ROOF_TOOL, PERMIT_TOOL]);

interface Turn {
  question: string;
  events: AgentEvent[];
  answer?: string;
  error?: string;
  neurons: number;
  steps: number;
  cachedSteps: number;
}

export function AssistantPage({ dataset, database }: { dataset: Dataset; database: Database }) {
  const leads = useLeads();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [budget, setBudget] = useState<AgentReply["budget"] & { model: string }>();
  const history = useRef<ChatMessage[]>([]);
  const context = { sql: database, dataset: datasetInfo(dataset) };

  const updateLast = (change: (turn: Turn) => Turn) =>
    setTurns((current) => [...current.slice(0, -1), change(current.at(-1) as Turn)]);

  const runCrmTool = async (name: string, input: unknown): Promise<ToolResult> => {
    if (name !== SEARCH_MY_LEADS) return runTool(name, input, context);
    const query = searchMyLeadsInput.parse(input ?? {});
    const found = await leads.api.list({
      statuses: query.status ? [query.status] : undefined,
      signals: query.signal ? [query.signal] : undefined,
      minRoofAgeYears: query.min_roof_age_years,
      minYearsOpen: query.min_years_open,
    });
    return {
      tool: SEARCH_MY_LEADS,
      rows: found.slice(0, query.limit) as unknown as Row[],
      totalMatches: found.length,
      sql: "",
      dataset: context.dataset,
    };
  };

  const ask = async (text: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setQuestion("");
    setTurns((current) => [
      ...current,
      { question: text, events: [], neurons: 0, steps: 0, cachedSteps: 0 },
    ]);
    try {
      const outcome = await askAgent(text, history.current, {
        backend: httpBackend((reply) => {
          setBudget({ ...reply.budget, model: reply.model });
          updateLast((turn) => ({
            ...turn,
            steps: turn.steps + 1,
            cachedSteps: turn.cachedSteps + (reply.cached ? 1 : 0),
          }));
        }),
        tools: { run: runCrmTool },
        onEvent: (event) => updateLast((turn) => ({ ...turn, events: [...turn.events, event] })),
      });
      history.current = outcome.messages;
      updateLast((turn) => ({ ...turn, answer: outcome.answer, neurons: outcome.neurons }));
    } catch (failure) {
      updateLast((turn) => ({
        ...turn,
        error: failure instanceof Error ? failure.message : String(failure),
      }));
    } finally {
      setBusy(false);
    }
  };

  const addLead = async (tool: string, row: Row) => {
    const propId = Number(row.prop_id);
    const details =
      Number.isFinite(propId) && propId > 0
        ? (await runTool("property_details", { prop_id: propId }, context)).rows[0]
        : undefined;
    await leads.add(
      tool === ROOF_TOOL
        ? leadFromProperty(row, details, dataset.ref)
        : withPropertyDetails(leadFromPermit(row, dataset.ref), details),
    );
  };
  const isSaved = (tool: string, row: Row) =>
    leads.savedKeys.has(
      tool === ROOF_TOOL ? propertyKey(row.prop_id) : permitKey(row.permit_number),
    );

  return (
    <div className="page">
      <Card
        title="Lead assistant"
        subtitle={
          <>
            Ask in plain language. A Workers AI model chooses the query tools; the tools run here
            over dataset <Cid cid={dataset.publication.rootCid} /> and your leads, and every answer
            shows the rows it used.
          </>
        }
        actions={
          turns.length > 0 && (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => {
                history.current = [];
                setTurns([]);
              }}
            >
              New conversation
            </button>
          )
        }
      >
        {turns.length === 0 && (
          <div className="examples-grid">
            {EXAMPLES.map((example) => (
              <button key={example} type="button" className="example" onClick={() => ask(example)}>
                {example}
              </button>
            ))}
          </div>
        )}
        <div className="conversation">
          {turns.map((turn, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: turns are append-only
            <div className="turn" key={index}>
              <div className="bubble user">{turn.question}</div>
              {turn.events.map((event, eventIndex) => (
                <EventView
                  // biome-ignore lint/suspicious/noArrayIndexKey: events are append-only
                  key={eventIndex}
                  event={event}
                  isSaved={isSaved}
                  onAdd={addLead}
                />
              ))}
              {!turn.answer && !turn.error && <Spinner label="Thinking…" />}
              {turn.error && <ErrorNote message={turn.error} />}
              {turn.answer && (
                <div className="bubble agent">
                  <Markdown remarkPlugins={[remarkGfm]}>{turn.answer}</Markdown>
                  <p className="muted small">
                    {turn.steps} model call{turn.steps === 1 ? "" : "s"}
                    {turn.cachedSteps > 0 && `, ${turn.cachedSteps} from the cache`} ·{" "}
                    {turn.neurons.toFixed(1)} neurons
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
        <form
          className="ask"
          onSubmit={(event) => {
            event.preventDefault();
            ask(question);
          }}
        >
          <input
            aria-label="Question"
            value={question}
            placeholder={
              turns.length ? "Ask a follow-up…" : "Ask about roofing opportunities or your leads…"
            }
            onChange={(event) => setQuestion(event.target.value)}
            disabled={busy}
          />
          <button type="submit" className="button" disabled={busy || !question.trim()}>
            Ask
          </button>
        </form>
        {budget && (
          <p className="muted small">
            {budget.model} · {formatCount(Math.round(budget.used))} of {formatCount(budget.limit)}{" "}
            free neurons used today. Repeated questions answer from the cache at no cost.
          </p>
        )}
      </Card>
    </div>
  );
}

function EventView({
  event,
  isSaved,
  onAdd,
}: {
  event: AgentEvent;
  isSaved: (tool: string, row: Row) => boolean;
  onAdd: (tool: string, row: Row) => Promise<void>;
}) {
  if (event.kind === "answer") return null;
  if (event.kind === "tool_call") {
    return (
      <div className="tool-event">
        <Badge tone="info">tool</Badge> <code>{event.name}</code>{" "}
        <code className="muted">{JSON.stringify(event.input)}</code>
      </div>
    );
  }
  if (event.kind === "tool_error") {
    return (
      <div className="tool-event">
        <Badge tone="warn">tool error</Badge> <code>{event.name}</code> {event.message}
      </div>
    );
  }
  const { result } = event;
  const columns = EVIDENCE_COLUMNS[result.tool] ?? Object.keys(result.rows[0] ?? {});
  const convertible = CONVERTIBLE.has(result.tool);
  return (
    <div className="evidence">
      <p className="small">
        <Badge tone="good">evidence</Badge>{" "}
        {result.totalMatches !== undefined
          ? `${formatCount(result.totalMatches)} matches`
          : `${result.rows.length} rows`}
        {result.center && (
          <>
            {" "}
            around{" "}
            {result.center.name ??
              `${result.center.latitude.toFixed(4)}, ${result.center.longitude.toFixed(4)}`}
          </>
        )}
      </p>
      {result.rows.length > 0 && (
        <div className="table-scroll">
          <table className="data-table compact">
            <thead>
              <tr>
                {convertible && <th />}
                {columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.slice(0, EVIDENCE_ROWS).map((row, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: evidence rows have no stable identity
                <tr key={index}>
                  {convertible && (
                    <td>
                      {isSaved(result.tool, row) ? (
                        <Badge tone="good">lead</Badge>
                      ) : (
                        <button
                          type="button"
                          className="small-button"
                          onClick={() => onAdd(result.tool, row)}
                        >
                          + Lead
                        </button>
                      )}
                    </td>
                  )}
                  {columns.map((column) => (
                    <td key={column}>{formatValue(row[column])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.sql && (
        <Disclosure summary="SQL">
          <pre className="code-block">{result.sql}</pre>
        </Disclosure>
      )}
    </div>
  );
}
