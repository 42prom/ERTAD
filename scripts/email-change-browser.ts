import { chromium, expect as baseExpect, type Page } from "@playwright/test";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { createApp } from "../backend/src/app";
import { createLocalAdminRouter } from "../backend/src/localAdmin";
import { deliverSecurityMailBatch } from "../backend/src/modules/identity/mailDelivery";
const expect = baseExpect.configure({ timeout: 30000 });
export async function verifyEmailChangeBrowser({
  ctx,
  recipient,
  send,
  sent,
  password,
}: any) {
  const origin =
    process.env.ERTAD_BROWSER_WEB_ORIGIN ?? "http://localhost:15173";
  const app = createApp(
    {
      postgres: async () => {},
      redis: async () => {},
      storage: async () => {},
    },
    pino({ level: "silent" }),
    origin,
    createLocalAdminRouter(origin, () => ctx.access),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  let closing = false,
    current: Page | undefined,
    stage = "setup";
  const httpIssues: { path: string; status: number; stage: string }[] = [];
  async function pageFor() {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await context.addInitScript(() => {
      if (!localStorage.getItem("ertad.console.language"))
        localStorage.setItem("ertad.console.language", "en");
    });
    await context.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith("/api/")) return route.continue();
      try {
        const response = await route.fetch({
          url: endpoint + url.pathname + url.search,
        });
        if (response.status() >= 400 && httpIssues.length < 30)
          httpIssues.push({
            path: url.pathname,
            status: response.status(),
            stage,
          });
        await route.fulfill({ response });
      } catch {
        if (!closing) errors.push("Browser API transport failed");
        await route.abort().catch(() => {});
      }
    });
    const page = await context.newPage();
    current = page;
    page.setDefaultTimeout(30000);
    page.on("pageerror", (e) => errors.push(e.message));
    return page;
  }
  async function login(page: Page, email: string, secret = password) {
    await page.goto(origin + "/login");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(secret);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((u) => u.pathname === "/dashboard");
  }
  try {
    const member = await pageFor();
    await login(member, recipient.email);
    await member.goto(origin + "/account");
    await member
      .getByRole("button", { name: "Change sign-in email", exact: true })
      .click();
    const changeHeading = member.getByRole("heading", {
      name: "Request a new email address",
      exact: true,
    });
    await expect(changeHeading).toBeFocused();
    const panel = member.locator("form").filter({ has: changeHeading }),
      newEmail = "browser-change-" + randomUUID() + "@example.test";
    await panel.getByLabel("New email address", { exact: true }).fill(newEmail);
    await panel.getByLabel("Current password", { exact: true }).fill(password);
    await expect(
      panel.getByRole("button", { name: "Confirm email request" }),
    ).toBeDisabled();
    await panel.getByRole("checkbox").check();
    await panel.getByRole("button", { name: "Confirm email request" }).click();
    await expect(member.getByText(/Request saved/)).toBeVisible();
    await expect(member.getByText(newEmail, { exact: false })).toBeVisible();
    await deliverSecurityMailBatch(send);
    const proof = sent.find(
      (m: any) => m.purpose === "email_change" && m.email === newEmail,
    );
    expect(proof).toBeTruthy();
    const path = "/verify-email-change#" + proof.id + "." + proof.token;
    const guest = await pageFor();
    await guest.goto(origin + path);
    await expect(
      guest.getByText(/Sign in to the account that requested/),
    ).toBeVisible();
    expect(new URL(guest.url()).hash).toBe("");
    expect(await guest.getByRole("checkbox").count()).toBe(0);
    // A separately signed-in session proves successful confirmation revokes the original browser session too.
    await login(guest, recipient.email);
    for (const language of ["en", "ka"])
      for (const theme of ["light", "dark"]) {
        await guest.evaluate(
          ({ language, theme }) => {
            localStorage.setItem("ertad.console.language", language);
            localStorage.setItem("ertad.console.theme", theme);
          },
          { language, theme },
        );
        await guest.reload();
        await guest.goto(origin + path);
        await expect(
          guest.getByRole("heading", {
            name:
              language === "ka"
                ? "ელფოსტის ცვლილების დადასტურება"
                : "Confirm email change",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          guest.getByLabel(
            language === "ka" ? "მიმდინარე პაროლი" : "Current password",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(guest.locator("html")).toHaveAttribute(
          "data-theme",
          theme,
        );
        expect(new URL(guest.url()).hash).toBe("");
        for (const width of [360, 390, 768, 1440]) {
          await guest.setViewportSize({ width, height: 1000 });
          expect(
            await guest.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
          ).toBe(true);
        }
        await guest.screenshot({
          path: ".local/email-change-" + language + "-" + theme + ".png",
        });
      }
    await guest.evaluate(() => {
      localStorage.setItem("ertad.console.language", "en");
    });
    await guest.reload();
    await guest.goto(origin + path);
    await guest.getByLabel("Current password", { exact: true }).fill(password);
    await guest.getByRole("checkbox").check();
    await guest
      .getByRole("button", { name: "Confirm address change", exact: true })
      .click();
    await expect(
      guest.getByText(/Email changed and all sessions closed/),
    ).toBeVisible();
    await member.goto(origin + "/account");
    await member.waitForURL((u) => u.pathname === "/login");
    await deliverSecurityMailBatch(send);
    expect(
      sent.some(
        (m: any) =>
          m.id === proof.id &&
          m.purpose === "email_changed" &&
          m.email === recipient.email,
      ),
    ).toBe(true);
    await login(guest, newEmail);
    await guest.goto(origin + "/account");
    stage='new-address account';
    await expect(guest.getByRole('main').getByText(newEmail, { exact: true })).toBeVisible();
    console.log(
      "Email-change browser: confirmed address, old-session revocation and new-address login pass; waiting for the ordinary API window before recovery",
    );
    stage = "ordinary rate window";
    await new Promise((r) => setTimeout(r, 60000));
    stage = "logout before recovery";
    console.log("Email-change browser: logout before recovery");
    await Promise.all([
      guest.waitForEvent("load"),
      guest.getByRole("button", { name: "Logout", exact: true }).click(),
    ]);
    await guest.waitForURL((u) => u.pathname === "/login");
    await expect(guest.getByLabel("Email", { exact: true })).toBeVisible();
    await guest.goto(origin + "/recover");
    stage = "request recovery";
    console.log("Email-change browser: request recovery");
    await guest.getByLabel("Email", { exact: true }).fill(newEmail);
    await guest
      .getByRole("button", { name: "Request recovery link", exact: true })
      .click();
    await expect(
      guest.getByText(/If recovery is available for that contact/),
    ).toBeVisible();
    await deliverSecurityMailBatch(send);
    stage = "complete recovery";
    console.log("Email-change browser: complete recovery");
    const recovery = sent.find(
      (m: any) => m.purpose === "recovery" && m.email === newEmail,
    );
    expect(recovery).toBeTruthy();
    await guest.goto(origin + "/recover#" + recovery.id + "." + recovery.token);
    const recovered = "Synthetic-email-browser-recovered-769!";
    await guest.getByLabel("Password", { exact: true }).fill(recovered);
    await guest.getByLabel("Repeat password", { exact: true }).fill(recovered);
    await guest.getByRole("checkbox").check();
    await guest
      .getByRole("button", { name: "Reset password", exact: true })
      .click();
    await expect(
      guest.getByText(/Password changed and old sessions closed/),
    ).toBeVisible();
    stage = "recovered login";
    await login(guest, newEmail, recovered);
    expect(errors).toEqual([]);
    console.log(
      "PASS own-email Chrome: own request/password/intent, guest sign-in, bilingual light/dark 360/390/768/1440 forms, proof/password confirmation, old-address notice, all-session revocation, new-email login and recovery/reset/login",
    );
  } catch (error) {
    console.error(
      "Email-change browser diagnostic",
      current
        ? {
            path: new URL(current.url()).pathname,
            alerts: await current
              .locator('[role="alert"]')
              .allTextContents()
              .catch(() => ["Page navigating"]),
            errors,
            stage,
            httpIssues,
          }
        : errors,
    );
    if (current)
      await current
        .screenshot({
          path: ".local/email-change-browser-error.png",
        })
        .catch(() => {});
    throw error;
  } finally {
    closing = true;
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
