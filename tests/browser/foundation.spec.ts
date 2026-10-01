import { test, expect } from '@playwright/test';

test('theme and language survive reload; filters reset; dialog restores focus', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('combobox', { name: 'ენა', exact: true }).selectOption('en');
  await page.getByRole('banner').getByRole('combobox', { name: 'Theme', exact: true }).selectOption('dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('link', { name: 'Design system', exact: true }).click();
  await page.getByLabel('Find a component').fill('not-a-component');
  await expect(page.getByText('No examples match these filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByText('Results: 3')).toBeVisible();
  const opener = page.getByRole('button', { name: 'Open dialog' });
  await opener.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(opener).toBeFocused();
  expect(errors).toEqual([]);
});

test('system theme follows OS; no page overflow at target widths', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'ენა', exact: true }).selectOption('en');
  await page.getByRole('banner').getByRole('combobox', { name: 'Theme', exact: true }).selectOption('system');
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [360, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ['/#overview', '/#design']) {
        await page.goto(path);
        await expect(page.locator('h1')).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${path} ${theme} ${width}`).toBe(true);
      }
    }
  }
});
