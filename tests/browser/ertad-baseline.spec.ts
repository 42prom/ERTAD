import { test, expect } from '@playwright/test';

test('complete ERTAD web routes keep unauthenticated sessions at the ERTAD login', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const route of ['/dashboard', '/profiles', '/messages', '/settings/security']) {
    await page.goto(route);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'ERTAD', exact: true })).toBeVisible();
  }
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('stored administrator claims cannot unlock the transferred web; API denies login', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('admin_user', JSON.stringify({ role: 'superadmin', email: 'synthetic@example.invalid' }));
    sessionStorage.setItem('admin_csrf', 'synthetic-untrusted-claim');
  });
  await page.goto('/admin-users');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email', { exact: true }).fill('synthetic@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('synthetic-test-only-password');
  await expect(page.getByLabel('Authenticator code', { exact: true })).toHaveCount(0);
  const response = page.waitForResponse(response => response.url().includes('/api/v1/admin/auth/login'));
  await page.getByRole('button', { name: 'Sign in' }).click();
  const denied = await response;
  // The isolated build preview has a different origin and must not be added to
  // the local administrator allowlist just to make a browser test pass.
  expect([401, 403]).toContain(denied.status());
  if (denied.status() === 403) {
    expect((await denied.json()).error.code).toBe('ORIGIN_REJECTED');
    await expect(page.getByRole('alert')).toHaveText('Request origin is not allowed');
  } else {
    await expect(page.getByRole('alert')).toHaveText('Invalid credentials');
  }
  await expect(page).toHaveURL(/\/login$/);
});

test('original login fits desktop and narrow browser widths', async ({ page }) => {
  await page.goto('/login');
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
