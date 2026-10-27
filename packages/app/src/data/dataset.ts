import type { DatasetRef } from "../../worker/leads/lead.js";

export interface Publication {
  buildId: string;
  publishedAt: string;
  manifestCid: string;
  rootCid: string;
}

export interface BuildSummary {
  buildId: string;
  asOf: string;
}

export type Coverage = Record<string, { rows?: number; [field: string]: unknown }>;

export interface Dataset {
  publication: Publication;
  build: BuildSummary;
  coverage: Coverage;
  ref: DatasetRef;
  tableUrl(table: string): string;
}

const PUBLICATIONS_PATH = "/api/publications";

export async function loadDataset(fetchImpl: typeof fetch, origin: string): Promise<Dataset> {
  const getJson = async <T>(path: string): Promise<T> => {
    const url = new URL(path, origin).toString();
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    return (await response.json()) as T;
  };

  const publications = await getJson<Publication[]>(PUBLICATIONS_PATH);
  const publication = [...publications].sort((a, b) => a.buildId.localeCompare(b.buildId)).at(-1);
  if (!publication) throw new Error("There is no published dataset yet.");

  const file = (name: string) => `/ipfs/${publication.rootCid}/${name}`;
  const [build, coverage] = await Promise.all([
    getJson<BuildSummary>(file("build.json")),
    getJson<Coverage>(file("coverage.json")),
  ]);
  return {
    publication,
    build,
    coverage,
    ref: { rootCid: publication.rootCid, buildId: build.buildId },
    tableUrl: (table) => new URL(file(`tables/${table}.parquet`), origin).toString(),
  };
}
