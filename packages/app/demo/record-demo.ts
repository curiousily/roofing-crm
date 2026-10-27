import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "@playwright/test";

const CRM_URL = process.env.CRM_URL ?? "https://roofing-crm.curiousily.workers.dev";
const OUTPUT_DIR = process.env.DEMO_DIR ?? "demo/output";
const VIEWPORT = { width: 1440, height: 900 };
const READ_MS = 4_500;
const LONG_READ_MS = 7_000;
const SETTLE_MS = 1_500;
const DATA_TIMEOUT_MS = 120_000;
const AGENT_TIMEOUT_MS = 180_000;
const PIN = { x: 0.55, y: 0.5 };
const AGENT_QUESTION =
  "Show me open roofing permits older than five years within five miles of Rollingwood.";

const CAPTION_SCRIPT = `
  window.demoCaption = (title, body) => {
    let box = document.getElementById("demo-caption");
    if (!box) {
      box = document.createElement("div");
      box.id = "demo-caption";
      box.style.cssText = "position:fixed;left:calc(50% + 120px);top:6px;transform:translateX(-50%);width:min(1000px,90vw);z-index:99999;" +
        "background:rgba(17,20,24,.94);color:#fff;padding:10px 20px;border-radius:10px;font:14px/1.4 Inter,system-ui,sans-serif;" +
        "box-shadow:0 8px 30px rgba(0,0,0,.35)";
      document.body.appendChild(box);
    }
    box.innerHTML = "<div style='font-weight:700;font-size:16px;margin-bottom:4px'>" + title + "</div><div>" + body + "</div>";
  };
`;

async function caption(page: Page, title: string, body: string, pauseMs = READ_MS) {
  await page.evaluate(
    ({ heading, text }) =>
      (window as unknown as { demoCaption(a: string, b: string): void }).demoCaption(heading, text),
    { heading: title, text: body },
  );
  await page.waitForTimeout(pauseMs);
}

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
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: OUTPUT_DIR, size: VIEWPORT },
  });
  await context.addInitScript(CAPTION_SCRIPT);
  const page = await context.newPage();

  await page.goto(`${CRM_URL}/#/prospect`);
  await page.getByText(/Data: Travis County Oracle build/).waitFor({ timeout: DATA_TIMEOUT_MS });
  await caption(
    page,
    "RoofLead CRM, centered on Travis County",
    "The map opens on the county boundary. Property and permit data come from the published Travis County Oracle dataset, queried in this browser.",
  );
  let card = await candidatesLoaded(page);
  await caption(
    page,
    "Search around a place, GPS or a dropped pin",
    "The default search is 5 miles around Austin. Clicking the map drops a pin; the radius is configurable.",
  );

  const map = page.getByTestId("prospect-map");
  const box = await map.boundingBox();
  if (box) await page.mouse.click(box.x + box.width * PIN.x, box.y + box.height * PIN.y);
  card = await candidatesLoaded(page);
  await page.getByRole("slider").fill("4");
  card = await candidatesLoaded(page);
  await page.waitForTimeout(SETTLE_MS);
  await caption(
    page,
    "Pin dropped, radius set to 4 miles",
    "Orange points are roofs older than 15 years; purple points are roofing permits that were never finished.",
    LONG_READ_MS,
  );
  await page.getByRole("slider").fill("5");
  await page.getByLabel("Center on a place").selectOption("Austin");
  card = await candidatesLoaded(page);

  await show(card);
  await caption(
    page,
    "Roofs older than 15 years",
    "Best-evidenced first: completed reroof permit, then new construction, then year built, with owner and distance.",
    LONG_READ_MS,
  );
  await card.getByRole("tab", { name: /Open roofing permits/ }).click();
  card = await candidatesLoaded(page);
  await show(card);
  await caption(
    page,
    "Still open, longest first",
    "Roofing permits still open five years or more, with years open and the contractor.",
    LONG_READ_MS,
  );
  await page.getByLabel(/Also expired without a final inspection/).check();
  await page.getByLabel(/Only permits that list a contractor/).check();
  card = await candidatesLoaded(page);
  await show(card);
  await caption(
    page,
    "Never-finished permits with a listed contractor",
    "Adding permits that expired without a final inspection and keeping those with a listed contractor brings in archived BBB grades.",
    LONG_READ_MS,
  );

  const graded = card
    .locator("tbody tr")
    .filter({ has: page.locator(".badge-good") })
    .first();
  await graded.locator("td").nth(2).click();
  const detail = page.locator(".card").filter({ hasText: "TCAD property" }).last();
  await detail.getByText("Contractor").first().waitFor({ timeout: DATA_TIMEOUT_MS });
  await show(detail);
  await caption(
    page,
    "Permit, contractor and BBB grade",
    "Status and open duration, the contractor and its BBB grade as of the archived snapshot, the city record, and the property's owner and roof.",
    LONG_READ_MS,
  );
  await detail.getByRole("button", { name: "Add to leads" }).click();
  await page.getByRole("status").waitFor({ timeout: DATA_TIMEOUT_MS });
  await caption(
    page,
    "Converted into a lead",
    "The permit, its property, owner and mailing address become a CRM lead.",
  );
  await show(card);
  await card.getByRole("tab", { name: /Aged roofs/ }).click();
  await candidatesLoaded(page);
  await card.getByRole("button", { name: "+ Lead" }).first().click();
  await page.getByRole("status").waitFor({ timeout: DATA_TIMEOUT_MS });
  await caption(
    page,
    "One click per candidate",
    "Aged roofs convert the same way; saved candidates turn green on the map.",
  );

  await page.goto(`${CRM_URL}/#/assistant`);
  await page.getByText(/Data: Travis County Oracle build/).waitFor({ timeout: DATA_TIMEOUT_MS });
  await caption(
    page,
    "Assistant",
    "Ask in plain language. A Workers AI model chooses the query tools; they run over the dataset and your leads.",
  );
  await page.getByRole("button", { name: AGENT_QUESTION }).click();
  await page.locator(".bubble.agent").first().waitFor({ timeout: AGENT_TIMEOUT_MS });
  await show(page.locator(".evidence").first());
  await caption(
    page,
    "Evidence first",
    "The rows the answer is based on, with + Lead on each one.",
  );
  await page.locator(".evidence").first().getByRole("button", { name: "+ Lead" }).first().click();
  await page.waitForTimeout(SETTLE_MS);
  await show(page.locator(".bubble.agent").first());
  await caption(
    page,
    "Grounded answer",
    "Counts, the long-open permits, contractors and BBB grades, and the assumptions and gaps.",
    LONG_READ_MS,
  );

  await page.goto(`${CRM_URL}/#/leads`);
  await page.locator(".data-table tbody tr").first().waitFor({ timeout: DATA_TIMEOUT_MS });
  await caption(
    page,
    "Lead pipeline",
    "Every lead with its signals, stage, priority, roof, permit, contractor and BBB grade.",
    LONG_READ_MS,
  );
  await page.getByLabel("Roof age at least").fill("15");
  await caption(page, "Filter by roof age", "Only leads whose roof is at least 15 years old.");
  await page.getByLabel("Roof age at least").fill("");
  await page.getByLabel("Permit status").selectOption("expired");
  await page.getByLabel("Open at least (years)").fill("5");
  await caption(
    page,
    "Filter by permit status and open duration",
    "Expired-without-final permits open five years or more.",
  );
  await page.getByLabel("Permit status").selectOption("");
  await page.getByLabel("Open at least (years)").fill("");
  await page.getByLabel("Near").selectOption("Austin");
  await caption(page, "Filter by distance", "Leads within the chosen radius of a place.");
  await page.locator(".data-table tbody tr").first().locator("td").first().click();
  const lead = page.locator(".lead-detail");
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
  await page.locator(".timeline").getByText("notes updated").waitFor({ timeout: DATA_TIMEOUT_MS });
  await show(page.locator(".card").filter({ has: lead }));
  await caption(
    page,
    "Manage the lead",
    "Stage, notes and next action, each recorded in the activity history.",
    LONG_READ_MS,
  );
  await show(page.locator(".future-actions"));
  await caption(
    page,
    "What comes next (disabled)",
    "Outreach actions and the sidebar's Coming soon sections show where the CRM grows beyond lead identification: campaigns, estimates, inspections, insurance claims, storm alerts and reports.",
    LONG_READ_MS,
  );

  await deleteDemoLeads(page);
  const video = page.video();
  await context.close();
  await browser.close();
  const recorded = await video?.path();
  if (recorded) await rename(recorded, join(OUTPUT_DIR, "crm-demo.webm"));
  console.log(await readdir(OUTPUT_DIR));
}

await record();
