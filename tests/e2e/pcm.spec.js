const { test, expect } = require('./_setup');

// Regression guard for a real support bug: a member who is THEMSELVES a PCM,
// after withdrawing from their own PCM, couldn't select a new one — the PCM
// directory only showed Message/Call (peer) actions and never a "Choose" button.
// A PCM electing up the multiplication chain must still be able to choose.
test.describe('PCM directory row actions', () => {
  test('a PCM with no current PCM still gets a Choose button', async ({ page }) => {
    await page.goto('/app/');
    const html = await page.evaluate(() => {
      _pcmAmIPcm = true;                       // the viewer is a PCM…
      currentUser = { id: 'me', pcm_id: null }; // …but has no PCM of their own (withdrawn)
      return _pcmRow({ id: 'paul', name: 'Paul Bethke', region: 'Wisconsin, USA', email: 'paul@bethkefamily.com' });
    });
    expect(html).toContain('choosePcm(');   // the Choose button is present
    expect(html).toContain('Choose');
  });

  test('an established PCM (already paired) browses peers, no Choose button', async ({ page }) => {
    await page.goto('/app/');
    const html = await page.evaluate(() => {
      _pcmAmIPcm = true;
      currentUser = { id: 'me', pcm_id: 'someone-else' }; // already has a PCM
      return _pcmRow({ id: 'paul', name: 'Paul Bethke', region: 'Wisconsin, USA', email: 'paul@bethkefamily.com' });
    });
    expect(html).not.toContain('choosePcm(');         // no Choose
    expect(html).toContain('messagePcm(');            // peer actions instead
  });

  test('a regular member gets a Choose button', async ({ page }) => {
    await page.goto('/app/');
    const html = await page.evaluate(() => {
      _pcmAmIPcm = false;
      currentUser = { id: 'me', pcm_id: null };
      return _pcmRow({ id: 'paul', name: 'Paul Bethke', region: 'Wisconsin, USA', email: 'paul@bethkefamily.com' });
    });
    expect(html).toContain('choosePcm(');
  });
});
