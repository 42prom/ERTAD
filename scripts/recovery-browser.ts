import {
  chromium,
  expect as baseExpect,
  type BrowserContext,
} from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { Client } from "pg";
import { mkdtemp, readFile, readdir, unlink, rmdir } from "node:fs/promises";
import { resolve } from "node:path";
import { deliverSyntheticCredential } from "./invitation-delivery";
const expect = baseExpect.configure({ timeout: 30000 });
export async function runRecoveryBrowser(
  app: Express,
  owner: Client,
  recipient: { email: string; account: string },
  oldPassword: string,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [],
    contexts: BrowserContext[] = [];
  const directory = await mkdtemp(resolve(".local/recovery-browser-"));
  let closing = false;
  async function context(language = "en", theme = "light") {
    const result = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    contexts.push(result);
    await result.addInitScript(
      ({ language, theme }) => {
        if (!localStorage.getItem("ertad.console.language"))
          localStorage.setItem("ertad.console.language", language);
        if (!localStorage.getItem("ertad.console.theme"))
          localStorage.setItem("ertad.console.theme", theme);
      },
      { language, theme },
    );
    await result.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith("/api/")) return route.continue();
      try {
        const response = await route.fetch({
          url: endpoint + url.pathname + url.search,
        });
        if (
          response.status() >= 400 &&
          !(response.status() === 401 && url.pathname.endsWith("/auth/me"))
        )
          errors.push(url.pathname + ": " + response.status());
        await route.fulfill({ response });
      } catch {
        if (!closing) errors.push("Transport failure");
        await route.abort().catch(() => {});
      }
    });
    const page = await result.newPage();
    page.on("pageerror", () => errors.push("Browser script error"));
    return page;
  }
  try {
    for (const language of ["ka", "en"])
      for (const theme of ["dark", "light"]) {
        const visual = await context(language, theme);
        await visual.goto(
          "http://localhost:15173/recover#11111111-1111-4111-8111-111111111111." +
            "A".repeat(43),
        );
        await expect(
          visual.getByRole("heading", {
            name:
              language === "ka"
                ? "ახალი პაროლის დაყენება"
                : "Set a new password",
          }),
        ).toBeVisible();
        for (const width of [360, 390, 768, 1440]) {
          await visual.setViewportSize({ width, height: 1000 });
          expect(
            await visual.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
          ).toBe(true);
        }
        await visual.screenshot({
          path: ".local/recovery-form-" + language + "-" + theme + ".png",
          fullPage: true,
        });
        await visual.close();
      }
    const existing = await context();
    await existing.goto("http://localhost:15173/login");
    await existing.getByLabel("Email", { exact: true }).fill(recipient.email);
    await existing.getByLabel("Password", { exact: true }).fill(oldPassword);
    await existing
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await expect(existing).not.toHaveURL(/\/login/);
    await existing.goto("http://localhost:15173/account");
    await expect(
      existing.getByRole("heading", { name: "Account security", exact: true }),
    ).toBeVisible();
    const page = await context();
    await page.goto("http://localhost:15173/recover");
    for (const language of ["ka", "en"])
      for (const theme of ["dark", "light"]) {
        await page.evaluate(
          ({ language, theme }) => {
            localStorage.setItem("ertad.console.language", language);
            localStorage.setItem("ertad.console.theme", theme);
          },
          { language, theme },
        );
        await page.reload();
        await expect(
          page.getByRole("heading", {
            name: language === "ka" ? "პაროლის აღდგენა" : "Recover password",
          }),
        ).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        for (const width of [360, 390, 768, 1440]) {
          await page.setViewportSize({ width, height: 1000 });
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
          ).toBe(true);
        }
      }
    await page.screenshot({
      path: ".local/recovery-request.png",
      fullPage: true,
    });
    await page.getByLabel("Email", { exact: true }).fill(recipient.email);
    await page.getByRole("button", { name: "Request recovery link" }).click();
    await expect(page.getByRole("status")).toContainText(
      "If recovery is available",
    );
    let id = (
      await owner.query(
        "SELECT id FROM web_account_recoveries WHERE account_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL",
        [recipient.account],
      )
    ).rows[0].id;
    await deliverSyntheticCredential(
      owner,
      id,
      directory,
      "http://localhost:15173",
      "recovery",
    );
    const message = JSON.parse(
      await readFile(resolve(directory, id + ".json"), "utf8"),
    );
    await existing
      .getByRole("button", { name: "Refresh recovery status" })
      .click();
    await expect(existing.getByText("Recovery link prepared.")).toBeVisible();
    for (const language of ["ka", "en"]) {
      await existing.evaluate((language) => {
        localStorage.setItem("ertad.console.language", language);
      }, language);
      await existing.reload();
      for (const theme of ["dark", "light"]) {
        await existing.setViewportSize({ width: 1440, height: 1000 });
        await existing
          .getByRole("button", {
            name:
              language === "ka"
                ? theme === "dark"
                  ? "ღამე"
                  : "დღე"
                : theme === "dark"
                  ? "Dark"
                  : "Light",
            exact: true,
          })
          .click();
        await expect(
          existing.getByRole("heading", {
            name: language === "ka" ? "პაროლის აღდგენა" : "Password recovery",
            exact: true,
          }),
        ).toBeVisible();
        await expect(existing.locator("html")).toHaveAttribute(
          "data-theme",
          theme,
        );
        for (const width of [360, 390, 768, 1440]) {
          await existing.setViewportSize({ width, height: 1000 });
          expect(
            await existing.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
          ).toBe(true);
        }
        await existing
          .getByRole("heading", {
            name: language === "ka" ? "პაროლის აღდგენა" : "Password recovery",
            exact: true,
          })
          .scrollIntoViewIfNeeded();
        await existing.screenshot({
          path: `.local/own-recovery-${language}-${theme}.png`,
        });
      }
    }
    await existing
      .getByRole("button", { name: "Cancel recovery link", exact: true })
      .click();
    await existing
      .getByLabel("Current password to cancel link")
      .fill(oldPassword);
    await existing
      .getByLabel("I confirm cancellation of the selected recovery link.")
      .check();
    await existing
      .getByRole("button", { name: "Confirm cancellation", exact: true })
      .click();
    await expect(
      existing.getByText(
        "Selected recovery link cancelled. Your password and sessions are unchanged.",
      ),
    ).toBeVisible();
    await expect(
      existing.getByText("No active recovery request."),
    ).toBeVisible();
    expect(
      (
        await owner.query(
          "SELECT revoked_at,consumed_at FROM web_account_recoveries WHERE id=$1",
          [id],
        )
      ).rows[0],
    ).toMatchObject({ consumed_at: null, revoked_at: expect.any(Date) });
    await page.reload();
    await page.getByLabel("Email", { exact: true }).fill(recipient.email);
    await page.getByRole("button", { name: "Request recovery link" }).click();
    await expect(page.getByRole("status")).toContainText(
      "If recovery is available",
    );
    const oldId = id;
    id = (
      await owner.query(
        "SELECT id FROM web_account_recoveries WHERE account_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL",
        [recipient.account],
      )
    ).rows[0].id;
    expect(id).not.toBe(oldId);
    await deliverSyntheticCredential(
      owner,
      id,
      directory,
      "http://localhost:15173",
      "recovery",
    );
    const replacement = JSON.parse(
      await readFile(resolve(directory, id + ".json"), "utf8"),
    );
    expect(replacement.url).not.toBe(message.url);
    await page.goto(replacement.url);
    await expect(
      page.getByRole("heading", { name: "Set a new password", exact: true }),
    ).toBeVisible();
    expect(new URL(page.url()).hash).toBe("");
    const password = "Synthetic-browser-recovered-873!";
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Repeat password").fill(password);
    await page
      .getByLabel("I confirm changing the password and closing old sessions")
      .check();
    await page
      .getByRole("button", { name: "Reset password", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("Password changed");
    expect(
      (
        await owner.query(
          "SELECT count(*)::int n FROM admin_sessions WHERE admin_user_id=$1 AND revoked_at IS NULL",
          [recipient.account],
        )
      ).rows[0].n,
    ).toBe(0);
    await existing.reload();
    await expect(existing).toHaveURL(/\/login/);
    await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await page.getByLabel("Email", { exact: true }).fill(recipient.email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).not.toHaveURL(/\/login/);
    await page.goto("http://localhost:15173/account");
    await expect(
      page.getByRole("heading", { name: "Account security", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
    console.log(
      "PASS Chrome recovery request, owner cancellation, replacement request, recipient reset, old-session sign-out and new-password login",
    );
  } catch (error) {
    console.error("Recovery browser HTTP diagnostics", errors);
    for (let i = 0; i < contexts.length; i++) {
      const lastPage = contexts[i].pages().at(-1);
      if (lastPage)
        await lastPage
          .screenshot({ path: `.local/recovery-failure-${i}.png` })
          .catch(() => {});
    }
    throw error;
  } finally {
    closing = true;
    for (const c of contexts) await c.close();
    await browser.close();
    for (const name of await readdir(directory))
      await unlink(resolve(directory, name));
    await rmdir(directory);
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
}
