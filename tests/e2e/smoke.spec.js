const { test, expect } = require('./_setup');

test.describe('boot & landing', () => {
  test('loads with no uncaught errors and shows the landing screen', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/app/');

    await expect(page).toHaveTitle(/Preparing You/);
    await expect(page.locator('#screen-landing')).toHaveClass(/active/);
    await expect(page.locator('.landing-title')).toHaveText('Preparing You');

    // Sign-in is the default panel.
    await expect(page.locator('#panel-signin')).toBeVisible();
    await expect(page.locator('#si-email')).toBeVisible();
    await expect(page.locator('#si-pw')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await expect(page.getByText('Forgot your password?')).toBeVisible();

    expect(errors, 'no uncaught page errors on boot').toEqual([]);
  });

  // A single 5,874-line inline script means one bad edit can wipe out every
  // function below it. This asserts the critical globals survived parsing.
  test('core globals are defined', async ({ page }) => {
    await page.goto('/app/');
    // Bare `typeof` (not `window.X`): top-level `const`/`let` like E2EE live in
    // the global lexical scope, not as window properties.
    const probe = await page.evaluate(() => ({
      reportError: typeof _reportError,
      e2ee: typeof E2EE,
      doSignIn: typeof doSignIn,
      doJoin: typeof doJoin,
      showAuthTab: typeof showAuthTab,
      enterApp: typeof enterApp,
    }));
    expect(probe).toEqual({
      reportError: 'function',
      e2ee: 'object',
      doSignIn: 'function',
      doJoin: 'function',
      showAuthTab: 'function',
      enterApp: 'function',
    });
  });

  test('PWA assets are served', async ({ request }) => {
    for (const path of ['/manifest.json', '/sw.js', '/icon-512.png', '/ark-mark.png']) {
      const res = await request.get(path);
      expect(res.status(), `${path} should be 200`).toBe(200);
    }
  });
});
