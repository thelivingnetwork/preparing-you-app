// Shared guards for every spec.
const { test: base, expect } = require('@playwright/test');

const test = base.extend({
  page: async ({ page }, use) => {
    // Never let a test-induced error POST to the PRODUCTION error log.
    await page.route('**/client-error*', (r) => r.fulfill({ status: 204, body: '' }));
    await use(page);
  },
});

module.exports = { test, expect };
