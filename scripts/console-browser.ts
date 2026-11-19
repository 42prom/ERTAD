import { expect, type Page } from "@playwright/test";

// Translations remain testable without reintroducing a product language selector.
export async function setConsoleAppearance(
  page: Page,
  language: string,
  theme: string,
) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  if ((await page.locator("html").getAttribute("lang")) !== language) {
    await page.evaluate(
      (value) => localStorage.setItem("ertad.console.language", value),
      language,
    );
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", language);
  }
  const label =
    theme === "light"
      ? language === "ka"
        ? "დღე"
        : "Light"
      : language === "ka"
        ? "ღამე"
        : "Dark";
  try {
    await page.locator(".console-preferences").getByRole("button", { name: label, exact: true }).click();
  } catch (error) {
    console.error('Console preference failure', await page.evaluate(() => ({
      path: location.pathname,
      language: document.documentElement.lang,
      buttons: [...document.querySelectorAll('.console-preferences button')].map(button => button.getAttribute('aria-label')),
    })));
    await page.screenshot({path:'.local/console-preference-failure.png'});
    throw error;
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}
