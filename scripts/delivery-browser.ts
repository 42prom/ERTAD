import { chromium, expect as baseExpect } from "@playwright/test";
import type { AddressInfo } from "node:net";
import { deliverSecurityMailBatch } from "../backend/src/modules/identity/mailDelivery";
import { createApp } from "../backend/src/app";
import { createLocalAdminRouter } from "../backend/src/localAdmin";
import pino from "pino";
const expect = baseExpect.configure({ timeout: 30000 });
export async function verifyDeliveryBrowser(ctx: any, send: any) {
  const webOrigin=process.env.ERTAD_BROWSER_WEB_ORIGIN??'http://localhost:15173';
  const { app, access, owner, contact } = ctx;
  const original = await contact(),
    email = "browser-recipient@example.test";
  await owner.query(
    "UPDATE organization_member_labels SET display_name='Browser email recipient' WHERE organization_id=$1 AND member_id=$2",
    [access.organizationId, original.member],
  );
  // Fresh HTTP budgets exclude setup/negative API traffic while keeping actual limits intact.
  const browserApp = createApp(
    {
      postgres: async () => {},
      redis: async () => {},
      storage: async () => {},
    },
    pino({ level: "silent" }),
    webOrigin,
    createLocalAdminRouter(webOrigin, () => access),
  );
  const server = browserApp.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [],
    messages: any[] = [];
  let current: any;
  let closing=false;
  const closingContexts=new Set<unknown>();
  const sender = async (policy: unknown, message: any) => {
    messages.push({ ...message });
    return send(policy, message);
  };
  async function pageFor(index?: number) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
    });
    await context.addInitScript(() => {
      if (!localStorage.getItem("ertad.console.language"))
        localStorage.setItem("ertad.console.language", "en");
    });
    await context.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith("/api/")) return route.continue();
      try{
        const response = await route.fetch({url: endpoint + url.pathname + url.search});
        if (response.status() >= 400 && ![401, 428].includes(response.status()))
          console.log("Delivery browser HTTP", url.pathname, response.status());
        await route.fulfill({ response });
      }catch{
        if(!closing&&!closingContexts.has(context))errors.push('Test API transport failed');
        await route.abort().catch(()=>{});
      }
    });
    const page = await context.newPage();
    current = page;
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);
    page.on("pageerror", (error) => errors.push(error.message));
    if (index !== undefined) {
      await page.goto(webOrigin+"/login");
      await page
        .getByLabel("Email", { exact: true })
        .fill(access.accounts[index].email);
      await page
        .getByLabel("Password", { exact: true })
        .fill(access.accounts[index].password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL((u) => u.pathname === "/dashboard");
      console.log("Delivery browser: login completed");
    }
    return page;
  }
  try {
    console.log("Delivery browser: issuer login and contact entry");
    const issuer = await pageFor(2);
    await issuer.goto(webOrigin+"/invitations");
    await issuer
      .getByRole("button", { name: "Add member email", exact: true })
      .click();
    console.log("Delivery browser: selecting candidate");
    await issuer
      .getByLabel("Member and unit", { exact: true })
      .selectOption(original.unit + ":" + original.member);
    await issuer.getByLabel("Member email", { exact: true }).fill(email);
    await issuer
      .getByLabel(
        "The selected member supplied this address and agreed to receive an invitation.",
        { exact: true },
      )
      .check();
    await issuer
      .getByLabel("Your password", { exact: true })
      .fill(access.accounts[2].password);
    await issuer
      .getByRole("button", { name: "Save contact", exact: true })
      .click();
    console.log("Delivery browser: waiting for contact result");
    await expect(
      issuer.getByText(
        "Contact saved. Create an invitation and submit it for independent approval.",
        { exact: true },
      ),
    ).toBeVisible();
    const bound = (
      await owner.query("SELECT id FROM web_invite_contacts WHERE email=$1", [
        email,
      ])
    ).rows[0].id;
    await issuer.getByLabel("Recipient", { exact: true }).selectOption(bound);
    await issuer
      .getByLabel("Reason", { exact: true })
      .fill("Browser reviewed real-contact flow");
    await issuer
      .getByLabel("I confirm submitting this invitation", { exact: true })
      .check();
    const [response] = await Promise.all([
      issuer.waitForResponse(
        (r) => r.url().endsWith("/collective/propose") && r.status() === 200,
      ),
      issuer
        .getByRole("button", { name: "Submit for approval", exact: true })
        .click(),
    ]);
    const proposal = (await response.json()).id;
    console.log("Delivery browser: waiting for the unchanged API rate window");
    await new Promise((r) => setTimeout(r, 60000));
    console.log("Delivery browser: independent review");
    const reviewer = await pageFor(3);
    await reviewer.goto(webOrigin+"/approvals");
    await reviewer
      .locator("tr[data-proposal-id='" + proposal + "']")
      .getByRole("button")
      .click();
    await reviewer
      .getByLabel("Review reason", { exact: true })
      .fill("Independent browser contact association review");
    await reviewer
      .getByRole("button", { name: "Record decision", exact: true })
      .click();
    await expect(reviewer.getByText("Saved.", { exact: true })).toBeVisible();
    closingContexts.add(issuer.context());closingContexts.add(reviewer.context());
    await issuer.context().close();
    await reviewer.context().close();
    await deliverSecurityMailBatch(sender);
    const proof = messages.find(
      (m) => m.id === proposal && m.purpose === "contact",
    );
    expect(proof).toBeTruthy();
    const recipient = await pageFor();
    console.log("Delivery browser: recipient email confirmation");
    await recipient.goto(
      webOrigin+"/verify-email#" + proof.id + "." + proof.token,
    );
    await expect(
      recipient.getByRole("heading", {
        name: "Confirm email address",
        exact: true,
      }),
    ).toBeVisible();
    expect(new URL(recipient.url()).hash).toBe("");
    expect(
      (
        await owner.query(
          "SELECT verified_at FROM web_invite_contacts WHERE id=$1",
          [bound],
        )
      ).rows[0].verified_at,
    ).toBeNull();
    for (const language of ["en", "ka"])
      for (const theme of ["light", "dark"]) {
        // Public page does not contain theme controls; set the persisted preference before loading.
        await recipient.evaluate(
          ({ language, theme }) => {
            localStorage.setItem("ertad.console.language", language);
            localStorage.setItem("ertad.console.theme", theme);
          },
          { language, theme },
        );
        await recipient.reload();
        await recipient.goto(
          webOrigin+"/verify-email#" + proof.id + "." + proof.token,
        );
        await expect(recipient.locator("html")).toHaveAttribute(
          "lang",
          language,
        );
        await expect(recipient.locator("html")).toHaveAttribute(
          "data-theme",
          theme,
        );
        await expect(recipient.getByRole('heading',{name:language==='ka'?'ელფოსტის დადასტურება':'Confirm email address',exact:true})).toBeVisible();
        for (const width of [360, 390, 768, 1440]) {
          await recipient.setViewportSize({ width, height: 1000 });
          expect(
            await recipient.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
          ).toBe(true);
        }
        await recipient.screenshot({
          path: ".local/email-proof-" + language + "-" + theme + ".png",
        });
      }
    await recipient.evaluate(() =>
      localStorage.setItem("ertad.console.language", "en"),
    );
    await recipient.reload();
    await recipient.goto(
      webOrigin+"/verify-email#" + proof.id + "." + proof.token,
    );
    await recipient.getByRole("checkbox").check();
    await recipient
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    await expect(
      recipient.getByText(/Email confirmed. An activation link will follow/),
    ).toBeVisible();
    await deliverSecurityMailBatch(sender);
    const activation = messages.find(
      (m) => m.id === proposal && m.purpose === "invitation",
    );
    expect(activation).toBeTruthy();
    console.log("Delivery browser: account activation and login");
    await recipient.goto(
      webOrigin+"/activate#" +
        activation.id +
        "." +
        activation.token,
    );
    const password = "Synthetic-browser-password-492!";
    await recipient.getByLabel("Password", { exact: true }).fill(password);
    await recipient
      .getByLabel("Repeat password", { exact: true })
      .fill(password);
    await recipient.getByRole("checkbox").check();
    await recipient
      .getByRole("button", { name: "Activate account", exact: true })
      .click();
    await expect(recipient.getByText(/Account activated/)).toBeVisible();
    await recipient.goto(webOrigin+"/login");
    await recipient.getByLabel("Email", { exact: true }).fill(email);
    await recipient.getByLabel("Password", { exact: true }).fill(password);
    await recipient
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await recipient.waitForURL((u) => u.pathname === "/dashboard");
    console.log('Delivery browser: recovery with a fresh unchanged API rate window');
    await new Promise(r=>setTimeout(r,60000));
    await recipient.getByRole('button',{name:'Logout',exact:true}).click();
    await recipient.waitForURL(u=>u.pathname==='/login');
    await recipient.goto(webOrigin+'/recover');
    await recipient.getByLabel('Email',{exact:true}).fill(email);
    await recipient.getByRole('button',{name:'Request recovery link',exact:true}).click();
    await expect(recipient.getByText(/If recovery is available for that contact/)).toBeVisible();
    await deliverSecurityMailBatch(sender);
    const recovery=messages.find(m=>m.purpose==='recovery'&&m.email===email);expect(recovery).toBeTruthy();
    await recipient.goto(webOrigin+'/recover#'+recovery.id+'.'+recovery.token);
    const recoveredPassword='Synthetic-browser-recovered-493!';
    await recipient.getByLabel('Password',{exact:true}).fill(recoveredPassword);
    await recipient.getByLabel('Repeat password',{exact:true}).fill(recoveredPassword);
    await recipient.getByRole('checkbox').check();
    await recipient.getByRole('button',{name:'Reset password',exact:true}).click();
    await expect(recipient.getByText(/Password changed and old sessions closed/)).toBeVisible();
    await recipient.goto(webOrigin+'/login');
    await recipient.getByLabel('Email',{exact:true}).fill(email);
    await recipient.getByLabel('Password',{exact:true}).fill(recoveredPassword);
    await recipient.getByRole('button',{name:'Sign in',exact:true}).click();
    await recipient.waitForURL(u=>u.pathname==='/dashboard');
    const issuerResult=await pageFor(2);
    await issuerResult.goto(webOrigin+'/invitations');
    await expect(
      issuerResult
        .locator("tr")
        .filter({ hasText: "Browser email recipient" }),
    ).toContainText('Activated');
    expect(errors).toEqual([]);
    console.log(
      "PASS delivery Chrome: scoped contact entry, independent review, email proof, separate activation, recovery and normal login; public language/theme/viewport checks",
    );
  } catch (error) {
    console.error(
      "Delivery browser diagnostic",
      current
        ? {
            path: new URL(current.url()).pathname,
            labels: await current.locator("label").allTextContents(),
            alerts: await current.locator('[role="alert"]').allTextContents(),
            errors,
          }
        : errors,
    );
    if (current)
      await current.screenshot({ path: ".local/delivery-browser-error.png" });
    throw error;
  } finally {
    closing=true;
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
