import {
  type DensityCell,
  matchDensity,
  PLACES,
  type Row,
  runTool,
  type ToolResult,
  ZIP_CODES,
} from "@travis-oracle/query-core";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { DatasetRef, NewLeadInput } from "../../worker/leads/lead.js";
import { Badge, Card, Cid, Disclosure, ErrorNote, Spinner } from "../components/ui.js";
import type { Dataset } from "../data/dataset.js";
import type { Database } from "../data/duckdb.js";
import { formatCount, formatValue } from "../format.js";
import { labelOf } from "../labels.js";
import {
  leadFromHail,
  leadFromPermit,
  leadFromProperty,
  leadsFromTopLead,
  withPropertyDetails,
} from "../leads/lead-input.js";
import { permitKey, propertyKey, useLeads } from "../leads/leads-context.js";
import { isInTravisCounty } from "../map/in-county.js";
import {
  CandidateKind,
  type MapCandidate,
  type MapCenter,
  type MapDensityCell,
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
const DEFAULT_HAIL_INCHES = 1;
const DEFAULT_HAIL_YEARS = 3;
const HAIL_INCHES_STEP = 0.25;
const MAX_HAIL_YEARS = 25;
const EARLIEST_PERMIT_YEAR = 1900;
const MILES_PER_DEGREE = 69;
const DENSITY_CELLS_ACROSS = 25;
const MAX_BATCH = 50;
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
  "owner_properties",
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

interface KindSpec {
  kind: CandidateKind;
  label: string;
  dot: string;
  tool: string;
  order: string;
  columns: Column[];
  keyOf: (row: Row) => string;
  leadsOf: (row: Row, details: Row | undefined, dataset: DatasetRef) => NewLeadInput[];
}

const CENTERS = [...PLACES, ...ZIP_CODES];
const PLACE_OPTIONS = [...PLACES].sort((a, b) => a.name.localeCompare(b.name));
const centerOf = (name: string): Center => {
  const place = CENTERS.find((candidate) => candidate.name === name) ?? PLACES[0];
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
const score = (row: Row) => <strong>{formatValue(row.lead_score)}</strong>;

const KINDS: KindSpec[] = [
  {
    kind: CandidateKind.AgedRoof,
    label: "Aged roofs",
    dot: "aged",
    tool: "find_aged_roofs",
    order: "best-evidenced roof ages first",
    columns: [
      { key: "situs_address", label: "Address" },
      { key: "roof_age_years", label: "Roof age" },
      { key: "roof_age_anchor", label: "Basis" },
      { key: "roof_age_confidence", label: "Confidence" },
      { key: "owner_name", label: "Owner" },
      { key: "owner_locality", label: "Owner lives" },
      { key: "distance_miles", label: "Miles" },
    ],
    keyOf: (row) => propertyKey(row.prop_id),
    leadsOf: (row, details, dataset) => [leadFromProperty(row, details, dataset)],
  },
  {
    kind: CandidateKind.OpenPermit,
    label: "Open roofing permits",
    dot: "permit",
    tool: "find_open_roofing_permits",
    order: "longest open first",
    columns: [
      { key: "permit_number", label: "Permit" },
      { key: "address", label: "Address" },
      { key: "permit_state", label: "State" },
      { key: "years_open", label: "Years open" },
      { key: "open_since", label: "Open since" },
      { key: "contractor_name", label: "Contractor" },
      { key: "bbb_rating", label: "BBB", render: bbb },
      { key: "distance_miles", label: "Miles" },
    ],
    keyOf: (row) => permitKey(row.permit_number),
    leadsOf: (row, details, dataset) => [
      withPropertyDetails(leadFromPermit(row, dataset), details),
    ],
  },
  {
    kind: CandidateKind.Hail,
    label: "Recent hail",
    dot: "hail",
    tool: "find_hail_hit_roofs",
    order: "largest hail first",
    columns: [
      { key: "situs_address", label: "Address" },
      { key: "max_hail_inches", label: "Hail (in)" },
      { key: "last_hail_date", label: "Latest report" },
      { key: "hail_reports", label: "Reports" },
      { key: "roof_age_years", label: "Roof age" },
      { key: "roof_age_anchor", label: "Basis" },
      { key: "owner_name", label: "Owner" },
      { key: "distance_miles", label: "Miles" },
    ],
    keyOf: (row) => propertyKey(row.prop_id),
    leadsOf: (row, details, dataset) => [leadFromHail(row, details, dataset)],
  },
  {
    kind: CandidateKind.TopLead,
    label: "Top leads",
    dot: "top",
    tool: "find_top_leads",
    order: "highest lead score first",
    columns: [
      { key: "situs_address", label: "Address" },
      { key: "lead_score", label: "Score", render: score },
      { key: "roof_points", label: "Roof pts" },
      { key: "permit_points", label: "Permit pts" },
      { key: "hail_points", label: "Hail pts" },
      { key: "roof_age_years", label: "Roof age" },
      { key: "max_years_open", label: "Years open" },
      { key: "max_hail_inches", label: "Hail (in)" },
      { key: "owner_name", label: "Owner" },
      { key: "distance_miles", label: "Miles" },
    ],
    keyOf: (row) => propertyKey(row.prop_id),
    leadsOf: leadsFromTopLead,
  },
];
const SPECS = Object.fromEntries(KINDS.map((spec) => [spec.kind, spec])) as Record<
  CandidateKind,
  KindSpec
>;
const INITIALLY_VISIBLE: Record<CandidateKind, boolean> = {
  [CandidateKind.AgedRoof]: true,
  [CandidateKind.OpenPermit]: true,
  [CandidateKind.Hail]: false,
  [CandidateKind.TopLead]: false,
};

export function ProspectPage({ dataset, database }: { dataset: Dataset; database: Database }) {
  const leads = useLeads();
  const [center, setCenter] = useState<Center>(() => centerOf(DEFAULT_PLACE));
  const [radius, setRadius] = useState(DEFAULT_RADIUS_MILES);
  const [roofAge, setRoofAge] = useState(DEFAULT_ROOF_AGE);
  const [confidence, setConfidence] = useState<Confidence>("low");
  const [yearsOpen, setYearsOpen] = useState(DEFAULT_YEARS_OPEN);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [includeAccessory, setIncludeAccessory] = useState(false);
  const [withContractor, setWithContractor] = useState(false);
  const [issuedSince, setIssuedSince] = useState<number>();
  const [hailInches, setHailInches] = useState(DEFAULT_HAIL_INCHES);
  const [hailYears, setHailYears] = useState(DEFAULT_HAIL_YEARS);
  const [visible, setVisible] = useState(INITIALLY_VISIBLE);
  const [density, setDensity] = useState<MapDensityCell[]>([]);
  const [tab, setTab] = useState(CandidateKind.AgedRoof);
  const [results, setResults] = useState<Partial<Record<CandidateKind, ToolResult>>>({});
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [adding, setAdding] = useState(false);
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
    const hail = { ...near, min_hail_inches: hailInches, within_years: hailYears };
    const inputs: Record<CandidateKind, object> = {
      [CandidateKind.AgedRoof]: {
        ...near,
        min_roof_age_years: roofAge,
        min_confidence: confidence,
      },
      [CandidateKind.OpenPermit]: {
        ...near,
        min_years_open: yearsOpen,
        include_expired: includeExpired,
        include_accessory: includeAccessory,
        with_contractor: withContractor,
        ...(issuedSince && { issued_since_year: issuedSince }),
      },
      [CandidateKind.Hail]: hail,
      [CandidateKind.TopLead]: hail,
    };
    const cellDegrees = radius / MILES_PER_DEGREE / DENSITY_CELLS_ACROSS;
    setRunning(true);
    setError(undefined);
    setSelected(undefined);
    setChecked(new Set());
    Promise.all(
      KINDS.map(async ({ kind, tool }) => {
        const result = await runTool(tool, inputs[kind], context);
        const cells: DensityCell[] = await matchDensity(tool, inputs[kind], context, cellDegrees);
        return { kind, result, cells: cells.map((cell) => ({ ...cell, kind })) };
      }),
    ).then(
      (found) => {
        if (!active) return;
        setResults(Object.fromEntries(found.map(({ kind, result }) => [kind, result])));
        setDensity(found.flatMap(({ cells }) => cells));
        setRunning(false);
      },
      (failure: unknown) => {
        if (!active) return;
        setResults({});
        setDensity([]);
        setError(failure instanceof Error ? failure.message : String(failure));
        setRunning(false);
      },
    );
    return () => {
      active = false;
    };
  }, [
    center,
    radius,
    roofAge,
    confidence,
    yearsOpen,
    includeExpired,
    includeAccessory,
    withContractor,
    issuedSince,
    hailInches,
    hailYears,
    context,
  ]);

  const candidates: MapCandidate[] = useMemo(
    () =>
      KINDS.filter(({ kind }) => visible[kind]).flatMap(({ kind, keyOf }) =>
        (results[kind]?.rows ?? []).flatMap((row, index) =>
          typeof row.latitude === "number" && typeof row.longitude === "number"
            ? [
                {
                  kind,
                  index,
                  latitude: row.latitude,
                  longitude: row.longitude,
                  saved: leads.savedKeys.has(keyOf(row)),
                },
              ]
            : [],
        ),
      ),
    [results, visible, leads.savedKeys],
  );

  const isSaved = (kind: CandidateKind, row: Row) => leads.savedKeys.has(SPECS[kind].keyOf(row));

  const leadsOf = async (kind: CandidateKind, row: Row): Promise<NewLeadInput[]> => {
    const propId = Number(row.prop_id);
    const details =
      Number.isFinite(propId) && propId > 0
        ? (await runTool("property_details", { prop_id: propId }, context)).rows[0]
        : undefined;
    return SPECS[kind].leadsOf(row, details, dataset.ref);
  };

  const addLeads = async (kind: CandidateKind, rows: Row[]) => {
    setNotice(undefined);
    setAdding(true);
    try {
      const inputs = (await Promise.all(rows.map((row) => leadsOf(kind, row)))).flat();
      const added = [];
      for (let start = 0; start < inputs.length; start += MAX_BATCH) {
        added.push(...(await leads.addMany(inputs.slice(start, start + MAX_BATCH))));
      }
      const created = new Set(added.filter((one) => one.created).map((one) => one.lead.id));
      const updated = new Set(added.map((one) => one.lead.id)).size - created.size;
      setNotice(
        rows.length === 1 && added[0]
          ? created.size > 0
            ? `Added ${added[0].lead.address} to your leads.`
            : `${added[0].lead.address} is already a lead; its signals were updated.`
          : `Added ${created.size} new leads${updated > 0 ? ` and updated ${updated} existing ones` : ""}.`,
      );
      setChecked(new Set());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setAdding(false);
    }
  };

  const locate = () =>
    navigator.geolocation.getCurrentPosition(
      ({ coords: { latitude, longitude } }) => {
        if (isInTravisCounty(latitude, longitude))
          setCenter({ name: "My location", latitude, longitude });
        else
          setError(
            `Your location (${latitude.toFixed(3)}, ${longitude.toFixed(3)}) is outside Travis County, so the search stays where it is.`,
          );
      },
      () => setError("The browser did not share a location. Drop a pin on the map instead."),
    );

  const showTab = (kind: CandidateKind) => {
    setTab(kind);
    setVisible((current) => ({ ...current, [kind]: true }));
    setChecked(new Set());
  };
  const select = (selection: Selection) => {
    showTab(selection.kind);
    setSelected(selection);
  };
  const shownSpec = SPECS[tab];
  const shown = results[tab];
  const selectedRow =
    selected === undefined ? undefined : results[selected.kind]?.rows[selected.index];
  const checkedRows: Row[] = [...checked].flatMap((index) => {
    const row = shown?.rows[index];
    return row ? [row] : [];
  });
  const centerValue =
    center.name && CENTERS.some((place) => place.name === center.name) ? center.name : "";

  return (
    <div className="page">
      <div className="prospect-layout">
        <Card title="Search area" subtitle="Travis County, TX">
          <div className="controls">
            <label>
              Center on a place or ZIP code
              <select
                value={centerValue}
                onChange={(event) => setCenter(centerOf(event.target.value))}
              >
                <option value="" disabled>
                  {center.name ?? "Dropped pin"}
                </option>
                <optgroup label="Places">
                  {PLACE_OPTIONS.map((place) => (
                    <option key={place.geoid} value={place.name}>
                      {place.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="ZIP codes">
                  {ZIP_CODES.map((zip) => (
                    <option key={zip.geoid} value={zip.name}>
                      {zip.name}
                    </option>
                  ))}
                </optgroup>
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
                <MapToggle
                  label="Aged roofs"
                  dot="aged"
                  checked={visible[CandidateKind.AgedRoof]}
                  onChange={(on) => setVisible({ ...visible, [CandidateKind.AgedRoof]: on })}
                />
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
                <MapToggle
                  label="Open roofing permits"
                  dot="permit"
                  checked={visible[CandidateKind.OpenPermit]}
                  onChange={(on) => setVisible({ ...visible, [CandidateKind.OpenPermit]: on })}
                />
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
                Also expired without a final inspection
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={withContractor}
                  onChange={(event) => setWithContractor(event.target.checked)}
                />
                Only permits that list a contractor
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={includeAccessory}
                  onChange={(event) => setIncludeAccessory(event.target.checked)}
                />
                Include accessory work (patio covers, sheds)
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
            <fieldset>
              <legend>
                <MapToggle
                  label="Recent hail on the current roof"
                  dot="hail"
                  checked={visible[CandidateKind.Hail]}
                  onChange={(on) => setVisible({ ...visible, [CandidateKind.Hail]: on })}
                />
              </legend>
              <label>
                Hail at least (inches)
                <input
                  type="number"
                  min={0}
                  step={HAIL_INCHES_STEP}
                  value={hailInches}
                  onChange={(event) => setHailInches(Number(event.target.value))}
                />
              </label>
              <label>
                Reported in the last (years)
                <input
                  type="number"
                  min={1}
                  max={MAX_HAIL_YEARS}
                  value={hailYears}
                  onChange={(event) => setHailYears(Number(event.target.value))}
                />
              </label>
              <p className="muted small">
                NOAA Storm Events hail reports within 2 miles, after the roof's anchor date. Hail
                nobody reported is missing.
              </p>
            </fieldset>
            <fieldset>
              <legend>
                <MapToggle
                  label="Top leads"
                  dot="top"
                  checked={visible[CandidateKind.TopLead]}
                  onChange={(on) => setVisible({ ...visible, [CandidateKind.TopLead]: on })}
                />
              </legend>
              <p className="muted small">
                Score 0–100: roof points (up to 40) for roof age beyond 15 years weighted by its
                confidence, permit points (up to 30) for years a roofing permit stayed unfinished,
                hail points (up to 30) for the largest recent hail on the current roof.
              </p>
            </fieldset>
          </div>
        </Card>
        <div className="map-panel">
          <ProspectMap
            center={center}
            radiusMiles={radius}
            candidates={candidates}
            density={density.filter((cell) => visible[cell.kind])}
            selected={selected}
            onPick={(picked) => setCenter({ ...picked, name: undefined })}
            onSelect={select}
          />
          <div className="legend">
            {KINDS.filter(({ kind }) => visible[kind]).map(({ kind, dot, label }) => (
              <span key={kind}>
                <span className={`dot ${dot}`} /> {label.toLowerCase()}
              </span>
            ))}
            <span>
              <span className="dot saved" /> in your leads
            </span>
            <span>
              <span className="dot area" /> all matches by area
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
        actions={
          checkedRows.length > 0 && (
            <button
              type="button"
              className="button"
              disabled={adding}
              onClick={() => addLeads(tab, checkedRows)}
            >
              {adding ? "Adding…" : `Add ${checkedRows.length} selected to leads`}
            </button>
          )
        }
      >
        <div className="tabs-inline" role="tablist">
          {KINDS.map(({ kind, label }) => (
            <button
              key={kind}
              type="button"
              role="tab"
              aria-selected={tab === kind}
              className={tab === kind ? "active" : ""}
              onClick={() => showTab(kind)}
            >
              {label} {results[kind] && <Badge>{formatCount(results[kind]?.totalMatches)}</Badge>}
            </button>
          ))}
        </div>
        {running && <Spinner label="Searching the published dataset…" />}
        {!running && shown && (
          <>
            {(shown.totalMatches ?? 0) > shown.rows.length && (
              <p className="muted small">
                Showing the first {shown.rows.length} of {formatCount(shown.totalMatches)},{" "}
                {shownSpec.order}. Click a column to sort them.
              </p>
            )}
            <CandidateTable
              key={tab}
              rows={shown.rows}
              columns={shownSpec.columns}
              selected={selected?.kind === tab ? selected.index : undefined}
              onSelect={(index) => setSelected({ kind: tab, index })}
              isSaved={(row) => isSaved(tab, row)}
              onAdd={(row) => addLeads(tab, [row])}
              checked={checked}
              onCheck={setChecked}
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
          onAdd={() => addLeads(selected.kind, [selectedRow])}
        />
      )}
    </div>
  );
}

function MapToggle({
  label,
  dot,
  checked,
  onChange,
}: {
  label: string;
  dot: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="checkbox">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={`dot ${dot}`} /> {label}
    </label>
  );
}

interface Sort {
  key: string;
  descending: boolean;
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  const numbers = [Number(a), Number(b)];
  if (numbers.every(Number.isFinite)) return (numbers[0] ?? 0) - (numbers[1] ?? 0);
  return String(a).localeCompare(String(b));
}

function CandidateTable({
  rows,
  columns,
  selected,
  onSelect,
  isSaved,
  onAdd,
  checked,
  onCheck,
}: {
  rows: Row[];
  columns: Column[];
  selected: number | undefined;
  onSelect: (index: number) => void;
  isSaved: (row: Row) => boolean;
  onAdd: (row: Row) => void;
  checked: ReadonlySet<number>;
  onCheck: (checked: ReadonlySet<number>) => void;
}) {
  const [sort, setSort] = useState<Sort>();
  if (rows.length === 0) return <p className="muted">Nothing matches within this radius.</p>;

  const ordered = rows.map((row, index) => ({ row, index }));
  if (sort) {
    ordered.sort((first, second) => {
      const order = compare(first.row[sort.key], second.row[sort.key]);
      const nullLast = first.row[sort.key] === null || second.row[sort.key] === null;
      return sort.descending && !nullLast ? -order : order;
    });
  }
  const addable = ordered.filter(({ row }) => !isSaved(row)).map(({ index }) => index);
  const allChecked = addable.length > 0 && addable.every((index) => checked.has(index));
  const sortBy = (key: string) =>
    setSort(sort?.key === key ? { key, descending: !sort.descending } : { key, descending: true });
  const check = (index: number, on: boolean) => {
    const next = new Set(checked);
    if (on) next.add(index);
    else next.delete(index);
    onCheck(next);
  };

  return (
    <div className="table-scroll results">
      <table className="data-table compact">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                aria-label="Select every candidate that is not a lead yet"
                checked={allChecked}
                onChange={(event) => onCheck(new Set(event.target.checked ? addable : []))}
              />
            </th>
            <th />
            {columns.map((column) => (
              <th key={column.key} aria-sort={sortState(sort, column.key)}>
                <button type="button" className="sort" onClick={() => sortBy(column.key)}>
                  {column.label}
                  {sort?.key === column.key ? (sort.descending ? " ↓" : " ↑") : ""}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ordered.map(({ row, index }) => (
            <tr
              key={index}
              className={`selectable${selected === index ? " selected" : ""}`}
              onClick={() => onSelect(index)}
            >
              <td>
                {!isSaved(row) && (
                  <input
                    type="checkbox"
                    aria-label={`Select ${String(row.situs_address ?? row.address ?? "candidate")}`}
                    checked={checked.has(index)}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => check(index, event.target.checked)}
                  />
                )}
              </td>
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
                  {column.render ? column.render(row) : formatValue(row[column.key], column.key)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function sortState(sort: Sort | undefined, key: string): "ascending" | "descending" | "none" {
  if (sort?.key !== key) return "none";
  return sort.descending ? "descending" : "ascending";
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
      {kind === CandidateKind.TopLead && (
        <div className="permit-summary">
          <h3>Lead score {formatValue(row.lead_score)} of 100</h3>
          <dl className="facts">
            <dt>Roof</dt>
            <dd>
              {formatValue(row.roof_points)} points · roof {formatValue(row.roof_age_years)} years (
              {String(row.roof_age_confidence ?? "no")} confidence)
            </dd>
            <dt>Permit</dt>
            <dd>
              {formatValue(row.permit_points)} points
              {row.max_years_open !== null && row.max_years_open !== undefined
                ? ` · a roofing permit unfinished for ${formatValue(row.max_years_open)} years`
                : ""}
            </dd>
            <dt>Hail</dt>
            <dd>
              {formatValue(row.hail_points)} points
              {row.max_hail_inches !== null && row.max_hail_inches !== undefined
                ? ` · ${formatValue(row.max_hail_inches)}-inch hail, latest ${String(row.last_hail_date)}`
                : ""}
            </dd>
          </dl>
        </div>
      )}
      {(kind === CandidateKind.Hail ||
        (kind === CandidateKind.TopLead && typeof row.hail_source_url === "string")) && (
        <div className="permit-summary">
          <h3>Hail on the current roof</h3>
          <dl className="facts">
            <dt>Largest report</dt>
            <dd>
              {formatValue(row.max_hail_inches)} inches · {formatValue(row.hail_reports)} reports
              within 2 miles since the roof went on, latest {String(row.last_hail_date)}
            </dd>
            <dt>Source</dt>
            <dd>
              {typeof row.hail_source_url === "string" ? (
                <a href={row.hail_source_url} target="_blank" rel="noreferrer">
                  NOAA Storm Events record
                </a>
              ) : (
                "NOAA Storm Events"
              )}
            </dd>
          </dl>
        </div>
      )}
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
                <dt>{labelOf(field)}</dt>
                <dd>{formatValue(property[field], field)}</dd>
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
