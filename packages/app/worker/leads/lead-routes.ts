import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { LeadPriority, LeadSignal, LeadStatus } from "./lead.js";
import type { LeadRepository } from "./lead-repository.js";
import { LeadService } from "./lead-service.js";

export interface LeadRoutesDependencies {
  repository: LeadRepository;
  now: () => string;
  newId: () => string;
}

const WORKSPACE_HEADER = "x-workspace-id";
const MAX_TEXT = 300;
const MAX_NOTES = 5_000;
const MAX_ROOF_AGE = 500;
const MAX_YEARS_OPEN = 200;
const MAX_HAIL_INCHES = 10;
const MAX_BATCH = 50;
const MAX_RADIUS_MILES = 100;
const LIST_SEPARATOR = ",";

const HttpStatus = {
  Ok: 200,
  Created: 201,
  NoContent: 204,
  BadRequest: 400,
  NotFound: 404,
} as const;

const text = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TEXT)
  .nullish()
  .transform((value) => value ?? undefined);
const number = (schema: z.ZodNumber) => schema.nullish().transform((value) => value ?? undefined);

const newLeadSchema = z
  .object({
    signal: z.enum(LeadSignal),
    propId: number(z.number().int().positive()),
    permitNumber: text,
    address: z.string().trim().min(1).max(MAX_TEXT),
    latitude: number(z.number().min(-90).max(90)),
    longitude: number(z.number().min(-180).max(180)),
    ownerName: text,
    mailingAddress: text,
    roofAgeYears: number(z.number().int().min(0).max(MAX_ROOF_AGE)),
    roofAgeAnchor: text,
    roofAgeConfidence: text,
    permitState: text,
    yearsOpen: number(z.number().int().min(0).max(MAX_YEARS_OPEN)),
    contractorName: text,
    bbbRating: text,
    hailInches: number(z.number().min(0).max(MAX_HAIL_INCHES)),
    hailDate: z.iso
      .date()
      .nullish()
      .transform((value) => value ?? undefined),
    dataset: z.object({
      rootCid: z.string().min(1).max(MAX_TEXT),
      buildId: z.string().min(1).max(MAX_TEXT),
    }),
  })
  .refine((lead) => lead.propId !== undefined || lead.permitNumber !== undefined, {
    message: "A lead needs a TCAD property id or a permit number.",
  });

const batchSchema = z.object({ leads: z.array(newLeadSchema).min(1).max(MAX_BATCH) });

const updateSchema = z.object({
  status: z.enum(LeadStatus).optional(),
  priority: z.enum(LeadPriority).optional(),
  notes: z.string().max(MAX_NOTES).optional(),
  nextActionOn: z.iso.date().nullable().optional(),
});

const commaSeparated = z
  .string()
  .optional()
  .transform((value) => (value ? value.split(LIST_SEPARATOR) : undefined));

const filterSchema = z
  .object({
    status: commaSeparated.pipe(z.array(z.enum(LeadStatus)).optional()),
    signal: commaSeparated.pipe(z.array(z.enum(LeadSignal)).optional()),
    permit_state: commaSeparated.pipe(z.array(z.string().max(MAX_TEXT)).optional()),
    min_roof_age: z.coerce.number().min(0).optional(),
    min_years_open: z.coerce.number().min(0).optional(),
    latitude: z.coerce.number().min(-90).max(90).optional(),
    longitude: z.coerce.number().min(-180).max(180).optional(),
    radius_miles: z.coerce.number().positive().max(MAX_RADIUS_MILES).optional(),
  })
  .transform((query) => ({
    statuses: query.status,
    signals: query.signal,
    permitStates: query.permit_state,
    minRoofAgeYears: query.min_roof_age,
    minYearsOpen: query.min_years_open,
    near:
      query.latitude !== undefined &&
      query.longitude !== undefined &&
      query.radius_miles !== undefined
        ? { latitude: query.latitude, longitude: query.longitude, radiusMiles: query.radius_miles }
        : undefined,
  }));

export function leadRoutes(dependencies: LeadRoutesDependencies) {
  const service = new LeadService(dependencies);
  const app = new Hono<{ Variables: { workspaceId: string } }>();

  const invalid = (error: z.ZodError) => ({ error: z.prettifyError(error) });

  const requireWorkspace = createMiddleware<{ Variables: { workspaceId: string } }>(
    async (context, next) => {
      const workspace = z.uuid().safeParse(context.req.header(WORKSPACE_HEADER));
      if (!workspace.success) {
        return context.json(
          { error: `Send a workspace UUID in ${WORKSPACE_HEADER}.` },
          HttpStatus.BadRequest,
        );
      }
      context.set("workspaceId", workspace.data);
      await next();
    },
  );
  app.use("/api/leads", requireWorkspace);
  app.use("/api/leads/*", requireWorkspace);

  app.get("/api/leads", async (context) => {
    const filter = filterSchema.safeParse(context.req.query());
    if (!filter.success) return context.json(invalid(filter.error), HttpStatus.BadRequest);
    return context.json(await service.list(context.get("workspaceId"), filter.data));
  });

  app.post("/api/leads/batch", async (context) => {
    const batch = batchSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!batch.success) return context.json(invalid(batch.error), HttpStatus.BadRequest);
    const added = [];
    for (const input of batch.data.leads) {
      added.push(await service.create(context.get("workspaceId"), input));
    }
    return context.json(added);
  });

  app.post("/api/leads", async (context) => {
    const input = newLeadSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!input.success) return context.json(invalid(input.error), HttpStatus.BadRequest);
    const { lead, created } = await service.create(context.get("workspaceId"), input.data);
    return context.json(lead, created ? HttpStatus.Created : HttpStatus.Ok);
  });

  app.patch("/api/leads/:id", async (context) => {
    const update = updateSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!update.success) return context.json(invalid(update.error), HttpStatus.BadRequest);
    const lead = await service.update(
      context.get("workspaceId"),
      context.req.param("id"),
      update.data,
    );
    return lead
      ? context.json(lead)
      : context.json({ error: "No such lead." }, HttpStatus.NotFound);
  });

  app.delete("/api/leads/:id", async (context) => {
    const deleted = await service.delete(context.get("workspaceId"), context.req.param("id"));
    return deleted
      ? context.body(null, HttpStatus.NoContent)
      : context.json({ error: "No such lead." }, HttpStatus.NotFound);
  });

  app.get("/api/leads/:id/activities", async (context) => {
    const activities = await service.activities(
      context.get("workspaceId"),
      context.req.param("id"),
    );
    return activities
      ? context.json(activities)
      : context.json({ error: "No such lead." }, HttpStatus.NotFound);
  });

  return app;
}
