const { test, expect } = require('./_setup');

test.beforeEach(async ({ page }) => {
  await page.goto('/app/');
});

test('switches between Sign In and Join tabs', async ({ page }) => {
  await expect(page.locator('#panel-signin')).toBeVisible();
  await expect(page.locator('#panel-join')).toBeHidden();

  await page.locator('#tab-join').click();
  await expect(page.locator('#panel-join')).toBeVisible();
  await expect(page.locator('#panel-signin')).toBeHidden();
  await expect(page.locator('#j-name')).toBeVisible();

  await page.locator('#tab-signin').click();
  await expect(page.locator('#panel-signin')).toBeVisible();
  await expect(page.locator('#panel-join')).toBeHidden();
});

test('opens the forgot-password panel and returns to sign in', async ({ page }) => {
  await page.getByText('Forgot your password?').click();
  await expect(page.locator('#panel-forgot')).toBeVisible();
  await expect(page.locator('#forgot-email')).toBeVisible();

  await page.getByText('Back to sign in').click();
  await expect(page.locator('#panel-signin')).toBeVisible();
  await expect(page.locator('#panel-forgot')).toBeHidden();
});

test('join password-match indicator validates length and equality', async ({ page }) => {
  await page.locator('#tab-join').click();

  await page.locator('#j-pw').fill('short');
  await expect(page.locator('#j-pw-match')).toContainText(/at least 8/i);

  await page.locator('#j-pw').fill('longenough1');
  await page.locator('#j-pw2').fill('longenough1');
  await expect(page.locator('#j-pw-match')).toContainText(/match/i);
});
