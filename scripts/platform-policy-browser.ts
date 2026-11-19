import {
  expect as baseExpect,
  type Page,
  type Browser,
} from "@playwright/test";
const expect = baseExpect.configure({ timeout: 30000 });
import { setConsoleAppearance } from "./console-browser";

/** Real browser approval against the disposable API, never the developer's database. */
export async function verifyPolicyBrowser(
  page: Page,
  browser: Browser,
  endpoint: string,
  proposer: { password: string },
  reviewer: { email: string; password: string },
) {
  // The preceding cross-language console matrix shares the real per-IP API budget.
  // Start this separate two-account journey in a fresh window; do not weaken rate limits.
  console.log("Policy browser: waiting for the next API rate window");
  await new Promise((resolve) => setTimeout(resolve, 60000));
  await setConsoleAppearance(page, "en", "light");
  await page
    .locator(".console-nav-item[href='/platform/policy']")
    .click();
  await expect(
    page.getByRole("heading", { name: "Web session policy", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Propose change", exact: true })
    .click();
  await page.getByLabel("Idle timeout (seconds, 300–3600)").fill("600");
  await page
    .getByLabel("Your password", { exact: true })
    .fill(proposer.password);
  await page
    .getByRole("button", { name: "Submit for approval", exact: true })
    .click();
  await expect(
    page.getByText("Change saved. Status refreshed.", { exact: true }),
  ).toBeVisible();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  const errors: string[] = [];
  await context.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    await route.fulfill({
      response: await route.fetch({
        url: endpoint + url.pathname + url.search,
      }),
    });
  });
  const second = await context.newPage();
  second.on("pageerror", (error) => errors.push(error.message));
  second.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (
      path.startsWith("/api/") &&
      response.status() >= 400 &&
      !(path === "/api/v1/admin/auth/me" && response.status() === 401)
    )
      errors.push(`HTTP ${response.status()} ${path}`);
  });
  try {
    await second.goto("http://localhost:15173/login");
    await second.getByLabel("Email", { exact: true }).fill(reviewer.email);
    await second
      .getByLabel("Password", { exact: true })
      .fill(reviewer.password);
    await second.getByRole("button", { name: "Sign in", exact: true }).click();
    await second.waitForURL((url) => url.pathname === "/platform");
    await setConsoleAppearance(second, "en", "light");
    await second
      .locator(".console-nav-item[href='/platform/policy']")
      .click();
    await expect(
      second.getByRole("heading", { name: "Web session policy", exact: true }),
    ).toBeVisible();
    await expect(
      second.getByRole("button", { name: "Propose change", exact: true }),
    ).toHaveCount(0);
    const candidate = second
      .locator("article")
      .filter({ hasText: "600s / 28800s / 3" })
      .filter({ hasText: "Pending review" });
    await candidate
      .getByRole("button", { name: "Review request", exact: true })
      .click();
    await expect(
      second.getByLabel("Idle timeout (seconds, 300–3600)"),
    ).toHaveValue("600");
    await second
      .getByLabel("Your password", { exact: true })
      .fill(reviewer.password);
    await second.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(
      second.getByText("Change saved. Status refreshed.", { exact: true }),
    ).toBeVisible();
    await expect(candidate).toHaveCount(0);
    await second.waitForLoadState("networkidle");
    expect(errors).toEqual([]);
    for (const language of ["ka", "en"])
      for (const theme of ["light", "dark"]) {
        await setConsoleAppearance(page, language, theme);
        await page
          .locator(".console-nav-item[href='/platform/policy']")
          .click();
        await expect(
          page.getByText("600 " + (language === "ka" ? "წამი" : "seconds"), {
            exact: true,
          }),
        ).toBeVisible();
        await page
          .getByRole("button", {
            name: language === "ka" ? "ცვლილების შეთავაზება" : "Propose change",
            exact: true,
          })
          .click();
        for (const width of [360, 390, 768, 1440]) {
          await page.setViewportSize({ width, height: 1000 });
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
          ).toBe(true);
          const dialog = page.getByRole("dialog");
          await expect(dialog).toBeVisible();
          expect(
            await dialog.evaluate((element) => {
              const box = element.getBoundingClientRect();
              return (
                Math.abs(box.x + box.width / 2 - innerWidth / 2) < 2 &&
                Math.abs(box.y + box.height / 2 - innerHeight / 2) < 2
              );
            }),
          ).toBe(true);
          expect(
            await dialog.evaluate(
              (element) => element.scrollWidth <= element.clientWidth + 1,
            ),
          ).toBe(true);
        }
        await page.screenshot({
          path: `.local/platform-policy-${language}-${theme}.png`,
        });
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(
          page.getByRole("button", {
            name: language === "ka" ? "ცვლილების შეთავაზება" : "Propose change",
            exact: true,
          }),
        ).toBeFocused();
      }
    console.log(
      "PASS policy browser: proposer and independent reviewer, persisted approved values, no reviewer proposal controls, dialog focus and four widths in both languages/themes",
    );
  } catch (error) {
    console.error("Policy browser response failures:", errors);
    await second.screenshot({
      path: ".local/platform-policy-review-failure.png",
    });
    throw error;
  } finally {
    await context.close();
  }
}
