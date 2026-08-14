const { test, expect } = require('./_setup');

test.describe('sign in', () => {
  test('shows an error on invalid credentials', async ({ page }) => {
    await page.route('**/auth/v1/token**', (r) =>
      r.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials' }),
      })
    );

    await page.goto('/app/');
    await page.locator('#si-email').fill('nobody@example.com');
    await page.locator('#si-pw').fill('wrong-password');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.locator('#signin-error')).toBeVisible();
    await expect(page.locator('#signin-error')).toContainText(/invalid/i);
    // Must NOT have entered the app.
    await expect(page.locator('#screen-app')).not.toHaveClass(/active/);
  });

  // Deterministic check of the post-auth routing enterApp() performs — driven
  // directly so it's free of supabase-js/CDN/network timing (which made a
  // click-through mock chronically flaky). A member who hasn't accepted the
  // community guidelines is held at the first-run gate; an onboarded member lands
  // in the app. This is the exact gate that silently caught out an earlier mock.
  // The REAL doSignIn + supabase error handling is exercised by the test above.
  test('first-run gate: new member is gated, onboarded member enters the app', async ({ page }) => {
    await page.goto('/app/');

    // No guidelines_accepted_at → held at the guidelines gate, NOT the app.
    await page.evaluate(() => {
      currentUser = { id: 'u1', email: 'tester@example.com', name: 'Tester', region: '' };
      try { enterApp(); } catch (_) {}
    });
    await expect(page.locator('#guidelines-gate')).toBeVisible();
    await expect(page.locator('#screen-app')).not.toHaveClass(/active/);

    // guidelines accepted → into the app.
    await page.evaluate(() => {
      currentUser = { id: 'u1', email: 'tester@example.com', name: 'Tester', region: '', guidelines_accepted_at: '2026-01-01T00:00:00Z' };
      try { enterApp(); } catch (_) {}
    });
    await expect(page.locator('#screen-app')).toHaveClass(/active/);
    await expect(page.locator('#screen-landing')).not.toHaveClass(/active/);
  });
});
