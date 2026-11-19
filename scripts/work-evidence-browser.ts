import { chromium, expect as baseExpect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
import sharp from "sharp";
const expect = baseExpect.configure({ timeout: 30000 });
export async function verifyEvidenceBrowser(
  app: Express,
  access: DemoAccess,
  material = false,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  const bytes = material
      ? await sharp({
          create: { width: 32, height: 24, channels: 3, background: "red" },
        })
          .png()
          .toBuffer()
      : Buffer.from(
          "Synthetic browser completion report\nსინთეზური ანგარიში\n",
        ),
    title = "Synthetic browser evidence";
  try {
    for (const index of material ? [2, 3, 4] : [3, 2, 4]) {
      console.log(
        `Evidence browser account ${index}: pacing unchanged rate window`,
      );
      await new Promise((r) => setTimeout(r, 60000));
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        acceptDownloads: true,
      });
      let closing = false,
        loggedIn = false;
      await context.addInitScript(() => {
        if (!localStorage.getItem("ertad.console.language"))
          localStorage.setItem("ertad.console.language", "en");
      });
      await context.route("**/api/**", async (route) => {
        const u = new URL(route.request().url());
        if (!u.pathname.startsWith("/api/")) return route.continue();
        try {
          await route.fulfill({
            response: await route.fetch({
              url: endpoint + u.pathname + u.search,
            }),
          });
        } catch (e) {
          if (!closing)
            errors.push(
              "Transport " +
                u.pathname +
                ": " +
                String(e instanceof Error ? e.message : e).split(/\r?\n/, 1)[0],
            );
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("response", (r) => {
        const path = new URL(r.url()).pathname;
        if (!loggedIn && path === "/api/v1/admin/auth/me" && r.status() === 401)
          return;
        // No channel permission is granted by the evidence fixture.
        if (path === "/api/v1/admin/channels/work" && r.status() === 403)
          return;
        if (path.startsWith("/api/") && r.status() >= 400)
          errors.push(`HTTP ${r.status()} ${path}`);
      });
      try {
        await page.goto("http://localhost:15173/login");
        await page
          .getByRole("button", {
            name: new RegExp(
              access.accounts[index].email.replaceAll(".", "\\."),
            ),
          })
          .click();
        await page.waitForURL((url) => url.pathname !== "/login");
        loggedIn = true;
        await page.goto("http://localhost:15173/tasks");
        await expect(
          page.getByRole("heading", { name: "Tasks", exact: true }),
        ).toBeVisible();
        if (index === 4) {
          await expect(page.getByText(/1 · Total: /)).toBeVisible();
          await expect(page.getByRole("alert")).toHaveCount(0);
          await expect(
            page.getByRole("button", { name: new RegExp(title) }),
          ).toHaveCount(0);
          console.log("PASS sibling region cannot discover evidence task");
          continue;
        }
        await page.getByRole("button", { name: new RegExp(title) }).click();
        let panel = page.getByRole("region", {
          name: material ? "Photos and documents" : "Completion reports",
          exact: true,
        });
        if (index === (material ? 2 : 3)) {
          await panel
            .getByLabel(material ? "Photo or PDF" : "Text report", {
              exact: true,
            })
            .setInputFiles({
              name: material ? "synthetic.png" : "report.txt",
              mimeType: material ? "image/png" : "text/plain",
              buffer: bytes,
            });
          await panel
            .getByRole("button", {
              name: material ? "Upload file" : "Upload report",
              exact: true,
            })
            .click();
          await expect(
            panel.getByText(material ? "File uploaded." : "Report uploaded.", {
              exact: true,
            }),
          ).toBeVisible();
        }
        const downloading = page.waitForEvent("download");
        await panel
          .getByRole("button", {
            name: material ? "Download file" : "Download report",
            exact: true,
          })
          .click();
        const download = await downloading;
        expect(download.suggestedFilename()).toBe(
          material ? "task-material.png" : "task-report.txt",
        );
        const downloaded = await readFile((await download.path())!);
        if (material) {
          const metadata = await sharp(downloaded).metadata();
          expect(metadata.format).toBe("png");
          expect(metadata.width).toBe(32);
          if (index === 3) {
            await expect(panel.getByLabel("Photo or PDF")).toHaveCount(0);
            await expect(
              panel.getByRole("button", { name: "Remove file" }),
            ).toHaveCount(0);
          }
        } else expect(downloaded).toEqual(bytes);
        expect(new URL(page.url()).search).not.toContain(access.organizationId);
        if (index === 2) {
          for (const language of ["en", "ka"])
            for (const theme of ["light", "dark"]) {
              await setConsoleAppearance(page, language, theme);
              if (
                !(await page
                  .getByRole("heading", { name: title, exact: true })
                  .count())
              )
                await page
                  .getByRole("button", { name: new RegExp(title) })
                  .click();
              panel = page.getByRole("region", {
                name:
                  language === "ka"
                    ? material
                      ? "ფოტოები და დოკუმენტები"
                      : "შესრულების ანგარიშები"
                    : material
                      ? "Photos and documents"
                      : "Completion reports",
                exact: true,
              });
              await expect(
                panel.getByRole("button", {
                  name:
                    language === "ka"
                      ? material
                        ? "ფაილის ჩამოტვირთვა"
                        : "ანგარიშის ჩამოტვირთვა"
                      : material
                        ? "Download file"
                        : "Download report",
                  exact: true,
                }),
              ).toBeVisible();
              await expect(panel.getByRole("alert")).toHaveCount(0);
              for (const width of [360, 390, 768, 1440]) {
                await page.setViewportSize({ width, height: 1000 });
                expect(
                  await page.evaluate(
                    () =>
                      document.documentElement.scrollWidth <= innerWidth + 1,
                  ),
                ).toBe(true);
              }
              await page.screenshot({
                path: `.local/${material ? "files" : "evidence"}-${language}-${theme}.png`,
                fullPage: true,
              });
            }
        }
        console.log(
          `PASS evidence browser account ${index}: private report download and scope`,
        );
      } catch (e) {
        if (errors.length) console.error("Evidence browser requests", errors);
        await page.screenshot({
          path: ".local/evidence-browser-failure.png",
          fullPage: true,
        });
        throw e;
      } finally {
        closing = true;
        await context.close();
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
