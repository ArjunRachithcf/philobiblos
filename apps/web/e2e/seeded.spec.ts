// A Shelf with the sample seed imported (seed-sample/, all invented), one browser for the whole file: Alex claims the
// imported admin; the Library (books marked, a takeaway, Sam's library without takeaways or controls, Kid 2's); the
// Backlog (the filter bar, labels, tabs, a score's parts, grouping, bulk actions, a book added); the budget.
import { expect, test, type Page } from '@playwright/test';
import { SEEDED_PORT, dataDir } from './env';
import { addAuthenticator, expectAccessible, noForeignRequests, setupLink } from './support';

const ORIGIN = `http://localhost:${SEEDED_PORT}`;
test.describe.configure({ mode: 'serial' });

let page: Page;
test.beforeAll(async ({ browser }) => { page = await (await browser.newContext({ baseURL: ORIGIN, locale: 'en-GB', timezoneId: 'Europe/Zurich' })).newPage(); });
test.afterAll(() => page.context().close());

test('the library: statuses, a takeaway, another adult\'s and a kid\'s', async () => {
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

  // keyboard (manual activation): arrows move focus only, past "Read" too; Space chooses; focus stays after the re-sort
  await status.getByRole('radio', { name: 'Read', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(status.getByRole('radio', { name: 'To read' })).toBeFocused();
  await expect(status.getByRole('radio', { name: 'Read', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await expect(status.getByRole('radio', { name: 'Reading', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(status.getByRole('radio', { name: 'Reading', exact: true })).toBeFocused();
  // stepping past "Read" to "Stopped" and back chooses nothing and asks nothing
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(status.getByRole('radio', { name: 'Stopped' })).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(status.getByRole('radio', { name: 'Reading', exact: true })).toHaveAttribute('aria-checked', 'true');

  // choosing "Read" on purpose (Enter) asks for a takeaway
  await status.getByRole('radio', { name: 'Read', exact: true }).focus();
  await page.keyboard.press('Enter');
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
  await page.setViewportSize({ width: 1280, height: 720 });
  done();
});

test('the backlog: the filter bar, labels, tabs, a score\'s parts, grouping, bulk actions, adding a book', async () => {
  const done = noForeignRequests(page, ORIGIN);
  await page.getByRole('link', { name: 'Backlog' }).click();
  await expect(page.getByRole('heading', { name: 'Backlog', level: 1 })).toBeFocused();
  const bar = page.getByRole('searchbox', { name: 'Filter backlog' }).or(page.getByLabel('Filter backlog'));
  await expect(bar).toHaveValue('is:open sort:score');
  await expect(page.getByRole('button', { name: /^\d+ open$/ })).toHaveAttribute('aria-pressed', 'true');
  await expectAccessible(page, 'backlog');

  // typing a query
  await bar.fill('is:open author:okafor');
  await bar.press('Enter');
  await expect(page.getByText('Value Beyond Price', { exact: true })).toBeVisible();
  await expect(page.getByText('Care at the Centre', { exact: true })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('q')).toBe('is:open author:okafor');

  // a score opens into its parts
  const row = page.getByRole('listitem').filter({ hasText: 'Value Beyond Price' });
  await row.getByRole('button', { name: /^Score/ }).click();
  await expect(row.getByText('Builds on books read')).toBeVisible();
  await expect(row.getByRole('button', { name: /^Score/ })).toHaveAttribute('aria-expanded', 'true');

  // a label adds its qualifier, replacing the same key
  await row.getByRole('button', { name: /filter by for:alex/ }).click();
  await expect(bar).toHaveValue('is:open author:okafor for:alex');
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(bar).toHaveValue('is:open sort:score');

  // a menu with counts, by keyboard only: arrows move and change nothing; Enter chooses
  const forMenu = page.getByRole('button', { name: /^Filter by for/ });
  await forMenu.focus();
  await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('menu', { name: /Filter by for/ });
  await expect(menu).toBeVisible();
  await expect(forMenu).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await expectAccessible(page, 'backlog with a menu open');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown'); // wraps around: still nothing applied
  await expect(bar).toHaveValue('is:open sort:score');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(forMenu).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: /^kid2/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(bar).toHaveValue('is:open sort:score for:kid2');
  await expect(forMenu).toBeFocused();
  await page.getByRole('button', { name: 'Clear' }).click();

  // sort and group are menus of radio items
  await page.getByRole('button', { name: /^Group by/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitemradio', { name: 'No groups (current)' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect(page.getByRole('heading', { name: 'Kid 2', level: 2 })).toBeVisible();
  await expectAccessible(page, 'backlog grouped');
  await page.getByRole('button', { name: /^Sort by/ }).focus();
  await page.keyboard.press('ArrowUp'); // opens on the last item: Title
  await page.keyboard.press('Enter');
  await expect(bar).toHaveValue('is:open sort:title');
  await page.getByRole('button', { name: /^Group by/ }).click();
  await page.getByRole('menuitemradio', { name: 'No groups' }).click();
  await page.getByRole('button', { name: 'Clear' }).click();

  // bulk: not for me, then it is under closed, then reopened
  await page.getByRole('checkbox', { name: 'Select Value Beyond Price' }).check();
  await expect(page.getByRole('region', { name: 'Selected books' })).toContainText('1 selected');
  await page.getByRole('button', { name: 'Not for me' }).click();
  await expect(page.getByText('Value Beyond Price', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^\d+ closed$/ }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Value Beyond Price' })).toContainText('Not for me');
  await page.getByRole('checkbox', { name: 'Select Value Beyond Price' }).check();
  await page.getByRole('button', { name: 'Reopen' }).click();
  await expect(page.getByText('Value Beyond Price', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^\d+ open$/ }).click();
  await expect(page.getByText('Value Beyond Price', { exact: true })).toBeVisible();

  // saved filters: rename one, remove one
  await page.getByRole('button', { name: 'Manage' }).click();
  await page.getByLabel('Name of Cheap & good').fill('Bargains');
  await page.getByRole('button', { name: 'Rename Cheap & good' }).click();
  await expect(page.getByRole('button', { name: 'Bargains', exact: true })).toBeVisible();
  await expectAccessible(page, 'managing saved filters');
  await page.getByRole('button', { name: 'Remove From Instagram' }).click();
  await expect(page.getByRole('button', { name: 'From Instagram', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Manage' }).click();

  // a saved filter, and a book added by hand for a kid
  await page.getByRole('button', { name: 'Kids', exact: true }).click();
  await expect(bar).toHaveValue('is:open is:kids');
  await page.getByLabel('Title').fill('A Kite for Two');
  await page.getByLabel('For', { exact: true }).selectOption({ label: 'Kid 2' });
  await page.getByRole('button', { name: 'Add to the backlog' }).click();
  await expect(page.getByText('A Kite for Two', { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test-results/backlog-phone.png', fullPage: true });
  await expectAccessible(page, 'backlog on a phone');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: 'test-results/backlog.png', fullPage: true });
  done();
});

test('the budget: an admin sets it; it is not carried over', async () => {
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Monthly budget' })).toBeVisible();
  await expect(page.getByLabel('At least (CHF)')).toHaveValue('100');
  await page.getByLabel('At most (CHF)').fill('90');
  await page.getByRole('button', { name: 'Save the budget' }).click();
  await expect(page.getByRole('alert')).toContainText('above the upper end');
  await page.getByLabel('At most (CHF)').fill('180');
  await page.getByRole('button', { name: 'Save the budget' }).click();
  await expect(page.getByText('The budget is saved.')).toBeVisible();
  await expect(page.getByText('not carried over')).toBeVisible();
  await expectAccessible(page, 'settings');
});
