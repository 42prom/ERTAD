import { setConsoleAppearance } from "./console-browser";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import pino from "pino";
import type pg from "pg";
import type { AddressInfo } from "node:net";
import { createLocalAdminRouter } from "../backend/src/localAdmin";
import { createApp } from "../backend/src/app";

/** Real browser UI + real scoped API; redirects only transport to the disposable DB. */
export async function runReviewBrowser({
  people,
  password,
  org,
  fresh,
  owner,
}: {
  people: { token: string; member: string; sessionId: string }[];
  password: string;
  org: string;
  fresh: () => Promise<{ positionId: string }>;
  owner: pg.Client;
}) {
  const origin = "http://127.0.0.1:15173";
  const app = createApp(
    {
      postgres: async () => {},
      redis: async () => {},
      storage: async () => {},
    },
    pino({ enabled: false }),
    origin,
    createLocalAdminRouter(origin),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
  });
  try {
    const contexts = await Promise.all(
      people.slice(0, 2).map(async (p) => {
        const context = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
        });
        await context.addInitScript(
          () =>
            localStorage.getItem("ertad.console.language") ||
            localStorage.setItem("ertad.console.language", "en"),
        );
        await context.addCookies([
          {
            name: "ertad_admin_session",
            value: p.token,
            url: origin,
            httpOnly: true,
            sameSite: "Strict",
          },
        ]);
        await context.route("**/api/**", async (route) => {
          const url = new URL(route.request().url());
          if (!url.pathname.startsWith("/api/")) {
            await route.continue();
            return;
          }
          const response = await route.fetch({
            url: endpoint + url.pathname + url.search,
          });
          await route.fulfill({ response });
        });
        return context;
      }),
    );
    const proposer = await contexts[0].newPage(),
      reviewer = await contexts[1].newPage();
    for (const page of [proposer, reviewer]) {
      page.on("pageerror", (error) =>
        console.error("Browser script error:", error.message),
      );
      page.on("response", (response) => {
        if (response.status() >= 400)
          console.error(
            "Browser response:",
            new URL(response.url()).pathname,
            response.status(),
          );
      });
    }
    await Promise.all([
      proposer.goto(origin + "/reviews"),
      reviewer.goto(origin + "/reviews"),
    ]);
    await expect(
      proposer.getByRole("heading", { name: "Requests and notifications" }),
    )
      .toBeVisible()
      .catch(async (error) => {
        console.error(
          "Synthetic browser page:",
          await proposer.locator("body").innerText(),
        );
        throw error;
      });
    const proposal = await fresh();
    await owner.query(
      "UPDATE positions SET name='Synthetic browser position' WHERE organization_id=$1 AND id=$2",
      [org, proposal.positionId],
    );
    await proposer
      .getByRole("button", { name: "Refresh", exact: true })
      .click();
    await proposer
      .getByRole("button", { name: "Propose position", exact: true })
      .click();
    await proposer
      .getByLabel("Position", { exact: true })
      .selectOption(proposal.positionId);
    await proposer
      .getByLabel("Existing member reference", { exact: true })
      .fill(people[2].member);
    await proposer
      .getByLabel("Operational reason (10–1000 characters)", { exact: true })
      .fill("Synthetic browser membership request");
    // datetime-local values are interpreted by the browser in its local timezone.
    const local = (date: Date) =>
      new Date(date.getTime() - date.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
    await proposer
      .getByLabel("Decision deadline", { exact: true })
      .fill(local(new Date(Date.now() + 3600_000)));
    await proposer
      .getByLabel("Membership valid until", { exact: true })
      .fill(local(new Date(Date.now() + 86400_000)));
    await proposer
      .getByLabel("Confirm with your password", { exact: true })
      .fill(password);
    await proposer
      .getByRole("button", { name: "Submit request", exact: true })
      .click();
    await expect(
      proposer.getByText("Request submitted.", { exact: true }),
    ).toBeVisible();
    const stored = (
      await owner.query(
        "SELECT id FROM membership_reviews WHERE organization_id=$1 AND position_id=$2",
        [org, proposal.positionId],
      )
    ).rows[0];
    assert.ok(stored);
    await proposer
      .getByRole("button", { name: "My requests", exact: true })
      .click();
    const ownRow = proposer
      .getByRole("row")
      .filter({ hasText: "Synthetic browser position" });
    await ownRow.getByRole("button", { name: /Details/ }).click();
    await expect(proposer.getByText(/cannot be decided/)).toBeVisible();
    await reviewer
      .getByRole("button", { name: "Refresh", exact: true })
      .click();
    const pending = reviewer
      .getByRole("row")
      .filter({ hasText: "Synthetic browser position" });
    await pending.getByRole("button", { name: /Details/ }).click();
    await reviewer
      .getByLabel("Decision reason (10–1000 characters)", { exact: true })
      .fill("Synthetic independent browser decision");
    await reviewer
      .getByLabel("I have reviewed the proposed change and its duration.")
      .check();
    await reviewer
      .getByLabel("Confirm with your password", { exact: true })
      .fill(password);
    await reviewer
      .getByRole("button", { name: "Approve", exact: true })
      .click();
    await expect(
      reviewer.getByText("Decision saved.", { exact: true }),
    ).toBeVisible();
    assert.equal(
      (
        await owner.query("SELECT status FROM membership_reviews WHERE id=$1", [
          stored.id,
        ])
      ).rows[0].status,
      "approved",
    );
    await proposer
      .getByRole("button", { name: "Close details", exact: true })
      .click();
    await proposer
      .getByRole("button", { name: "Notifications", exact: true })
      .click();
    await expect(
      proposer.getByText("Latest 50 permitted notifications", { exact: true }),
    ).toBeVisible();
    await proposer
      .getByRole("button", { name: "Mark as read", exact: true })
      .first()
      .click();
    await expect(
      proposer.getByText("Read", { exact: false }).first(),
    ).toBeVisible();
    await reviewer.reload();
    await reviewer
      .getByRole("button", { name: "History", exact: true })
      .click();
    await expect(reviewer.getByRole("table")).toBeVisible();
    for (const language of ["ka", "en"]) {
      for (const theme of ["light", "dark"]) {
        await setConsoleAppearance(reviewer, language, theme);
        for (const width of [360, 390, 768, 1440]) {
          await reviewer.setViewportSize({ width, height: 1000 });
          await expect(reviewer.getByRole("table")).toBeVisible();
          assert.equal(
            await reviewer.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
            true,
            `overflow ${language}/${theme}/${width}`,
          );
          assert.equal(
            await reviewer
              .locator("main")
              .evaluate(
                (element) => element.scrollWidth <= element.clientWidth,
              ),
            true,
            `content clipped ${language}/${theme}/${width}`,
          );
          assert.equal(
            await reviewer.locator("html").getAttribute("data-theme"),
            theme,
          );
          if (language === "en" && theme === "light" && width === 1440)
            await reviewer.screenshot({ path: ".local/review-desktop.png" });
          if (language === "ka" && theme === "dark" && width === 390)
            await reviewer.screenshot({ path: ".local/review-mobile.png" });
          await reviewer.locator(".review-table-scroll").focus();
          await reviewer.keyboard.press("Tab");
          assert.equal(
            await reviewer.evaluate(
              () => document.activeElement !== document.body,
            ),
            true,
          );
        }
      }
    }
    // Revocation after opening the page removes queue/count visibility on refresh.
    await owner.query(
      "UPDATE memberships SET status='suspended' WHERE user_id=$1",
      [people[1].member],
    );
    await reviewer
      .getByRole("button", { name: "Refresh", exact: true })
      .click();
    await expect(reviewer.getByText(/No review access/)).toBeVisible();
    await expect(reviewer.getByRole("table")).toHaveCount(0);
    console.log(
      "PASS real Chrome: two independent sessions, proposal/decision/notification, reload, revocation, KA/EN × light/dark × four widths, keyboard focus",
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
