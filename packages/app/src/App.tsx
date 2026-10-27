import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { Cid, ErrorNote, Spinner } from "./components/ui.js";
import type { Dataset } from "./data/dataset.js";
import type { Database } from "./data/duckdb.js";
import { useDatabase, useDataset } from "./data/hooks.js";
import { formatCount } from "./format.js";
import { LeadsProvider, useLeads } from "./leads/leads-context.js";
import { resetWorkspace, workspaceId } from "./leads/workspace.js";
import { LeadsPage } from "./pages/LeadsPage.js";

const ProspectPage = lazy(async () => ({
  default: (await import("./pages/ProspectPage.js")).ProspectPage,
}));
const AssistantPage = lazy(async () => ({
  default: (await import("./pages/AssistantPage.js")).AssistantPage,
}));

enum Page {
  Prospect = "prospect",
  Leads = "leads",
  Assistant = "assistant",
}

const PAGES: { page: Page; label: string; icon: string }[] = [
  { page: Page.Prospect, label: "Prospecting map", icon: "◎" },
  { page: Page.Leads, label: "Leads", icon: "☰" },
  { page: Page.Assistant, label: "Assistant", icon: "✦" },
];

const COMING_SOON: { label: string; detail: string }[] = [
  { label: "Outreach campaigns", detail: "Mailers, email and SMS sequences to lead owners" },
  { label: "Estimates & proposals", detail: "Roof measurements, material pricing and e-signature" },
  { label: "Inspections & crews", detail: "Schedule inspections and assign crews" },
  { label: "Insurance claims", detail: "Storm-damage claims with adjuster tracking" },
  { label: "Storm alerts", detail: "Hail and wind events matched to properties" },
  { label: "Reports", detail: "Pipeline conversion and revenue by territory" },
];

const HASH_PREFIX = "#/";
const WORKSPACE_PREVIEW = 8;

function pageFromHash(): Page {
  const name = window.location.hash.slice(HASH_PREFIX.length);
  return Object.values(Page).includes(name as Page) ? (name as Page) : Page.Prospect;
}

function useHashPage(): Page {
  const [page, setPage] = useState(pageFromHash);
  useEffect(() => {
    const update = () => setPage(pageFromHash());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return page;
}

export function App() {
  return (
    <LeadsProvider>
      <Shell />
    </LeadsProvider>
  );
}

function Shell() {
  const page = useHashPage();
  const dataset = useDataset();
  const { leads } = useLeads();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo" aria-hidden>
            ▲
          </span>
          <div>
            <strong>RoofLead CRM</strong>
            <span className="small">Travis County, TX</span>
          </div>
        </div>
        <nav aria-label="Main">
          {PAGES.map(({ page: target, label, icon }) => (
            <a
              key={target}
              href={`${HASH_PREFIX}${target}`}
              className={`nav-item${target === page ? " active" : ""}`}
            >
              <span aria-hidden>{icon}</span> {label}
              {target === Page.Leads && leads.length > 0 && (
                <span className="count">{formatCount(leads.length)}</span>
              )}
            </a>
          ))}
        </nav>
        <section className="nav-group" aria-label="Coming soon">
          <span className="nav-heading">Coming soon</span>
          {COMING_SOON.map((item) => (
            <button
              key={item.label}
              type="button"
              className="nav-item disabled"
              disabled
              aria-disabled
              title={item.detail}
            >
              <span aria-hidden>🔒</span> {item.label}
            </button>
          ))}
        </section>
        <div className="workspace small">
          Workspace <code>{workspaceId().slice(0, WORKSPACE_PREVIEW)}</code>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              resetWorkspace();
              window.location.reload();
            }}
          >
            start a new one
          </button>
        </div>
      </aside>
      <div className="content">
        <header className="topbar">
          <h1>{PAGES.find((entry) => entry.page === page)?.label}</h1>
          {dataset.state === "ready" && (
            <div className="dataset-badge small">
              <span className="muted">
                Data: Travis County Oracle build {dataset.value.build.buildId} ·{" "}
                {formatCount(dataset.value.coverage.properties?.rows)} properties
              </span>
              <Cid cid={dataset.value.publication.rootCid} />
            </div>
          )}
        </header>
        <main>
          {dataset.state === "loading" && <Spinner label="Loading the latest published dataset…" />}
          {dataset.state === "failed" && <ErrorNote message={dataset.error} />}
          {dataset.state === "ready" && <PageView page={page} dataset={dataset.value} />}
        </main>
      </div>
    </div>
  );
}

function PageView({ page, dataset }: { page: Page; dataset: Dataset }) {
  switch (page) {
    case Page.Prospect:
      return (
        <WithDatabase dataset={dataset}>
          {(database) => <ProspectPage dataset={dataset} database={database} />}
        </WithDatabase>
      );
    case Page.Leads:
      return <LeadsPage />;
    case Page.Assistant:
      return (
        <WithDatabase dataset={dataset}>
          {(database) => <AssistantPage dataset={dataset} database={database} />}
        </WithDatabase>
      );
  }
}

function WithDatabase({
  dataset,
  children,
}: {
  dataset: Dataset;
  children: (database: Database) => ReactNode;
}) {
  const database = useDatabase(dataset);
  if (database.state === "loading")
    return <Spinner label="Starting DuckDB-WASM over the published Parquet tables…" />;
  if (database.state === "failed") return <ErrorNote message={database.error} />;
  return <Suspense fallback={<Spinner label="Loading…" />}>{children(database.value)}</Suspense>;
}
