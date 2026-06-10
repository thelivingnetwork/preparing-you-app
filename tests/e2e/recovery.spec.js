const { test, expect } = require('./_setup');

// Regression guard for the password-reset flow that broke twice:
// arriving via the reset link must surface the "set a new password" panel,
// NOT silently drop the user into the app.
test.describe('password-reset routing', () => {
  test('?reset=1 lands on the reset-password panel', async ({ page }) => {
    await page.goto('/?reset=1');
    await expect(page.locator('#panel-reset')).toBeVisible();
    await expect(page.locator('#reset-pw')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Set new password' })).toBeVisible();
  });

  test('the recovery-marker query is recognised', async ({ page }) => {
    await page.goto('/?reset=1');
    const recovery = await page.evaluate(() => _recoveryMode === true);
    expect(recovery, '_recoveryMode should be true for a reset link').toBe(true);
  });
});
