import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "@playwright/test";
import { Narrator } from "./narration.js";

const CRM_URL = process.env.CRM_URL ?? "https://roofing-crm.curiousily.workers.dev";
const OUTPUT_DIR = process.env.DEMO_DIR ?? "demo/output";
const NARRATION_CACHE_DIR = "demo/narration-cache";
const VIDEO_FILE = "crm-demo.mp4";
const VIEWPORT = { width: 1440, height: 900 };
const PAUSE_AFTER_LINE_MS = 700;
const SETTLE_MS = 1_100;
const DATA_TIMEOUT_MS = 120_000;
const AGENT_TIMEOUT_MS = 180_000;
const PIN = { x: 0.55, y: 0.5 };
const ZIP_CODE = "78704";
const BULK_ROWS = 3;
const AGENT_QUESTION =
  "Show me open roofing permits older than five years within five miles of Rollingwood.";

const LINES = {
  intro:
    "This is RoofLead, a roofing CRM built on the Travis County Oracle. The map opens on Travis County, and the property, permit and hail data come from the Oracle's published snapshot, queried right here in the browser.",
  pin: "You can search around a place, a ZIP code, your own location or a dropped pin. Here I drop a pin and set the radius to four miles.",
  zip: "Or pick a ZIP code. This is 78704, in South Austin.",
  agedRoofs:
    "Aged roofs come with their evidence: a completed reroof permit first, then new construction, then the year built, plus the owner and the distance.",
  openPermits:
    "Open roofing permits are jobs that never finished. Adding the expired ones that list a contractor brings in archived BBB grades.",
  permitDetail:
    "Each permit shows its status, how long it's been open, the contractor and its BBB grade, and the property's owner. One click turns it into a lead.",
  hail: "Recent hail finds roofs that took NOAA-reported hail of an inch or more within two miles in the last three years, after the roof went on.",
  topLeads:
    "Top leads ranks everything with a transparent score: points for roof age, for an unfinished permit, and for recent hail.",
  bulk: "The columns sort, and I can select several candidates and add them to the pipeline in one step.",
  assistant:
    "The assistant answers in plain language. A Workers AI model picks from the same tools the Oracle's MCP server exposes, plus one for your own leads, and every answer shows the rows behind it.",
  evidence: "Here's the evidence, and any of these rows can become a lead.",
  answer:
    "The answer gives the count, lists the long-open permits with their contractors, and spells out its assumptions and gaps.",
  pipeline:
    "The pipeline lists every lead with its signals, stage, priority, roof, permit, hail and contractor.",
  filters:
    "Filters narrow it down by roof age, by permit status and how long it's been open, or by distance from a place.",
  manage:
    "Opening a lead, I can move it to contacted, add notes and set the next action, and every change lands in the activity history.",
  future:
    "And the disabled sections show where the CRM goes next: campaigns, estimates, inspections, insurance claims, storm alerts and reports.",
};

async function show(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((element) =>
    element.scrollIntoView({ behavior: "smooth", block: "start" }),
  );
  await locator.page().waitForTimeout(SETTLE_MS);
}

async function candidatesLoaded(page: Page): Promise<Locator> {
  const card = page.locator(".card").filter({ hasText: "Lead candidates" });
  await card
    .getByText("Searching the published dataset…")
    .waitFor({ state: "hidden", timeout: DATA_TIMEOUT_MS });
  await card
    .locator("tbody tr")
    .first()
    .or(card.getByText("Nothing matches within this radius."))
    .waitFor({ timeout: DATA_TIMEOUT_MS });
  return card;
}

async function deleteDemoLeads(page: Page) {
  await page.evaluate(async () => {
    const headers = { "x-workspace-id": localStorage.getItem("roofing-crm.workspace") ?? "" };
    const leads = (await (await fetch("/api/leads", { headers })).json()) as { id: string }[];
    await Promise.all(
      leads.map((lead) => fetch(`/api/leads/${lead.id}`, { method: "DELETE", headers })),
    );
  });
}

async function record() {
  const narrator = await Narrator.prepare(Object.values(LINES), NARRATION_CACHE_DIR);
  const narrate = async (page: Page, line: string) =>
    page.waitForTimeout(narrator.say(line) + PAUSE_AFTER_LINE_MS);
  const quickly = <T>(wait: () => Promise<T>) => narrator.cutWaiting(wait);

  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: OUTPUT_DIR, size: VIEWPORT },
  });
  const page = await context.newPage();
  narrator.startRecording();

  let card = await quickly(async () => {
    await page.goto(`${CRM_URL}/#/prospect`);
    await page.getByText(/Data: Travis County Oracle build/).waitFor({ timeout: DATA_TIMEOUT_MS });
    return candidatesLoaded(page);
  });
  await narrate(page, LINES.intro);

  const map = page.getByTestId("prospect-map");
  const box = await map.boundingBox();
  card = await quickly(async () => {
    if (box) await page.mouse.click(box.x + box.width * PIN.x, box.y + box.height * PIN.y);
    await candidatesLoaded(page);
    await page.getByRole("slider").fill("4");
    return candidatesLoaded(page);
  });
  await narrate(page, LINES.pin);
  card = await quickly(async () => {
    await page.getByRole("slider").fill("5");
    await page.getByLabel("Center on a place or ZIP code").selectOption(ZIP_CODE);
    return candidatesLoaded(page);
  });
  await narrate(page, LINES.zip);

  await show(card);
  await narrate(page, LINES.agedRoofs);
  card = await quickly(async () => {
    await card.getByRole("tab", { name: /Open roofing permits/ }).click();
    await page.getByLabel(/Also expired without a final inspection/).check();
    await page.getByLabel(/Only permits that list a contractor/).check();
    return candidatesLoaded(page);
  });
  await show(card);
  await narrate(page, LINES.openPermits);

  const graded = card
    .locator("tbody tr")
    .filter({ has: page.locator(".badge-good") })
    .first();
  const detail = page.locator(".card").filter({ hasText: "TCAD property" }).last();
  await quickly(async () => {
    await graded.locator("td").nth(3).click();
    await detail.getByText("Contractor").first().waitFor({ timeout: DATA_TIMEOUT_MS });
  });
  await show(detail);
  await narrate(page, LINES.permitDetail);
  await quickly(async () => {
    await detail.getByRole("button", { name: "Add to leads" }).click();
    await page.getByRole("status").waitFor({ timeout: DATA_TIMEOUT_MS });
  });

  await show(card);
  card = await quickly(async () => {
    await card.getByRole("tab", { name: /Recent hail/ }).click();
    return candidatesLoaded(page);
  });
  await narrate(page, LINES.hail);
  card = await quickly(async () => {
    await card.getByRole("tab", { name: /Top leads/ }).click();
    return candidatesLoaded(page);
  });
  await narrate(page, LINES.topLeads);
  await card.getByRole("button", { name: "Hail pts", exact: true }).click();
  await page.waitForTimeout(SETTLE_MS);
  const boxes = card.locator("tbody input[type=checkbox]");
  for (let row = 0; row < BULK_ROWS; row += 1) await boxes.nth(row).check();
  await narrate(page, LINES.bulk);
  await quickly(async () => {
    await card.getByRole("button", { name: `Add ${BULK_ROWS} selected to leads` }).click();
    await page
      .getByRole("status")
      .getByText(/Added \d+ new leads/)
      .waitFor({
        timeout: DATA_TIMEOUT_MS,
      });
  });
  await page.waitForTimeout(SETTLE_MS);

  await quickly(async () => {
    await page.goto(`${CRM_URL}/#/assistant`);
    await page.getByText(/Data: Travis County Oracle build/).waitFor({ timeout: DATA_TIMEOUT_MS });
  });
  await narrate(page, LINES.assistant);
  await quickly(async () => {
    await page.getByRole("button", { name: AGENT_QUESTION }).click();
    await page.locator(".bubble.agent").first().waitFor({ timeout: AGENT_TIMEOUT_MS });
  });
  await show(page.locator(".evidence").first());
  await narrate(page, LINES.evidence);
  await show(page.locator(".bubble.agent").first());
  await narrate(page, LINES.answer);

  await quickly(async () => {
    await page.goto(`${CRM_URL}/#/leads`);
    await page.locator(".data-table tbody tr").first().waitFor({ timeout: DATA_TIMEOUT_MS });
  });
  await narrate(page, LINES.pipeline);
  await page.getByLabel("Roof age at least").fill("15");
  await page.waitForTimeout(SETTLE_MS);
  await page.getByLabel("Roof age at least").fill("");
  await page.getByLabel("Permit status").selectOption("expired");
  await page.getByLabel("Open at least (years)").fill("5");
  await narrate(page, LINES.filters);
  await page.getByLabel("Permit status").selectOption("");
  await page.getByLabel("Open at least (years)").fill("");
  await page.locator(".data-table tbody tr").first().locator("td").first().click();
  const lead = page.locator(".lead-detail");
  await quickly(async () => {
    await lead.waitFor({ timeout: DATA_TIMEOUT_MS });
    await page
      .getByLabel(/Status of/)
      .first()
      .selectOption("contacted");
    await lead
      .getByRole("textbox")
      .last()
      .fill("Called the owner; roof inspection requested for next week.");
    await page.getByRole("button", { name: "Save notes" }).click();
    await lead.getByLabel("Next action date").fill("2026-11-03");
    await page
      .locator(".timeline")
      .getByText("notes updated")
      .waitFor({ timeout: DATA_TIMEOUT_MS });
  });
  await show(page.locator(".card").filter({ has: lead }));
  await narrate(page, LINES.manage);
  await show(page.locator(".future-actions"));
  await narrate(page, LINES.future);

  await deleteDemoLeads(page);
  const video = page.video();
  await context.close();
  await browser.close();
  const recorded = await video?.path();
  if (!recorded) throw new Error("Playwright did not record a video.");
  await narrator.mixInto(recorded, join(OUTPUT_DIR, VIDEO_FILE));
  await rm(recorded);
  console.log(await readdir(OUTPUT_DIR));
}

await record();
