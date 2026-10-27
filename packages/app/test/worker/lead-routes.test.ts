import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { D1LeadRepository } from "../../worker/leads/d1-lead-repository.js";
import { leadRoutes } from "../../worker/leads/lead-routes.js";
import { sqliteD1 } from "./sqlite-d1.js";

const MIGRATIONS = join(import.meta.dirname, "../../migrations");
const WORKSPACE = "6f1f1b8e-6a2c-4c55-9d5b-2a8f3c1e0a11";
const OTHER_WORKSPACE = "0b7d3c6e-1f2a-4b8c-9e0d-5a6b7c8d9e0f";
const DATASET = { rootCid: "bafybei-root", buildId: "20261027T100024Z" };

let app: ReturnType<typeof leadRoutes>;
let ids = 0;

beforeEach(() => {
  const database = new DatabaseSync(":memory:");
  for (const migration of readdirSync(MIGRATIONS).sort()) {
    database.exec(readFileSync(join(MIGRATIONS, migration), "utf8"));
  }
  ids = 0;
  app = leadRoutes({
    repository: new D1LeadRepository(sqliteD1(database)),
    now: () => "2026-10-27T12:00:00.000Z",
    newId: () => `lead-${++ids}`,
  });
});

const send = (method: string, path: string, body?: unknown, workspace = WORKSPACE) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", "x-workspace-id": workspace },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

const agedRoof = {
  signal: "aged_roof",
  propId: 276120,
  address: "202 WALNUT ST",
  latitude: 30.4392,
  longitude: -97.6196,
  roofAgeYears: 41,
  roofAgeAnchor: "completed_replacement",
  roofAgeConfidence: "high",
  dataset: DATASET,
};

describe("lead routes", () => {
  it("creates a lead from a property and lists it", async () => {
    const created = await send("POST", "/api/leads", agedRoof);

    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      id: "lead-1",
      status: "new",
      signals: ["aged_roof"],
    });
    const listed = (await (await send("GET", "/api/leads")).json()) as { id: string }[];
    expect(listed.map((lead) => lead.id)).toEqual(["lead-1"]);
  });

  it("stores the reported hail of a hail lead", async () => {
    await send("POST", "/api/leads", {
      signal: "hail",
      propId: 303314,
      address: "2216 BARTON SKWY",
      hailInches: 1.75,
      hailDate: "2026-05-09",
      dataset: DATASET,
    });

    const [stored] = (await (await send("GET", "/api/leads")).json()) as Record<string, unknown>[];
    expect(stored).toMatchObject({
      signals: ["hail"],
      hailInches: 1.75,
      hailDate: "2026-05-09",
      priority: "high",
    });
  });

  it("adds a batch of candidates in order, merging the signals of the same property", async () => {
    const response = await send("POST", "/api/leads/batch", {
      leads: [
        agedRoof,
        { ...agedRoof, signal: "hail", hailInches: 2, hailDate: "2025-05-28" },
        { ...agedRoof, propId: 303314, address: "2216 BARTON SKWY" },
      ],
    });

    expect(response.status).toBe(200);
    const added = (await response.json()) as { lead: { id: string }; created: boolean }[];
    expect(added.map(({ lead, created }) => [lead.id, created])).toEqual([
      ["lead-1", true],
      ["lead-1", false],
      ["lead-2", true],
    ]);
    const listed = (await (await send("GET", "/api/leads")).json()) as {
      id: string;
      signals: string[];
    }[];
    expect(listed.find((lead) => lead.id === "lead-1")?.signals).toEqual(["aged_roof", "hail"]);
  });

  it("rejects an empty batch or one larger than 50", async () => {
    expect((await send("POST", "/api/leads/batch", { leads: [] })).status).toBe(400);
    expect(
      (
        await send("POST", "/api/leads/batch", {
          leads: Array.from({ length: 51 }, () => agedRoof),
        })
      ).status,
    ).toBe(400);
  });

  it("merges a second signal for the same property instead of duplicating it", async () => {
    await send("POST", "/api/leads", agedRoof);
    const merged = await send("POST", "/api/leads", {
      signal: "open_permit",
      propId: 276120,
      permitNumber: "2007-105523 BP",
      address: "202 WALNUT ST",
      permitState: "expired",
      yearsOpen: 19,
      dataset: DATASET,
    });

    expect(merged.status).toBe(200);
    expect(await merged.json()).toMatchObject({
      id: "lead-1",
      signals: ["aged_roof", "open_permit"],
    });
    expect(((await (await send("GET", "/api/leads")).json()) as unknown[]).length).toBe(1);
  });

  it("updates a lead and keeps its activity history", async () => {
    await send("POST", "/api/leads", agedRoof);

    const updated = await send("PATCH", "/api/leads/lead-1", {
      status: "contacted",
      notes: "Called owner",
    });
    const activities = (await (await send("GET", "/api/leads/lead-1/activities")).json()) as {
      kind: string;
    }[];

    expect(await updated.json()).toMatchObject({ status: "contacted", notes: "Called owner" });
    expect(activities.map((activity) => activity.kind)).toEqual([
      "notes_updated",
      "status_changed",
      "created",
    ]);
  });

  it("keeps both of two concurrent edits to different fields", async () => {
    await send("POST", "/api/leads", agedRoof);

    await Promise.all([
      send("PATCH", "/api/leads/lead-1", { nextActionOn: "2026-11-02" }),
      send("PATCH", "/api/leads/lead-1", { status: "contacted" }),
    ]);
    const [lead] = (await (await send("GET", "/api/leads")).json()) as Record<string, unknown>[];

    expect(lead).toMatchObject({ status: "contacted", nextActionOn: "2026-11-02" });
  });

  it("filters leads by roof age, open duration and distance", async () => {
    await send("POST", "/api/leads", agedRoof);
    await send("POST", "/api/leads", {
      ...agedRoof,
      propId: 1,
      address: "1 FAR RD",
      latitude: 30.1,
      longitude: -97.9,
      roofAgeYears: 16,
    });

    const old = (await (await send("GET", "/api/leads?min_roof_age=30")).json()) as {
      address: string;
    }[];
    const near = (await (
      await send("GET", "/api/leads?latitude=30.4392&longitude=-97.6196&radius_miles=5")
    ).json()) as { address: string }[];

    expect(old.map((lead) => lead.address)).toEqual(["202 WALNUT ST"]);
    expect(near.map((lead) => lead.address)).toEqual(["202 WALNUT ST"]);
  });

  it("keeps workspaces apart", async () => {
    await send("POST", "/api/leads", agedRoof);

    expect(await (await send("GET", "/api/leads", undefined, OTHER_WORKSPACE)).json()).toEqual([]);
    expect(
      (await send("PATCH", "/api/leads/lead-1", { status: "won" }, OTHER_WORKSPACE)).status,
    ).toBe(404);
    expect((await send("DELETE", "/api/leads/lead-1", undefined, OTHER_WORKSPACE)).status).toBe(
      404,
    );
  });

  it("deletes a lead", async () => {
    await send("POST", "/api/leads", agedRoof);

    expect((await send("DELETE", "/api/leads/lead-1")).status).toBe(204);
    expect(await (await send("GET", "/api/leads")).json()).toEqual([]);
  });

  it("rejects requests without a workspace or with invalid leads", async () => {
    const anonymous = await app.request("/api/leads");
    const invalid = await send("POST", "/api/leads", { signal: "aged_roof" });
    const badStatus = await send("PATCH", "/api/leads/lead-1", { status: "maybe" });

    expect([anonymous.status, invalid.status, badStatus.status]).toEqual([400, 400, 400]);
  });
});
