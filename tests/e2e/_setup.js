// Shared guards for every spec.
const { test: base, expect } = require('@playwright/test');

const test = base.extend({
  page: async ({ page }, use) => {
    // Never let a test-induced error POST to the PRODUCTION error log.
    await page.route('**/client-error*', (r) => r.fulfill({ status: 204, body: '' }));

    // app.js is loaded as an external script (split out of index.html), so it can
    // finish executing a beat after the 'load' event Playwright waits for. Wrap
    // goto to also wait until app.js has defined its globals — otherwise a test
    // that references them right after navigation can flake ("_sb is not defined").
    const origGoto = page.goto.bind(page);
    page.goto = async (url, opts) => {
      const res = await origGoto(url, opts);
      await page
        .waitForFunction(() => typeof window.enterApp === 'function', null, { timeout: 10_000 })
        .catch(() => {});
      return res;
    };

    await use(page);
  },
});

module.exports = { test, expect };
