import { PLACES, type Row, runTool, type ToolResult } from "@travis-oracle/query-core";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Badge, Card, Cid, Disclosure, ErrorNote, Spinner } from "../components/ui.js";
import type { Dataset } from "../data/dataset.js";
import type { Database } from "../data/duckdb.js";
import { formatCount, formatValue } from "../format.js";
import { leadFromPermit, leadFromProperty, withPropertyDetails } from "../leads/lead-input.js";
import { permitKey, propertyKey, useLeads } from "../leads/leads-context.js";
import {
  CandidateKind,
  type MapCandidate,
  type MapCenter,
  ProspectMap,
  type Selection,
} from "../map/ProspectMap.js";
import { datasetInfo } from "./dataset-info.js";

const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
type Confidence = (typeof CONFIDENCE_LEVELS)[number];
const DEFAULT_PLACE = "Austin";
const DEFAULT_RADIUS_MILES = 5;
const MAX_RADIUS_MILES = 30;
const MAX_CANDIDATES = 200;
const DEFAULT_ROOF_AGE = 15;
const DEFAULT_YEARS_OPEN = 5;
const EARLIEST_PERMIT_YEAR = 1900;
const SEARCH_AREA = { south: 29, north: 31, west: -99, east: -96 };
const RELATED_COLUMNS = [
  "permit_number",
  "permit_state",
  "roof_work",
  "issue_date",
  "contractor_name",
  "bbb_rating",
];
const DETAIL_FIELDS = [
  "owner_name",
  "owner_locality",
  "mailing_line1",
  "mailing_city",
  "mailing_state",
  "mailing_zip",
  "ownership_years",
  "deed_date",
  "year_built",
  "roof_covering",
  "roof_age_years",
  "roof_age_anchor",
  "roof_age_anchor_date",
  "roof_age_confidence",
  "market_value",
  "homestead",
  "coordinate_source",
  "source",
];

interface Center extends MapCenter {
  name?: string | undefined;
}

interface Column {
  key: string;
  label: string;
  render?: (row: Row) => ReactNode;
}

const PLACE_OPTIONS = [...PLACES].sort((a, b) => a.name.localeCompare(b.name));
const placeCenter = (name: string): Center => {
  const place = PLACES.find((candidate) => candidate.name === name) ?? PLACES[0];
  return { name: place?.name, latitude: place?.latitude ?? 0, longitude: place?.longitude ?? 0 };
};

const bbb = (row: Row) =>
  row.bbb_rating ? (
    <Badge tone="good">
      {String(row.bbb_rating)} · {String(row.bbb_snapshot_date ?? "")}
    </Badge>
  ) : (
    <span className="muted">–</span>
  );

const ROOF_COLUMNS: Column[] = [
  { key: "situs_address", label: "Address" },
  { key: "roof_age_years", label: "Roof age" },
  { key: "roof_age_anchor", label: "Basis" },
  { key: "roof_age_confidence", label: "Confidence" },
  { key: "owner_name", label: "Owner" },
  { key: "owner_locality", label: "Owner lives" },
  { key: "distance_miles", label: "Miles" },
];
const PERMIT_COLUMNS: Column[] = [
  { key: "permit_number", label: "Permit" },
  { key: "address", label: "Address" },
  { key: "permit_state", label: "State" },
  { key: "years_open", label: "Years open" },
  { key: "open_since", label: "Open since" },
  { key: "contractor_name", label: "Contractor" },
  { key: "bbb_rating", label: "BBB", render: bbb },
  { key: "distance_miles", label: "Miles" },
];

export function ProspectPage({ dataset, database }: { dataset: Dataset; database: Database }) {
  const leads = useLeads();
  const [center, setCenter] = useState<Center>(() => placeCenter(DEFAULT_PLACE));
  const [radius, setRadius] = useState(DEFAULT_RADIUS_MILES);
  const [roofAge, setRoofAge] = useState(DEFAULT_ROOF_AGE);
  const [confidence, setConfidence] = useState<Confidence>("low");
  const [yearsOpen, setYearsOpen] = useState(DEFAULT_YEARS_OPEN);
  const [includeExpired, setIncludeExpired] = useState(true);
  const [issuedSince, setIssuedSince] = useState<number>();
  const [showRoofs, setShowRoofs] = useState(true);
  const [showPermits, setShowPermits] = useState(true);
  const [tab, setTab] = useState(CandidateKind.AgedRoof);
  const [roofs, setRoofs] = useState<ToolResult>();
  const [permits, setPermits] = useState<ToolResult>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [selected, setSelected] = useState<Selection>();
  const [notice, setNotice] = useState<string>();

  const context = useMemo(
    () => ({ sql: database, dataset: datasetInfo(dataset) }),
    [database, dataset],
  );

  useEffect(() => {
    let active = true;
    const near = {
      latitude: center.latitude,
      longitude: center.longitude,
      radius_miles: radius,
      limit: MAX_CANDIDATES,
    };
    setRunning(true);
    setError(undefined);
    setSelected(undefined);
    Promise.all([
      runTool(
        "find_aged_roofs",
        { ...near, min_roof_age_years: roofAge, min_confidence: confidence },
        context,
      ),
      runTool(
        "find_open_roofing_permits",
        {
          ...near,
          min_years_open: yearsOpen,
          include_expired: includeExpired,
          ...(issuedSince && { issued_since_year: issuedSince }),
        },
        context,
      ),
    ]).then(
      ([foundRoofs, foundPermits]) => {
        if (!active) return;
        setRoofs(foundRoofs);
        setPermits(foundPermits);
        setRunning(false);
      },
      (failure: unknown) => {
        if (!active) return;
        setError(failure instanceof Error ? failure.message : String(failure));
        setRunning(false);
      },
    );
    return () => {
      active = false;
    };
  }, [center, radius, roofAge, confidence, yearsOpen, includeExpired, issuedSince, context]);

  const candidates: MapCandidate[] = useMemo(() => {
    const located = (kind: CandidateKind, rows: Row[], key: (row: Row) => string) =>
      rows.flatMap((row, index) =>
        typeof row.latitude === "number" && typeof row.longitude === "number"
          ? [
              {
                kind,
                index,
                latitude: row.latitude,
                longitude: row.longitude,
                saved: leads.savedKeys.has(key(row)),
              },
            ]
          : [],
      );
    return [
      ...(showRoofs
        ? located(CandidateKind.AgedRoof, roofs?.rows ?? [], (row) => propertyKey(row.prop_id))
        : []),
      ...(showPermits
        ? located(CandidateKind.OpenPermit, permits?.rows ?? [], (row) =>
            permitKey(row.permit_number),
          )
        : []),
    ];
  }, [roofs, permits, showRoofs, showPermits, leads.savedKeys]);

  const isSaved = (kind: CandidateKind, row: Row) =>
    kind === CandidateKind.AgedRoof
      ? leads.savedKeys.has(propertyKey(row.prop_id))
      : leads.savedKeys.has(permitKey(row.permit_number));

  const addLead = async (kind: CandidateKind, row: Row) => {
    setNotice(undefined);
    try {
      const propId = Number(row.prop_id);
      const details =
        Number.isFinite(propId) && propId > 0
          ? (await runTool("property_details", { prop_id: propId }, context)).rows[0]
          : undefined;
      const input =
        kind === CandidateKind.AgedRoof
          ? leadFromProperty(row, details, dataset.ref)
          : withPropertyDetails(leadFromPermit(row, dataset.ref), details);
      const { lead, created } = await leads.add(input);
      setNotice(
        created
          ? `Added ${lead.address} to your leads.`
          : `${lead.address} is already a lead; its signals were updated.`,
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const locate = () =>
    navigator.geolocation.getCurrentPosition(
      ({ coords: { latitude, longitude } }) => {
        const inside =
          latitude >= SEARCH_AREA.south &&
          latitude <= SEARCH_AREA.north &&
          longitude >= SEARCH_AREA.west &&
          longitude <= SEARCH_AREA.east;
        if (inside) setCenter({ name: "My location", latitude, longitude });
        else
          setError(
            `Your location (${latitude.toFixed(3)}, ${longitude.toFixed(3)}) is outside Travis County, so the search stays where it is.`,
          );
      },
      () => setError("The browser did not share a location. Drop a pin on the map instead."),
    );

  const select = (selection: Selection) => {
    setSelected(selection);
    setTab(selection.kind);
  };
  const selectedRow =
    selected === undefined
      ? undefined
      : (selected.kind === CandidateKind.AgedRoof ? roofs : permits)?.rows[selected.index];
  const shown = tab === CandidateKind.AgedRoof ? roofs : permits;

  return (
    <div className="page">
      <div className="prospect-layout">
        <Card title="Search area" subtitle="Travis County, TX">
          <div className="controls">
            <label>
              Center on a place
              <select
                value={
                  center.name && PLACES.some((place) => place.name === center.name)
                    ? center.name
                    : ""
                }
                onChange={(event) => setCenter(placeCenter(event.target.value))}
              >
                <option value="" disabled>
                  {center.name ?? "Dropped pin"}
                </option>
                {PLACE_OPTIONS.map((place) => (
                  <option key={place.geoid} value={place.name}>
                    {place.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="button secondary" onClick={locate}>
              Use my location
            </button>
            <p className="muted small">Or click the map to drop a pin.</p>
            <label>
              Radius: <strong>{radius} miles</strong>
              <input
                type="range"
                min={1}
                max={MAX_RADIUS_MILES}
                value={radius}
                onChange={(event) => setRadius(Number(event.target.value))}
              />
            </label>
            <fieldset>
              <legend>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={showRoofs}
                    onChange={(event) => setShowRoofs(event.target.checked)}
                  />
                  <span className="dot aged" /> Aged roofs
                </label>
              </legend>
              <label>
                Older than (years)
                <input
                  type="number"
                  min={0}
                  value={roofAge}
                  onChange={(event) => setRoofAge(Number(event.target.value))}
                />
              </label>
              <label>
                Lowest roof-age confidence
                <select
                  value={confidence}
                  onChange={(event) => setConfidence(event.target.value as Confidence)}
                >
                  <option value="low">low · year built</option>
                  <option value="medium">medium · new-construction permit</option>
                  <option value="high">high · completed reroof permit</option>
                </select>
              </label>
            </fieldset>
            <fieldset>
              <legend>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={showPermits}
                    onChange={(event) => setShowPermits(event.target.checked)}
                  />
                  <span className="dot permit" /> Open roofing permits
                </label>
              </legend>
              <label>
                Open at least (years)
                <input
                  type="number"
                  min={0}
                  value={yearsOpen}
                  onChange={(event) => setYearsOpen(Number(event.target.value))}
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={includeExpired}
                  onChange={(event) => setIncludeExpired(event.target.checked)}
                />
                Include expired without final inspection
              </label>
              <label>
                Issued in or after
                <input
                  type="number"
                  min={EARLIEST_PERMIT_YEAR}
                  max={new Date().getFullYear()}
                  placeholder="any year"
                  value={issuedSince ?? ""}
                  onChange={(event) =>
                    setIssuedSince(event.target.value ? Number(event.target.value) : undefined)
                  }
                />
              </label>
            </fieldset>
          </div>
        </Card>
        <div className="map-panel">
          <ProspectMap
            center={center}
            radiusMiles={radius}
            candidates={candidates}
            selected={selected}
            onPick={(picked) => setCenter({ ...picked, name: undefined })}
            onSelect={select}
          />
          <div className="legend">
            <span>
              <span className="dot aged" /> aged roof
            </span>
            <span>
              <span className="dot permit" /> open permit
            </span>
            <span>
              <span className="dot saved" /> in your leads
            </span>
          </div>
        </div>
      </div>

      {notice && (
        <div className="notice" role="status">
          {notice} <a href="#/leads">Open leads</a>
        </div>
      )}
      {error && <ErrorNote message={error} />}

      <Card
        title="Lead candidates"
        subtitle={
          <>
            Within {radius} miles of {center.name ?? "the pin"} · answered in this browser by
            DuckDB-WASM from dataset <Cid cid={dataset.publication.rootCid} />
          </>
        }
      >
        <div className="tabs-inline" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === CandidateKind.AgedRoof}
            className={tab === CandidateKind.AgedRoof ? "active" : ""}
            onClick={() => setTab(CandidateKind.AgedRoof)}
          >
            Aged roofs {roofs && <Badge>{formatCount(roofs.totalMatches)}</Badge>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === CandidateKind.OpenPermit}
            className={tab === CandidateKind.OpenPermit ? "active" : ""}
            onClick={() => setTab(CandidateKind.OpenPermit)}
          >
            Open roofing permits {permits && <Badge>{formatCount(permits.totalMatches)}</Badge>}
          </button>
        </div>
        {running && <Spinner label="Searching the published dataset…" />}
        {!running && shown && (
          <>
            {(shown.totalMatches ?? 0) > shown.rows.length && (
              <p className="muted small">
                Showing the first {shown.rows.length} of {formatCount(shown.totalMatches)},{" "}
                {tab === CandidateKind.AgedRoof
                  ? "best-evidenced roof ages first"
                  : "longest open first"}
                .
              </p>
            )}
            <CandidateTable
              rows={shown.rows}
              columns={tab === CandidateKind.AgedRoof ? ROOF_COLUMNS : PERMIT_COLUMNS}
              selected={selected?.kind === tab ? selected.index : undefined}
              onSelect={(index) => setSelected({ kind: tab, index })}
              isSaved={(row) => isSaved(tab, row)}
              onAdd={(row) => addLead(tab, row)}
            />
            <Disclosure summary="SQL behind this list">
              <pre className="code-block">{shown.sql}</pre>
            </Disclosure>
          </>
        )}
      </Card>

      {selected && selectedRow && (
        <CandidateDetail
          kind={selected.kind}
          row={selectedRow}
          database={database}
          dataset={dataset}
          saved={isSaved(selected.kind, selectedRow)}
          onAdd={() => addLead(selected.kind, selectedRow)}
        />
      )}
    </div>
  );
}

function CandidateTable({
  rows,
  columns,
  selected,
  onSelect,
  isSaved,
  onAdd,
}: {
  rows: Row[];
  columns: Column[];
  selected: number | undefined;
  onSelect: (index: number) => void;
  isSaved: (row: Row) => boolean;
  onAdd: (row: Row) => void;
}) {
  if (rows.length === 0) return <p className="muted">Nothing matches within this radius.</p>;
  return (
    <div className="table-scroll results">
      <table className="data-table compact">
        <thead>
          <tr>
            <th />
            {columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              // biome-ignore lint/suspicious/noArrayIndexKey: candidates have no stable identity across searches
              key={index}
              className={`selectable${selected === index ? " selected" : ""}`}
              onClick={() => onSelect(index)}
            >
              <td>
                {isSaved(row) ? (
                  <Badge tone="good">lead</Badge>
                ) : (
                  <button
                    type="button"
                    className="small-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onAdd(row);
                    }}
                  >
                    + Lead
                  </button>
                )}
              </td>
              {columns.map((column) => (
                <td key={column.key}>
                  {column.render ? column.render(row) : formatValue(row[column.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CandidateDetail({
  kind,
  row,
  database,
  dataset,
  saved,
  onAdd,
}: {
  kind: CandidateKind;
  row: Row;
  database: Database;
  dataset: Dataset;
  saved: boolean;
  onAdd: () => void;
}) {
  const [detail, setDetail] = useState<ToolResult>();
  const propId = Number(row.prop_id);

  useEffect(() => {
    setDetail(undefined);
    if (!Number.isFinite(propId) || propId <= 0) return;
    runTool(
      "property_details",
      { prop_id: propId },
      { sql: database, dataset: datasetInfo(dataset) },
    ).then(setDetail, () => undefined);
  }, [propId, database, dataset]);

  const property = detail?.rows[0];
  return (
    <Card
      title={String(row.situs_address ?? row.address ?? "Selected candidate")}
      subtitle={
        Number.isFinite(propId) && propId > 0
          ? `TCAD property ${propId}`
          : "Not linked to a TCAD property"
      }
      actions={
        saved ? (
          <Badge tone="good">in your leads</Badge>
        ) : (
          <button type="button" className="button" onClick={onAdd}>
            Add to leads
          </button>
        )
      }
    >
      {kind === CandidateKind.OpenPermit && (
        <div className="permit-summary">
          <h3>Permit {String(row.permit_number)}</h3>
          <dl className="facts">
            <dt>Status</dt>
            <dd>
              <Badge tone="warn">{String(row.permit_state)}</Badge> open{" "}
              {formatValue(row.years_open)} years since {String(row.open_since)}
              {row.past_expiry ? " · past its expiry date" : ""}
            </dd>
            <dt>Work</dt>
            <dd>
              {String(row.roof_work)} · {String(row.description ?? "")}
            </dd>
            <dt>Contractor</dt>
            <dd>
              {String(row.contractor_name ?? "not listed")}
              {row.contractor_phone ? ` · ${String(row.contractor_phone)}` : ""}
            </dd>
            <dt>BBB</dt>
            <dd>
              {row.bbb_rating ? (
                <>
                  <Badge tone="good">{String(row.bbb_rating)}</Badge> as of{" "}
                  {String(row.bbb_snapshot_date)} ({String(row.bbb_match_confidence)} match)
                  {typeof row.bbb_profile_url === "string" && (
                    <>
                      {" "}
                      ·{" "}
                      <a href={row.bbb_profile_url} target="_blank" rel="noreferrer">
                        profile
                      </a>
                    </>
                  )}
                </>
              ) : (
                "no archived BBB grade for this contractor"
              )}
            </dd>
            <dt>Source</dt>
            <dd>
              {typeof row.source_url === "string" ? (
                <a href={row.source_url} target="_blank" rel="noreferrer">
                  City of Austin permit record
                </a>
              ) : (
                String(row.source)
              )}
            </dd>
          </dl>
        </div>
      )}
      {property && (
        <>
          <h3>Property</h3>
          <dl className="facts columns">
            {DETAIL_FIELDS.filter(
              (field) => property[field] !== null && property[field] !== undefined,
            ).map((field) => (
              <div key={field}>
                <dt>{field}</dt>
                <dd>{formatValue(property[field])}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {detail?.related && detail.related.length > 0 && (
        <>
          <h3>Roofing permits at this property</h3>
          <div className="table-scroll">
            <table className="data-table compact">
              <thead>
                <tr>
                  {RELATED_COLUMNS.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detail.related.map((permit) => (
                  <tr key={String(permit.permit_number)}>
                    {RELATED_COLUMNS.map((column) => (
                      <td key={column}>{formatValue(permit[column])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
