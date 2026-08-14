const { test, expect } = require('./_setup');

// Regression guard for the password-reset flow that broke twice:
// arriving via the reset link must surface the "set a new password" panel,
// NOT silently drop the user into the app.
//
// 2026-07-09 addendum: the panel must only show when a recovery session is
// actually live. A ?reset=1 whose #access_token fragment was dropped (mobile
// email handoff) or whose one-time token was already consumed used to show
// the form anyway, and every submit died with "Auth session missing" — now
// it routes to the forgot panel with a plain explanation and a fresh start.

// Seed a live-looking supabase session in storage so getSession() resolves
// without any network round-trip (supabase-js reads it synchronously).
const SEED_SESSION = `
  localStorage.setItem('sb-qvcfgcwecykilbddgqzv-auth-token', JSON.stringify({
    access_token: 'test-access-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'test-refresh-token',
    user: { id: 'u-recovery', aud: 'authenticated', email: 'tester@example.com' },
  }));
`;

test.describe('password-reset routing', () => {
  test('?reset=1 with a live recovery session lands on the reset-password panel', async ({ page }) => {
    await page.addInitScript(SEED_SESSION);
    await page.goto('/app/?reset=1');
    await expect(page.locator('#panel-reset')).toBeVisible();
    await expect(page.locator('#reset-pw')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Set new password' })).toBeVisible();
  });

  test('the recovery-marker query is recognised', async ({ page }) => {
    await page.addInitScript(SEED_SESSION);
    await page.goto('/app/?reset=1');
    const recovery = await page.evaluate(() => _recoveryMode === true);
    expect(recovery, '_recoveryMode should be true for a reset link').toBe(true);
  });

  test('?reset=1 WITHOUT a session routes to forgot-password with an expired-link message', async ({ page }) => {
    await page.goto('/app/?reset=1');
    // The app polls ~1.5s for the session to materialize before giving up.
    await expect(page.locator('#panel-forgot')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('#forgot-error')).toContainText(/expired|already used/i);
    await expect(page.locator('#panel-reset')).not.toBeVisible();
  });

  test('submitting the reset form with no session explains instead of "Auth session missing"', async ({ page }) => {
    await page.goto('/app/');
    await page.evaluate(() => { _recoveryMode = true; showAuthTab('reset'); });
    await page.locator('#reset-pw').fill('brand-new-password-1');
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page.locator('#panel-forgot')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('#forgot-error')).toContainText(/expired|already used/i);
  });
});
