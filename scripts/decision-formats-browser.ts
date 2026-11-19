import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function runDecisionFormatsBrowser(
  app: Express,
  access: DemoAccess,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    origin = "http://localhost:15173";
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  const survey = "Synthetic five-question survey",
    referendum = "Synthetic meeting referendum",
    election = "Synthetic browser committee election";
  try {
    for (const [iteration, index] of [2, 3, 2, 3].entries()) {
      console.log("Waiting for unchanged API rate window before formats phase");
      await new Promise((resolve) => setTimeout(resolve, 60000));
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      let closing = false;
      await context.addInitScript(() => {
        if (!localStorage.getItem("ertad.console.language"))
          localStorage.setItem("ertad.console.language", "en");
      });
      await context.route("**/api/**", async (route) => {
        try {
          const url = new URL(route.request().url());
          if (!url.pathname.startsWith("/api/")) {
            await route.continue();
            return;
          }
          const response = await route.fetch({
            url: endpoint + url.pathname + url.search,
          });
          await route.fulfill({ response });
        } catch {
          if (!closing) errors.push("API transport failure");
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("response", response => {
        const path = new URL(response.url()).pathname;
        if (path.startsWith("/api/") && response.status() >= 400 && !(path.endsWith("/auth/me") && response.status() === 401))
          errors.push(`HTTP ${response.status()} ${path}`);
      });
      try {
        await page.goto(origin + "/login");
        await page
          .getByRole("button", {
            name: new RegExp(
              access.accounts[index].email.replaceAll(".", "\\."),
            ),
          })
          .click();
        await expect(
          page.getByRole("heading", { name: "Workspace", exact: true }),
        ).toBeVisible();
        await page.getByRole("link", { name: "Polls", exact: true }).click();
        const open = (title: string) =>
          page
            .getByRole("button", { name: "Open: " + title, exact: true })
            .click();
        const confirm = () =>
          page
            .getByRole("checkbox", {
              name: "I reviewed the poll rules and deadline and confirm the selected action.",
            })
            .check();
        const saved = () =>
          expect(
            page.getByText("Action saved.", { exact: true }),
          ).toBeVisible();
        if (iteration === 0) {
          await page.goto(origin + "/create-poll");
          await expect(
            page.getByRole("heading", { name: "New poll", exact: true }),
          ).toBeVisible();
          await page.getByLabel("Title", { exact: true }).fill(survey);
          await page
            .getByLabel("Description", { exact: true })
            .fill("Synthetic survey covering every response type");
          await page
            .getByLabel("Audience — region or group", { exact: true })
            .selectOption(access.accounts[2].unitId);
          await page.getByLabel("Poll type", { exact: true }).selectOption("survey");
          for (const [q, type] of [
            "single_choice",
            "multiple_choice",
            "text",
            "rating_scale",
            "ranked_choice",
          ].entries()) {
            if (q > 0)
              await page
                .getByRole("button", {
                  name: "Add another question",
                  exact: true,
                })
                .click();
            await page
              .getByLabel("Question " + (q + 1), { exact: true })
              .fill("Synthetic question " + (q + 1));
            await page
              .getByLabel("Question type", { exact: true })
              .nth(q)
              .selectOption(type);
            if (
              ["single_choice", "multiple_choice", "ranked_choice"].includes(
                type,
              )
            ) {
              await page
                .getByLabel(`Option ${q + 1}.1`, { exact: true })
                .fill("First option");
              await page
                .getByLabel(`Option ${q + 1}.2`, { exact: true })
                .fill("Second option");
            }
          }
          await page
            .getByRole("button", { name: "Move question up", exact: true })
            .nth(4)
            .click();
          await page
            .getByRole("button", { name: "Move question down", exact: true })
            .nth(3)
            .click();
          const firstQuestion = page.locator(".survey-question-card").first();
          await firstQuestion.locator("summary").click();
          await expect(
            page.getByLabel("Question 1", { exact: true }),
          ).toBeHidden();
          await firstQuestion.locator("summary").click();
          await expect(
            page.getByLabel("Question 1", { exact: true }),
          ).toHaveValue("Synthetic question 1");
          await page
            .getByLabel("Response placeholder", { exact: true })
            .fill("Your synthetic feedback");
          await page
            .getByLabel("Minimum label", { exact: true })
            .fill("Not useful");
          await page
            .getByLabel("Maximum label", { exact: true })
            .fill("Very useful");
          await page.locator(".decision-preview > summary").click();
          await expect(
            page.getByPlaceholder("Your synthetic feedback"),
          ).toBeVisible();
          await expect(
            page.getByPlaceholder("Your synthetic feedback"),
          ).toBeDisabled();
          await expect(
            page
              .locator(".decision-preview")
              .getByText("1 — Not useful; 5 — Very useful", { exact: true }),
          ).toBeVisible();
          await page.locator(".decision-preview > summary").click();
          await page.screenshot({
            path: ".local/formats-survey-composer.png",
            fullPage: true,
          });
          await page.setViewportSize({ width: 390, height: 1000 });
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await page.screenshot({
            path: ".local/formats-survey-composer-mobile.png",
            fullPage: true,
          });
          await page.setViewportSize({ width: 1440, height: 1000 });
          await page
            .getByRole("button", { name: "Save draft", exact: true })
            .click();
          await saved();
          await open(survey);
          await page.getByRole("button", { name: "Edit", exact: true }).click();
          await expect(
            page.getByLabel("Poll type", { exact: true }),
          ).toHaveValue("survey");
          await expect(
            page.getByLabel("Question 5", { exact: true }),
          ).toHaveValue("Synthetic question 5");
          await expect(
            page.getByLabel("Response placeholder", { exact: true }),
          ).toHaveValue("Your synthetic feedback");
          await expect(
            page.getByLabel("Maximum label", { exact: true }),
          ).toHaveValue("Very useful");
          await page
            .getByLabel("Description", { exact: true })
            .fill("Edited synthetic survey");
          await page
            .getByRole("button", { name: "Save draft", exact: true })
            .click();
          await saved();
          await open(survey);
          await confirm();
          await page
            .getByRole("button", { name: "Publish", exact: true })
            .click();
          await saved();
          await open(survey);
        } else if (iteration === 1) await open(survey);
        if (iteration < 2) {
          const fieldsets = page.locator(".survey-response fieldset");
          await fieldsets
            .nth(0)
            .getByRole("radio", {
              name: iteration === 0 ? "First option" : "Second option",
              exact: true,
            })
            .check();
          await fieldsets
            .nth(1)
            .getByRole("checkbox", { name: "First option", exact: true })
            .check();
          await page
            .getByLabel("Synthetic question 3", { exact: true })
            .fill("Synthetic feedback " + iteration);
          await page
            .getByLabel("Synthetic question 4", { exact: true })
            .selectOption(iteration === 0 ? "2" : "4");
          await page
            .getByLabel("Synthetic question 5 — Rank 1", { exact: true })
            .selectOption(iteration === 0 ? "0" : "1");
          await page
            .getByLabel("Synthetic question 5 — Rank 2", { exact: true })
            .selectOption(iteration === 0 ? "1" : "0");
          await confirm();
          await page
            .getByRole("button", { name: "Submit responses", exact: true })
            .click();
          await saved();
          await open(survey);
          await expect(
            page.getByText("Your participation is recorded.", { exact: true }),
          ).toBeVisible();
          if (iteration === 1) {
            await confirm();
            await page
              .getByRole("button", { name: "Close poll", exact: true })
              .click();
            await saved();
            await open(survey);
            await expect(
              page.getByText("Average rating: 3", { exact: true }),
            ).toBeVisible();
            await page.screenshot({
              path: ".local/formats-survey-results.png",
              fullPage: true,
            });
            await page
              .getByRole("button", { name: "Back", exact: true })
              .click();
            await page
              .getByRole("button", { name: "Create", exact: true })
              .click();
            await page.getByLabel("Title", { exact: true }).fill(referendum);
            await page
              .getByLabel("Audience — region or group", { exact: true })
              .selectOption(access.accounts[2].unitId);
            await page
              .getByLabel("Poll type", { exact: true })
              .selectOption("referendum");
            await page
              .getByLabel("Approval threshold (%)", { exact: true })
              .fill("60");
            await page
              .getByRole("button", { name: "Save draft", exact: true })
              .click();
            await saved();
            await open(referendum);
            await confirm();
            await page
              .getByRole("button", { name: "Publish", exact: true })
              .click();
            await saved();
            await open(referendum);
            await page.getByRole("radio", { name: "Yes", exact: true }).check();
            await confirm();
            await page
              .getByRole("button", { name: "Submit vote", exact: true })
              .click();
            await saved();
          }
        } else if (iteration === 2) {
          await open(referendum);
          await page
            .getByRole("radio", { name: "Abstain", exact: true })
            .check();
          await confirm();
          await page
            .getByRole("button", { name: "Submit vote", exact: true })
            .click();
          await saved();
          await open(referendum);
          await confirm();
          await page
            .getByRole("button", { name: "Close poll", exact: true })
            .click();
          await saved();
          await open(referendum);
          await expect(
            page.getByText("Referendum outcome: Accepted", { exact: true }),
          ).toBeVisible();
          await page.screenshot({
            path: ".local/formats-referendum-results.png",
          });
          await page.getByRole("button", { name: "Back", exact: true }).click();
          await page
            .getByRole("button", { name: "Create", exact: true })
            .click();
          await page.getByLabel("Poll type", { exact: true }).selectOption("election");
          await expect(
            page.getByLabel("Poll type", { exact: true }),
          ).toHaveValue("election");
          await page.getByLabel("Title", { exact: true }).fill(election);
          await page
            .getByLabel("Candidate 1", { exact: true })
            .fill("Synthetic candidate A");
          await page
            .getByLabel("Candidate 2", { exact: true })
            .fill("Synthetic candidate B");
          await page
            .getByRole("button", { name: "Add candidate", exact: true })
            .click();
          await page
            .getByLabel("Candidate 3", { exact: true })
            .fill("Synthetic candidate C");
          await page.locator(".decision-preview > summary").click();
          await expect(
            page
              .locator(".decision-preview")
              .getByRole("radio", {
                name: "Synthetic candidate C",
                exact: true,
              }),
          ).toBeDisabled();
          await page.locator(".decision-preview > summary").click();
          await page
            .getByRole("button", { name: "Save draft", exact: true })
            .click();
          await saved();
          await open(election);
          await page.getByRole("button", { name: "Edit", exact: true }).click();
          await expect(
            page.getByLabel("Candidate 3", { exact: true }),
          ).toHaveValue("Synthetic candidate C");
          await page
            .getByRole("button", { name: "Save draft", exact: true })
            .click();
          await saved();
          await open(election);
          await confirm();
          await page
            .getByRole("button", { name: "Publish", exact: true })
            .click();
          await saved();
          await open(election);
          await page
            .getByRole("radio", { name: "Synthetic candidate A", exact: true })
            .check();
          await confirm();
          await page
            .getByRole("button", { name: "Submit vote", exact: true })
            .click();
          await saved();
        } else {
          await open(election);
          await expect(
            page.getByText("Choose one candidate", { exact: true }),
          ).toBeVisible();
          await page
            .getByRole("radio", { name: "Synthetic candidate B", exact: true })
            .check();
          await confirm();
          await page
            .getByRole("button", { name: "Submit vote", exact: true })
            .click();
          await saved();
          await open(election);
          await confirm();
          await page
            .getByRole("button", { name: "Close poll", exact: true })
            .click();
          await saved();
          await open(election);
          await expect(
            page.getByText("Result: tie", { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("progressbar", {
              name: "Synthetic candidate A",
              exact: true,
            }),
          ).toHaveAttribute("value", "1");
          await page.screenshot({
            path: ".local/formats-election-results.png",
          });
          await page.getByRole("button", { name: "Back", exact: true }).click();
          for (const language of ["ka", "en"])
            for (const theme of ["light", "dark"])
              for (const width of [360, 390, 768, 1440]) {
                await setConsoleAppearance(page, language, theme);
                await page.setViewportSize({ width, height: 1000 });
                await expect(
                  page.getByRole("heading", { name: election, exact: true }),
                ).toBeVisible();
                expect(
                  await page.evaluate(
                    () => document.documentElement.scrollWidth <= innerWidth,
                  ),
                ).toBe(true);
              }
        }
      } catch (error) {
        await page.screenshot({
          path: ".local/formats-browser-failure.png",
          fullPage: true,
        });
        console.error(
          "Formats page failure",
          error,
          errors,
          await page.evaluate(() => ({
            path: location.pathname,
            text: document.body.innerText.slice(0, 1400),
          })),
        );
        throw error;
      }
      closing = true;
      await context.close();
    }
    expect(errors).toEqual([]);
    console.log(
      "PASS restored formats: five-question survey metadata/preview/edit/publish/respond/results; referendum threshold/abstention/results; election candidates/preview/edit/publish/two votes/tied results; responsive themes",
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
