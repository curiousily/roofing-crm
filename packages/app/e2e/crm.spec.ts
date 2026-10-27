import { expect, type Page, test } from "@playwright/test";

const SCREENSHOTS = "test-results/screenshots";

async function open(page: Page, hash: string) {
  await page.goto(`/#/${hash}`);
  await expect(page.getByText(/Data: Travis County Oracle build \d{8}T\d{6}Z/)).toBeVisible();
}

async function candidates(page: Page) {
  const card = page.locator(".card").filter({ hasText: "Lead candidates" });
  await expect(card.getByText(/Showing the first|Nothing matches/)).toBeVisible();
  return card;
}

async function deleteAllLeads(page: Page) {
  await page.evaluate(async () => {
    const workspace = localStorage.getItem("roofing-crm.workspace") ?? "";
    const headers = { "x-workspace-id": workspace };
    const leads = (await (await fetch("/api/leads", { headers })).json()) as { id: string }[];
    await Promise.all(
      leads.map((lead) => fetch(`/api/leads/${lead.id}`, { method: "DELETE", headers })),
    );
  });
}

test("opens on Travis County and shows aged roofs and long-open roofing permits within the radius", async ({
  page,
}) => {
  await open(page, "prospect");

  await expect(page.getByTestId("prospect-map")).toBeVisible();
  const card = await candidates(page);
  await expect(card.getByRole("tab", { name: /Aged roofs [\d,]+/ })).toBeVisible();
  await expect(card.locator("tbody tr").first()).toContainText(
    /completed replacement|new construction|year built/,
  );

  await card.getByRole("tab", { name: /Open roofing permits/ }).click();
  await expect(card.locator("thead")).toContainText("Contractor");
  await card.locator("tbody tr").first().click();
  const detail = page
    .locator(".card")
    .filter({ hasText: /^Permit|TCAD property/ })
    .last();
  await expect(detail).toContainText("Contractor");
  await expect(detail).toContainText("BBB");
  await page.screenshot({ path: `${SCREENSHOTS}/prospect.png`, fullPage: true });
});

test("searches around a ZIP code, finds recent hail and top leads, and sorts the list", async ({
  page,
}) => {
  await open(page, "prospect");
  await page.getByLabel("Center on a place or ZIP code").selectOption("78704");
  const card = await candidates(page);
  await expect(card).toContainText("of 78704");

  await card.getByRole("tab", { name: /Recent hail/ }).click();
  await expect(card.locator("thead")).toContainText("Hail (in)");
  await card.getByRole("tab", { name: /Top leads/ }).click();
  await expect(card.locator("thead")).toContainText("Score");
  await card.getByRole("button", { name: "Roof age", exact: true }).click();
  await expect(card.locator("th[aria-sort=descending]")).toContainText("Roof age");
  await page.screenshot({ path: `${SCREENSHOTS}/top-leads.png`, fullPage: true });
});

test("adds selected candidates to the leads in one step", async ({ page }) => {
  await open(page, "prospect");
  const card = await candidates(page);
  await card.getByRole("tab", { name: /Top leads/ }).click();

  const boxes = card.locator("tbody input[type=checkbox]");
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await card.getByRole("button", { name: "Add 2 selected to leads" }).click();

  await expect(page.getByRole("status")).toContainText("Added 2 new leads");
  await expect(card.locator("tbody tr").first()).toContainText("lead");
  await deleteAllLeads(page);
});

test("centers the search on a dropped pin with a configurable radius", async ({ page }) => {
  await open(page, "prospect");
  await candidates(page);

  const map = page.getByTestId("prospect-map");
  const box = await map.boundingBox();
  if (!box) throw new Error("map has no size");
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.45);
  await page.getByRole("slider").fill("3");

  await expect(page.getByText("Within 3 miles of the pin")).toBeVisible();
  await candidates(page);
});

test("turns candidates into leads and filters the pipeline by roof age, permit status and radius", async ({
  page,
}) => {
  await open(page, "prospect");
  const card = await candidates(page);

  await card.getByRole("button", { name: "+ Lead" }).first().click();
  await expect(page.getByRole("status")).toContainText(/Added|already a lead/);
  await card.getByRole("tab", { name: /Open roofing permits/ }).click();
  await card.getByRole("button", { name: "+ Lead" }).first().click();
  await expect(page.getByRole("status")).toContainText(/Added|already a lead/);

  await page.getByRole("link", { name: /Leads/ }).click();
  const pipeline = page.locator(".card").filter({ hasText: "Your pipeline" });
  await expect(pipeline.locator(".pipeline")).toBeVisible();
  const rows = pipeline.locator(".data-table tbody tr");
  await expect(rows).not.toHaveCount(0);
  const total = await rows.count();

  await page.getByLabel("Roof age at least").fill("15");
  await expect(page.getByText(/of \d+ leads match/)).toBeVisible();
  await page.getByLabel("Roof age at least").fill("");
  await page.getByLabel("Permit status").selectOption("open");
  await expect(rows.first()).toContainText("open");
  await page.getByLabel("Permit status").selectOption("");
  await page.getByLabel("Near").selectOption("Austin");
  await expect(page.getByText(new RegExp(`of ${total} leads match`))).toBeVisible();

  await rows.first().locator("td").first().click();
  await page.locator(".lead-detail").getByLabel("Next action date").fill("2026-11-02");
  await page
    .getByLabel(/Status of/)
    .first()
    .selectOption("contacted");
  await expect(page.locator(".timeline")).toContainText("status changed");
  await expect(page.getByRole("button", { name: /Create estimate/ })).toBeDisabled();
  await page.screenshot({ path: `${SCREENSHOTS}/leads.png`, fullPage: true });

  await deleteAllLeads(page);
});

test("answers through the assistant with evidence that converts into leads", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/agent", async (route) => {
    calls += 1;
    const message =
      calls === 1
        ? {
            content: "",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "find_open_roofing_permits",
                  arguments: JSON.stringify({
                    place: "Rollingwood",
                    radius_miles: 5,
                    min_years_open: 5,
                  }),
                },
              },
            ],
          }
        : { content: "**Scripted answer** grounded in the evidence above.", tool_calls: [] };
    await route.fulfill({
      json: {
        message,
        neurons: 0,
        cached: true,
        budget: { used: 0, limit: 4500 },
        model: "scripted",
      },
    });
  });
  await open(page, "assistant");

  await page.getByRole("button", { name: /open roofing permits older than five years/ }).click();

  const evidence = page.locator(".evidence");
  await expect(evidence).toContainText(/[\d,]+ matches around Rollingwood/);
  await expect(page.locator(".bubble.agent")).toContainText("Scripted answer");
  await evidence.getByRole("button", { name: "+ Lead" }).first().click();
  await expect(
    evidence
      .locator(".badge")
      .filter({ hasText: /^lead$/ })
      .first(),
  ).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOTS}/assistant.png`, fullPage: true });

  await deleteAllLeads(page);
});

test("shows the future CRM sections as disabled", async ({ page }) => {
  await open(page, "leads");

  const soon = page.getByLabel("Coming soon");
  await expect(soon.getByRole("button")).toHaveCount(6);
  for (const button of await soon.getByRole("button").all()) await expect(button).toBeDisabled();
});
