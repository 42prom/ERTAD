import { expect as baseExpect, type Page } from "@playwright/test";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });

export async function verifyMonitoringBrowser(page: Page) {
  console.log("Monitoring browser: waiting for a fresh API rate window");
  await new Promise((resolve) => setTimeout(resolve, 60000));
  await setConsoleAppearance(page, "en", "light");
  const response = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/v1/admin/platform/monitoring" &&
      r.status() === 200,
  );
  await page
    .locator(".console-nav-item[href='/platform/monitoring']")
    .click();
  const data = await (await response).json();
  expect(data.totals.login_failed).toBeGreaterThan(0);
  expect(data.totals.step_up_failed).toBeGreaterThan(0);
  await expect(
    page.getByText("Observations by minute", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Period", { exact: true }).selectOption("60");
  await page
    .getByLabel("Event type", { exact: true })
    .selectOption("rate_limited");
  await expect(
    page.getByRole("heading", { name: "Failed login", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Event type", { exact: true }).selectOption("all");
  await expect(
    page.getByRole("heading", { name: "Failed login", exact: true }),
  ).toBeVisible();
  for (const language of ["ka", "en"])
    for (const theme of ["light", "dark"]) {
      await setConsoleAppearance(page, language, theme);
      // Appearance helper reloads the app, so return to the monitoring tab.
      await page
        .locator(".console-nav-item[href='/platform/monitoring']")
        .click();
      await expect(
        page.getByRole("heading", {
          name:
            language === "ka"
              ? "უსაფრთხოების მონიტორინგი"
              : "Security monitoring",
          exact: true,
        }),
      ).toBeVisible();
      for (const width of [360, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 1100 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        ).toBe(true);
      }
      await page.screenshot({
        path: `.local/platform-monitoring-${language}-${theme}.png`,
      });
    }
  await page
    .getByRole("button", { name: "Review sessions", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Active web sessions", exact: true }),
  ).toBeVisible();
  await page
    .locator(".console-nav-item[href='/platform/monitoring']")
    .click();
  await page.getByRole("button", { name: "Open audit", exact: true }).click();
  await expect(
    page.locator(".console-nav-item[href='/platform/audit']"),
  ).toHaveAttribute("aria-current", "page");
  console.log(
    "PASS monitoring browser: real counters, filters, bounded coverage, audit/session navigation, both languages/themes and four widths",
  );
}
