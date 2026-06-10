const { test, expect } = require('./_setup');

// A structurally-valid (unsigned) JWT so supabase-js accepts the mocked session.
function fakeJwt(sub) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, role: 'authenticated', aud: 'authenticated', exp: now + 3600, iat: now })}.sig`;
}

test.describe('sign in', () => {
  test('shows an error on invalid credentials', async ({ page }) => {
    await page.route('**/auth/v1/token**', (r) =>
      r.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials' }),
      })
    );

    await page.goto('/');
    await page.locator('#si-email').fill('nobody@example.com');
    await page.locator('#si-pw').fill('wrong-password');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.locator('#signin-error')).toBeVisible();
    await expect(page.locator('#signin-error')).toContainText(/invalid/i);
    // Must NOT have entered the app.
    await expect(page.locator('#screen-app')).not.toHaveClass(/active/);
  });

  test('valid credentials enter the app (backend mocked)', async ({ page }) => {
    const SUB = '00000000-0000-0000-0000-000000000001';

    await page.route('**/auth/v1/token**', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: fakeJwt(SUB),
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: 'fake-refresh-token',
          user: { id: SUB, email: 'tester@example.com', aud: 'authenticated', role: 'authenticated' },
        }),
      })
    );
    await page.route('**/auth/v1/user**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: SUB, email: 'tester@example.com' }) })
    );
    // _loadProfile reads prep_users (.maybeSingle). Return an ALREADY-ONBOARDED
    // member (guidelines_accepted_at set) so enterApp() falls through to the app
    // instead of the first-run guidelines gate. Any other table read → empty.
    await page.route('**/rest/v1/**', (r) => {
      if (r.request().url().includes('/prep_users')) {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: SUB, email: 'tester@example.com', name: 'Tester',
            region: 'Victoria, Australia', timezone: 'Australia/Melbourne',
            guidelines_accepted_at: '2026-01-01T00:00:00Z',
          }),
        });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.route('**onrender.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

    await page.goto('/');
    // Stub E2EE key setup so the test targets the sign-in → enterApp transition,
    // not WebCrypto key generation (covered separately by the app's own logic).
    await page.evaluate(() => {
      window._initE2EEWithPassword = async () => {};
    });

    await page.locator('#si-email').fill('tester@example.com');
    await page.locator('#si-pw').fill('correct-horse-battery');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.locator('#screen-app')).toHaveClass(/active/, { timeout: 10_000 });
    // No error state was raised (the `show` class is how the error surfaces).
    await expect(page.locator('#signin-error')).not.toHaveClass(/show/);
  });
});
