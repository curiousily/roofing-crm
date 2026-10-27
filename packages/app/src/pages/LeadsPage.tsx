import { PLACES } from "@travis-oracle/query-core";
import { useEffect, useMemo, useState } from "react";
import {
  type Lead,
  type LeadActivity,
  type LeadFilter,
  LeadPriority,
  LeadSignal,
  LeadStatus,
  matchesFilter,
} from "../../worker/leads/lead.js";
import { Badge, Card, Cid, ErrorNote, type Tone } from "../components/ui.js";
import { formatCount, formatDateTime } from "../format.js";
import { useLeads } from "../leads/leads-context.js";

const STATUSES = Object.values(LeadStatus);
const PRIORITIES = Object.values(LeadPriority);
const ANYWHERE = "";
const DEFAULT_RADIUS_MILES = 5;
const PERMIT_STATES = ["open", "expired"];
const STATUS_TONE: Record<LeadStatus, Tone> = {
  [LeadStatus.New]: "info",
  [LeadStatus.Contacted]: "neutral",
  [LeadStatus.Qualified]: "warn",
  [LeadStatus.Proposal]: "warn",
  [LeadStatus.Won]: "good",
  [LeadStatus.Lost]: "bad",
};
const SIGNAL_LABEL: Record<LeadSignal, string> = {
  [LeadSignal.AgedRoof]: "aged roof",
  [LeadSignal.OpenPermit]: "open permit",
};
const FUTURE_ACTIONS = [
  "Send direct mailer",
  "Create estimate",
  "Schedule roof inspection",
  "Start insurance claim",
];
const PLACE_OPTIONS = [...PLACES].sort((a, b) => a.name.localeCompare(b.name));

export function LeadsPage() {
  const { leads, error } = useLeads();
  const [status, setStatus] = useState<LeadStatus>();
  const [signal, setSignal] = useState<LeadSignal>();
  const [permitState, setPermitState] = useState<string>();
  const [minRoofAge, setMinRoofAge] = useState<number>();
  const [minYearsOpen, setMinYearsOpen] = useState<number>();
  const [place, setPlace] = useState(ANYWHERE);
  const [radius, setRadius] = useState(DEFAULT_RADIUS_MILES);
  const [selectedId, setSelectedId] = useState<string>();

  const filter: LeadFilter = useMemo(() => {
    const center = PLACES.find((candidate) => candidate.name === place);
    return {
      statuses: status ? [status] : undefined,
      signals: signal ? [signal] : undefined,
      permitStates: permitState ? [permitState] : undefined,
      minRoofAgeYears: minRoofAge,
      minYearsOpen,
      near: center
        ? { latitude: center.latitude, longitude: center.longitude, radiusMiles: radius }
        : undefined,
    };
  }, [status, signal, permitState, minRoofAge, minYearsOpen, place, radius]);

  const shown = leads.filter((lead) => matchesFilter(lead, filter));
  const counts = Object.fromEntries(
    STATUSES.map((value) => [value, leads.filter((lead) => lead.status === value).length]),
  );
  const selected = leads.find((lead) => lead.id === selectedId);

  return (
    <div className="page">
      <Card
        title="Leads"
        subtitle="Your pipeline of properties and permits worth a call. Leads are kept per browser workspace."
      >
        <div className="pipeline">
          {STATUSES.map((value) => (
            <button
              key={value}
              type="button"
              className={`stage${status === value ? " active" : ""}`}
              onClick={() => setStatus(status === value ? undefined : value)}
            >
              <span className="stage-label">{value}</span>
              <span className="stage-count">{counts[value]}</span>
            </button>
          ))}
        </div>
        <div className="filters">
          <label>
            Signal
            <select
              value={signal ?? ""}
              onChange={(event) =>
                setSignal((event.target.value || undefined) as LeadSignal | undefined)
              }
            >
              <option value="">any</option>
              {Object.values(LeadSignal).map((value) => (
                <option key={value} value={value}>
                  {SIGNAL_LABEL[value]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Roof age at least
            <input
              type="number"
              min={0}
              placeholder="any"
              value={minRoofAge ?? ""}
              onChange={(event) =>
                setMinRoofAge(event.target.value ? Number(event.target.value) : undefined)
              }
            />
          </label>
          <label>
            Permit status
            <select
              value={permitState ?? ""}
              onChange={(event) => setPermitState(event.target.value || undefined)}
            >
              <option value="">any</option>
              {PERMIT_STATES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            Open at least (years)
            <input
              type="number"
              min={0}
              placeholder="any"
              value={minYearsOpen ?? ""}
              onChange={(event) =>
                setMinYearsOpen(event.target.value ? Number(event.target.value) : undefined)
              }
            />
          </label>
          <label>
            Near
            <select value={place} onChange={(event) => setPlace(event.target.value)}>
              <option value={ANYWHERE}>anywhere</option>
              {PLACE_OPTIONS.map((option) => (
                <option key={option.geoid} value={option.name}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
          {place !== ANYWHERE && (
            <label>
              Within {radius} miles
              <input
                type="range"
                min={1}
                max={30}
                value={radius}
                onChange={(event) => setRadius(Number(event.target.value))}
              />
            </label>
          )}
        </div>
        {error && <ErrorNote message={error} />}
        {leads.length === 0 ? (
          <p className="empty">
            No leads yet. Add candidates from the <a href="#/prospect">prospecting map</a> or the{" "}
            <a href="#/assistant">assistant</a>.
          </p>
        ) : (
          <>
            <p className="muted small">
              {formatCount(shown.length)} of {formatCount(leads.length)} leads match.
            </p>
            <LeadTable leads={shown} selectedId={selectedId} onSelect={setSelectedId} />
          </>
        )}
      </Card>
      {selected && (
        <LeadDetail key={selected.id} lead={selected} onClose={() => setSelectedId(undefined)} />
      )}
    </div>
  );
}

function LeadTable({
  leads,
  selectedId,
  onSelect,
}: {
  leads: Lead[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const { update } = useLeads();
  return (
    <div className="table-scroll results">
      <table className="data-table compact">
        <thead>
          <tr>
            <th>Address</th>
            <th>Signals</th>
            <th>Status</th>
            <th>Priority</th>
            <th>Roof</th>
            <th>Permit</th>
            <th>Contractor · BBB</th>
            <th>Next action</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => (
            <tr
              key={lead.id}
              className={`selectable${lead.id === selectedId ? " selected" : ""}`}
              onClick={() => onSelect(lead.id)}
            >
              <td>
                <strong>{lead.address}</strong>
                {lead.ownerName && <div className="muted small">{lead.ownerName}</div>}
              </td>
              <td>
                {lead.signals.map((value) => (
                  <Badge key={value} tone={value === LeadSignal.AgedRoof ? "warn" : "info"}>
                    {SIGNAL_LABEL[value]}
                  </Badge>
                ))}
              </td>
              <td
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <select
                  aria-label={`Status of ${lead.address}`}
                  value={lead.status}
                  onChange={(event) =>
                    update(lead.id, { status: event.target.value as LeadStatus })
                  }
                >
                  {STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </td>
              <td
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <select
                  aria-label={`Priority of ${lead.address}`}
                  value={lead.priority}
                  onChange={(event) =>
                    update(lead.id, { priority: event.target.value as LeadPriority })
                  }
                >
                  {PRIORITIES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                {lead.roofAgeYears !== undefined
                  ? `${lead.roofAgeYears} y · ${lead.roofAgeConfidence ?? ""}`
                  : "–"}
              </td>
              <td>
                {lead.permitState ? `${lead.permitState} · ${lead.yearsOpen ?? "?"} y open` : "–"}
              </td>
              <td>
                {lead.contractorName ?? "–"}
                {lead.bbbRating && <Badge tone="good">{lead.bbbRating}</Badge>}
              </td>
              <td>{lead.nextActionOn ?? "–"}</td>
              <td className="nowrap">{formatDateTime(lead.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LeadDetail({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const { api, update, remove } = useLeads();
  const [notes, setNotes] = useState(lead.notes);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [activities, setActivities] = useState<LeadActivity[]>([]);
  const [error, setError] = useState<string>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload the history whenever the lead changes
  useEffect(() => {
    api.activities(lead.id).then(setActivities, (failure: unknown) => setError(String(failure)));
  }, [api, lead.id, lead.updatedAt]);

  const save = async (change: Parameters<typeof update>[1]) => {
    try {
      await update(lead.id, change);
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <Card
      title={lead.address}
      subtitle={
        <>
          {lead.propId !== undefined && <>TCAD property {lead.propId} · </>}from dataset build{" "}
          {lead.datasetBuildId} <Cid cid={lead.datasetRootCid} />
        </>
      }
      actions={
        <>
          <button type="button" className="button secondary" onClick={onClose}>
            Close
          </button>
          {confirmingDelete ? (
            <>
              <button
                type="button"
                className="button secondary"
                onClick={() => setConfirmingDelete(false)}
              >
                Keep
              </button>
              <button
                type="button"
                className="button danger"
                onClick={async () => {
                  await remove(lead.id);
                  onClose();
                }}
              >
                Delete for good
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button danger"
              onClick={() => setConfirmingDelete(true)}
            >
              Delete
            </button>
          )}
        </>
      }
    >
      <div className="lead-detail">
        <div>
          <dl className="facts">
            <dt>Status</dt>
            <dd>
              <Badge tone={STATUS_TONE[lead.status]}>{lead.status}</Badge> · priority{" "}
              {lead.priority}
            </dd>
            <dt>Owner</dt>
            <dd>{lead.ownerName ?? "–"}</dd>
            <dt>Mailing address</dt>
            <dd>{lead.mailingAddress ?? "–"}</dd>
            <dt>Roof</dt>
            <dd>
              {lead.roofAgeYears !== undefined
                ? `${lead.roofAgeYears} years, from ${lead.roofAgeAnchor ?? "?"} (${lead.roofAgeConfidence ?? "?"} confidence)`
                : "–"}
            </dd>
            <dt>Permit</dt>
            <dd>
              {lead.permitNumber
                ? `${lead.permitNumber} · ${lead.permitState ?? ""} · open ${lead.yearsOpen ?? "?"} years`
                : "–"}
            </dd>
            <dt>Contractor</dt>
            <dd>
              {lead.contractorName ?? "–"}{" "}
              {lead.bbbRating && <Badge tone="good">BBB {lead.bbbRating}</Badge>}
            </dd>
            <dt>Next action</dt>
            <dd>
              <input
                type="date"
                aria-label="Next action date"
                value={lead.nextActionOn ?? ""}
                onChange={(event) => save({ nextActionOn: event.target.value || null })}
              />
            </dd>
          </dl>
          <label className="notes">
            Notes
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} />
          </label>
          <button
            type="button"
            className="button"
            disabled={notes === lead.notes}
            onClick={() => save({ notes })}
          >
            Save notes
          </button>
          {error && <ErrorNote message={error} />}
          <div className="future-actions">
            <h3>Outreach</h3>
            {FUTURE_ACTIONS.map((action) => (
              <button
                key={action}
                type="button"
                className="button secondary"
                disabled
                title="Coming soon"
              >
                {action} <Badge>soon</Badge>
              </button>
            ))}
          </div>
        </div>
        <div>
          <h3>Activity</h3>
          <ol className="timeline">
            {activities.map((activity, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the history is append-only
              <li key={index}>
                <span className="muted small">{formatDateTime(activity.at)}</span>
                <span>
                  <strong>{activity.kind.replaceAll("_", " ")}</strong> {activity.detail}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </Card>
  );
}
