// A Shelf with the sample seed imported (seed-sample/, all invented), one browser for the whole file: Alex claims the
// imported admin; the Library (books marked, a takeaway, Sam's library without takeaways or controls, Kid 2's); the
// Backlog (the filter bar, labels, tabs, a score's parts, grouping, bulk actions, a book added); the budget; the Brain
// (the map and its table, views, the panel) and the proposals waiting for a decision (confirm, reject, a layer change).
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
  await page.unroute('**/api/people/*/brain');
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

  // an empty menu: one disabled item to focus, axe passes, Escape closes it
  await bar.fill('is:open is:kids');
  await bar.press('Enter');
  const ideaMenu = page.getByRole('button', { name: /^Filter by idea/ });
  await ideaMenu.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Nothing to filter by' })).toBeFocused();
  await expect(page.getByRole('menuitem', { name: 'Nothing to filter by' })).toHaveAttribute('aria-disabled', 'true');
  await expectAccessible(page, 'backlog with an empty menu');
  await page.keyboard.press('Enter'); // a disabled item does nothing
  await expect(bar).toHaveValue('is:open is:kids');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(ideaMenu).toBeFocused();
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

test('the brain: the map, its table, views; proposals confirmed, rejected and moved to another layer', async () => {
  const done = noForeignRequests(page, ORIGIN);
  await page.getByRole('link', { name: 'Brain' }).click();
  await expect(page.getByRole('heading', { name: 'Brain', level: 1 })).toBeFocused();
  const table = page.getByRole('table');
  const row = (idea: string) => table.getByRole('row').filter({ has: page.getByRole('button', { name: idea, exact: true }) });
  await expect(row('Markets and value')).toBeVisible();
  // the map is for the eye; the table says the same
  await expect(page.locator('svg.brain-map')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('svg.brain-map [data-idea]')).toHaveCount(await table.locator('tbody tr').count());
  await expectAccessible(page, 'brain');

  // choosing an idea (keyboard) shows it in the panel
  await row('Care and the commons').getByRole('button').focus();
  await page.keyboard.press('Enter');
  await expect(row('Care and the commons').getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  const panel = page.getByRole('region', { name: 'Care and the commons' });
  await expect(panel.getByText('Counterpoint')).toBeVisible();
  // and pointing at it on the map
  await page.locator('svg.brain-map [data-idea]').filter({ hasText: 'Markets and value' }).click();
  await expect(page.getByRole('region', { name: 'Markets and value' })).toBeVisible();

  // views: no focus before the month's picks; gaps
  const show = page.getByRole('radiogroup', { name: 'Show' });
  await show.getByRole('radio', { name: 'This month’s focus' }).click();
  await expect(page.getByText('No focus yet')).toBeVisible();
  await show.getByRole('radio', { name: 'Gaps' }).click();
  await show.getByRole('radio', { name: 'All ideas' }).click();
  await expect(row('Markets and value')).toBeVisible();

  // waiting for a decision: nothing counts until a person confirms it
  await page.getByRole('link', { name: 'Proposals' }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for a decision', level: 1 })).toBeFocused();
  await expectAccessible(page, 'proposals');
  await page.getByRole('button', { name: 'Confirm Markets and value on The Grand Ledger' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Markets and value on The Grand Ledger: confirmed.' })).toBeAttached();
  await expect(page.getByRole('button', { name: 'Confirm Markets and value on The Grand Ledger' })).toHaveCount(0);
  // focus moved to the next proposal's Confirm, not lost
  await expect(page.locator('.pr-row').first().locator('.pr-confirm')).toBeFocused();
  // another layer, by keyboard only: arrows on the menu button open the menu and move in it, deciding nothing
  const layer = page.getByRole('button', { name: 'Layer of Markets and value on Value Beyond Price: Core layer' });
  await layer.focus();
  await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Confirm in Intro' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitem', { name: 'Confirm in Deep' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(layer).toBeFocused();
  await expect(menu).toHaveCount(0);
  await expectAccessible(page, 'proposals, nothing decided by the arrows');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Markets and value on Value Beyond Price: confirmed, Deep layer.' })).toBeAttached();
  await expect(layer).toHaveCount(0);
  await expect(page.locator('.pr-row').first().locator('.pr-confirm')).toBeFocused();
  const reject = page.getByRole('button', { name: /^Reject / }).first();
  const rejected = (await reject.getAttribute('aria-label'))!.replace(/^Reject /, '');
  await reject.click();
  await expect(page.getByRole('button', { name: `Reject ${rejected}` })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/proposals-phone.png', fullPage: true });
  await expectAccessible(page, 'proposals on a phone');
  await page.setViewportSize({ width: 1280, height: 720 });

  // the brain now has Value Beyond Price as the next deep book on markets
  await page.getByRole('link', { name: 'Brain' }).click();
  await expect(row('Markets and value').getByRole('cell').nth(3)).toContainText('Next: Value Beyond Price');
  await page.screenshot({ path: 'test-results/brain.png', fullPage: true });

  // a fuller brain than the sample's (served by the test): a focus glows, a new idea, edges read and wished-for
  const ref = (title: string) => ({ id: title, title, authors: [], audience: 'adult', isFiction: false });
  const lay = (n: number, next?: string) => ({ books: Array.from({ length: n }, (_, k) => ref(`Book ${k + 1}`)), next: next ? ref(next) : null });
  const ideas = Array.from({ length: 9 }, (_, k) => ({
    id: `i${k}`, name: `Idea ${k}`, readCount: k === 8 ? 0 : 9 - k, unreadOwned: k % 2, isNew: k === 8, ...(k === 2 ? { focus: 'connect' } : {}),
    layers: { intro: lay(k === 8 ? 0 : 1), core: lay(k < 4 ? 2 : 0, 'A Core Book'), deep: lay(0, k === 8 ? undefined : 'A Deep Book'), counterpoint: lay(0) },
  }));
  const edges = [{ a: 'i0', b: 'i1', weight: 3, via: ['Book 1'], kind: 'read' }, { a: 'i2', b: 'i8', weight: 1, via: ['A Deep Book'], kind: 'future' }];
  await page.route('**/api/people/*/brain', (r) => r.fulfill({ json: { ideas, edges } }));
  await page.reload();
  await expect(page.locator('svg.brain-map [data-idea]')).toHaveCount(9);
  await expect(page.locator('.brain-node.is-new')).toHaveCount(1);
  await expect(row('Idea 2')).toContainText('Focus · Connect');
  await expect(page.getByRole('list').filter({ hasText: 'Would connect them: A Deep Book' })).toBeVisible();
  await show.getByRole('radio', { name: 'This month’s focus' }).click();
  await expect(table.locator('tbody tr')).toHaveCount(1);
  // outside the view the shapes fade, the words do not (labels and counts keep body text's contrast)
  expect(await page.evaluate(() => [...document.querySelectorAll('.brain-node.is-dim')].flatMap((g) => [...g.querySelectorAll('.brain-label, .brain-count')])
    .map((el) => { let o = 1; for (let n: Element | null = el; n && n.tagName !== 'svg'; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; }))).toEqual(Array(16).fill(1));
  await show.getByRole('radio', { name: 'All ideas' }).click();
  await page.screenshot({ path: 'test-results/brain-full.png', fullPage: true });
  await expectAccessible(page, 'a fuller brain');

  // reduced motion and reduced transparency: nothing moves, the panels turn solid
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.brain-halo')!).animationName)).not.toBe('none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.evaluate(() => [...document.querySelectorAll('.brain-halo, .brain-edge')].every((el) => getComputedStyle(el).animationName === 'none'))).toBe(true);
  await page.emulateMedia({ reducedMotion: null });
  await page.evaluate(() => document.documentElement.setAttribute('data-transparency', 'reduce'));
  await expectAccessible(page, 'brain, reduced transparency');
  await page.evaluate(() => document.documentElement.removeAttribute('data-transparency'));

  await page.setViewportSize({ width: 390, height: 844 });
  const wide = await page.evaluate(() => [...document.querySelectorAll('main *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && !el.closest('.brain-scroll')).map((el) => `${el.tagName}.${el.className}`).slice(0, 5));
  expect(wide).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/brain-phone.png', fullPage: true });
  await expectAccessible(page, 'brain on a phone');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.unroute('**/api/people/*/brain');
  done();
});
