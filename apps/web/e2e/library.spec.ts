// The Library on a Shelf with the sample seed imported (seed-sample/, all invented): Alex claims the imported admin,
// marks books, writes a takeaway, looks at Sam's library (no takeaways, no controls) and acts for Kid 2.
import { expect, test } from '@playwright/test';
import { SEEDED_PORT, dataDir } from './env';
import { addAuthenticator, expectAccessible, noForeignRequests, setupLink } from './support';

const ORIGIN = `http://localhost:${SEEDED_PORT}`;
test.describe.configure({ mode: 'serial' });

test('the library: statuses, a takeaway, another adult\'s and a kid\'s', async ({ page }) => {
  const done = noForeignRequests(page, ORIGIN);
  await addAuthenticator(page);
  await page.goto(setupLink(dataDir(SEEDED_PORT)));
  await page.getByLabel('Your name').fill('Alex');
  await page.getByRole('button', { name: 'Create a passkey' }).click();
  await expect(page.getByText('Alex (you)')).toBeVisible();
  // the imported household, not a new admin
  await expect(page.getByText('Kid 2')).toBeVisible();

  await page.getByRole('link', { name: 'Library' }).click();
  await expect(page.getByRole('heading', { name: 'Library', level: 1 })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Your books' })).toBeVisible();
  const status = page.getByRole('radiogroup', { name: 'Status of The Long Tide of Markets' });
  await expect(status.getByRole('radio', { name: 'Read', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expectAccessible(page, 'library');

  // keyboard: arrows move along the status like a native radio group
  await status.getByRole('radio', { name: 'Read', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(status.getByRole('radio', { name: 'Reading', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('listitem').filter({ hasText: 'Reading' }).first()).toBeVisible();

  // marking it read asks for a takeaway
  await status.getByRole('radio', { name: 'Read', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Finished The Long Tide of Markets' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel('Takeaway (optional)')).toBeFocused();
  await expectAccessible(page, 'takeaway prompt');
  await sheet.getByLabel('Takeaway (optional)').fill('Prices leave out most of what matters.');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByText('Prices leave out most of what matters.')).toBeVisible();

  // the AI switch: off until Alex turns it on
  const ai = page.getByRole('switch', { name: 'Let the AI read my takeaways' });
  await expect(ai).not.toBeChecked();
  await ai.click();
  await expect(ai).toBeChecked();
  await ai.click();
  await expect(ai).not.toBeChecked();

  // Sam's library: statuses only, no controls, and never Alex's takeaway
  await page.getByRole('radiogroup', { name: 'Whose library' }).getByRole('radio', { name: 'Sam', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sam’s books' })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: /^Status of/ })).toHaveCount(0);
  await expect(page.getByText('Prices leave out')).toHaveCount(0);
  await expect(page.getByText('Takeaways', { exact: true })).toHaveCount(0);
  await expectAccessible(page, 'another adult\'s library');

  // Kid 2: the emotional map, and feedback by an adult
  await page.getByRole('radiogroup', { name: 'Whose library' }).getByRole('radio', { name: 'Kid 2' }).click();
  await expect(page.getByRole('heading', { name: 'Kid 2’s emotional map' })).toBeVisible();
  const first = page.getByRole('radiogroup', { name: /^How Kid 2 liked/ }).first();
  await first.getByRole('radio', { name: 'Loved', exact: true }).click();
  await expect(first.getByRole('radio', { name: 'Loved', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText(/1 loved/)).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test-results/library-kid.png', fullPage: true });
  await expectAccessible(page, 'a kid\'s library');

  // a phone: no sideways scrolling, still accessible
  await page.getByRole('radiogroup', { name: 'Whose library' }).getByRole('radio', { name: 'Alex (you)' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Your books' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test-results/library-phone.png', fullPage: true });
  await expectAccessible(page, 'library on a phone');
  done();
});
