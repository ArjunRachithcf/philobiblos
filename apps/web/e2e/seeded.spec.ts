// A Shelf with the sample seed imported (seed-sample/, all invented), one browser for the whole file: Alex claims the
// imported admin; the Library (books marked, a takeaway, Sam's library without takeaways or controls, Kid 2's); the
// Backlog (the filter bar, labels, tabs, a score's parts, grouping, bulk actions, a book added); the budget; the Brain
// (the map and its table, views, the panel) and the proposals waiting for a decision (confirm, reject, a layer change);
// the Inbox, share tokens and phone shares.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { expect, request, test, type Page } from '@playwright/test';
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

test('the AI: Ollama by default; Claude only after the list of what leaves is ticked, its key never shown again', async () => {
  const done = noForeignRequests(page, ORIGIN);
  const card = page.getByRole('region', { name: 'The AI' });
  await expect(card.getByText(/nothing leaves your home network/)).toBeVisible();
  await card.getByLabel('Provider').selectOption('claude');
  await expect(card.getByText('With Claude, this goes to Anthropic:')).toBeVisible();
  await expect(card.getByText(/Never: anyone's name, the delivery address/)).toBeVisible();
  await expect(card.getByText(/One adult's read books, up to 60/)).toBeVisible();
  await card.getByLabel(/Anthropic API key/).fill('sk-ant-e2e-' + 'x'.repeat(30));
  await card.getByRole('button', { name: 'Save the AI settings' }).click();
  await expect(card.getByRole('alert')).toContainText('Tick that you read');
  await card.getByLabel(/I read this/).check();
  await expectAccessible(page, 'settings, the AI opt-in');
  await card.getByRole('button', { name: 'Save the AI settings' }).click();
  await expect(card.getByText('Claude is on. This leaves the server:')).toBeVisible();
  await expect(card.getByLabel(/Anthropic API key \(saved/)).toHaveValue('');
  expect(await page.content()).not.toContain('sk-ant-e2e-');
  // Back to Ollama, and the key removed, for the tests after this one.
  await card.getByLabel('Provider').selectOption('ollama');
  await card.getByRole('button', { name: 'Save the AI settings' }).click();
  await expect(card.getByText(/nothing leaves your home network/)).toBeVisible();
  await card.getByRole('button', { name: 'Remove the Claude key' }).click();
  await expect(card.getByText('The key is removed.')).toBeVisible();
  done();
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

test('this month: picks, the budget bar by keyboard, a pick removed, Compose', async () => {
  const done = noForeignRequests(page, ORIGIN);
  // where orders go (admins; the delivery address is sealed and never shown again)
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('The bookshop’s e-mail address').fill('orders@bookshop.example');
  await page.getByLabel(/^Delivery address/).fill('Alex Example\nExample Street 1\n8000 Zurich');
  await page.getByRole('button', { name: 'Save where orders go' }).click();
  await expect(page.getByText('The delivery address is kept sealed')).toBeVisible();
  await expect(page.getByLabel(/^Delivery address \(saved/)).toHaveValue('');
  // Settings is longer than the window now (phone share below): measured from the top, as it opens, since a target
  // scrolled under the sticky bar counts as obscured.
  await page.evaluate(() => scrollTo(0, 0));
  await expectAccessible(page, 'settings, where orders go');

  await page.getByRole('link', { name: 'This month' }).click();
  await expect(page.getByRole('heading', { name: 'This month', level: 1 })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'For you · non-fiction' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'For Kid 1' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'This month your brain grows here' })).toBeVisible();
  expect(await page.locator('svg.mo-mini:not([aria-hidden="true"])').count()).toBe(0); // the miniature is for the eye
  await expect(page.getByRole('listitem').filter({ has: page.getByText('Picked', { exact: true }) })).toHaveAttribute('aria-current', 'step');
  await expectAccessible(page, 'this month');

  // the budget bar: arrows move a draft only; a button applies it for this month
  const max = page.getByRole('slider', { name: 'Budget, highest total' });
  await expect(max).toHaveAttribute('aria-valuetext', 'CHF 180');
  await max.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(max).toHaveAttribute('aria-valuetext', 'CHF 170');
  await expect(page.getByText('Monthly budget', { exact: true })).toBeVisible(); // nothing applied yet
  await page.keyboard.press('PageDown');
  await expect(max).toHaveAttribute('aria-valuetext', 'CHF 120');
  const min = page.getByRole('slider', { name: 'Budget, lowest total' });
  await min.focus();
  await page.keyboard.press('End'); // never past the other end
  await expect(min).toHaveAttribute('aria-valuetext', 'CHF 120');
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: 'Use for this month' }).click();
  await expect(page.getByText('This month only', { exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'This month’s budget is CHF 0 to CHF 120' })).toBeAttached();
  await page.getByRole('button', { name: 'Back to the usual budget' }).click();
  await expect(page.getByText('Monthly budget', { exact: true })).toBeVisible();

  // a pick of your own comes off the list
  const remove = page.getByRole('button', { name: /^Remove .* from this month$/ }).first();
  const title = (await remove.getAttribute('aria-label'))!.replace(/^Remove (.*) from this month$/, '$1');
  await remove.click();
  await expect(page.getByRole('status').filter({ hasText: `${title} is off this month’s list.` })).toBeAttached();

  // Compose: a mailto to the bookshop with the order; the text in full, no card number
  await page.getByRole('button', { name: 'Compose the order' }).click();
  const open = page.getByRole('link', { name: 'Open in your mail app' });
  await expect(open).toHaveAttribute('href', /^mailto:orders@bookshop\.example\?subject=Book%20order%2C%20/);
  await expect(page.getByText('To: orders@bookshop.example')).toBeVisible();
  const text = await page.getByLabel('The order text').inputValue();
  expect(text).toContain('Example Street 1');
  expect(text).not.toMatch(/\b(?:\d[ -]?){13,19}\b|card number/i);
  await expect(page.getByRole('listitem').filter({ has: page.getByText('Composed', { exact: true }) })).toHaveAttribute('aria-current', 'step');
  await expectAccessible(page, 'this month, composed');

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/month-phone.png', fullPage: true });
  await expectAccessible(page, 'this month on a phone');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: 'test-results/month.png', fullPage: true });
  done();
});

test('the inbox, share tokens with their QR code, and phone shares (by token, by hand, through the share target)', async () => {
  const done = noForeignRequests(page, ORIGIN);
  // The bookshop's mail as the mail job keeps it (invented): an invoice with lines that matched no book, and a forgery.
  const db = new DatabaseSync(join(dataDir(SEEDED_PORT), 'shelf.sqlite'), { timeout: 5000 });
  const now = new Date().toISOString();
  db.prepare('INSERT INTO mail_seen (message_id, kind, parsed_json, parser_version, seen_at, auth_json, accepted) VALUES (?, ?, ?, ?, ?, ?, ?)').run('<e2e-inv@orellfuessli.ch>', 'invoice', JSON.stringify({ invoiceNumber: '99001122', lines: [
    { ean: '9780000000330', title: 'Gardens of the Commons', qty: 1, priceC: 1500, totalC: 1500, vatPct: 2.6, bookId: null },
    { ean: null, notBook: true, title: 'Wooden Train Set', qty: 1, priceC: 3900, totalC: 3900, vatPct: 8.1, bookId: null },
  ] }), 'm3d-1/invoice-1', now, '{}', 1);
  db.prepare('INSERT INTO mail_seen (message_id, kind, parsed_json, parser_version, seen_at, auth_json, accepted) VALUES (?, ?, ?, ?, ?, ?, ?)').run('unverified:e2e', 'not_verified', null, 'm3d-1', now, JSON.stringify({ accepted: false, reason: 'not from the bookshop', fromDomain: 'phish.example' }), 0);
  db.close();

  await page.getByRole('link', { name: 'Inbox' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Invoice 99001122' })).toBeVisible();
  await expect(page.getByText('not from the bookshop')).toBeVisible();
  await expect(page.getByText('phish.example')).toHaveCount(0);
  await expectAccessible(page, 'inbox');
  await page.getByRole('button', { name: 'Add to the library: Gardens of the Commons' }).click();
  await expect(page.getByText('Gardens of the Commons: added.')).toBeAttached();
  await expect(page.getByRole('button', { name: /Gardens of the Commons/ })).toHaveCount(0);
  // A toy can only be skipped; focus moved to it.
  await expect(page.getByRole('button', { name: /^Add.*Wooden Train Set/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Skip Wooden Train Set' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Invoice 99001122' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '1 mail not verified' })).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss 1 mail not verified' }).click();
  // The sample seed's shares are in the backlog already: nothing is left to ask.
  await expect(page.getByRole('heading', { name: 'Nothing waiting' })).toBeVisible();

  // A share token: shown once, with its QR code; gone from the page after Done.
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('Name of the phone or Shortcut').fill('Alex’s iPhone');
  await page.getByRole('button', { name: 'Make a share token' }).click();
  await expect(page.getByRole('img', { name: 'QR code of the Shortcut’s Authorization value' })).toBeVisible();
  const auth = await page.getByLabel(/^Authorization/).inputValue();
  expect(auth).toMatch(/^Bearer [0-9A-HJKMNP-TV-Z]{26}[A-Za-z0-9_-]{43}$/);
  await page.evaluate(() => scrollTo(0, 0)); // as above: nothing measured while scrolled under the sticky bar
  await expectAccessible(page, 'a new share token');
  await page.getByRole('button', { name: 'Done' }).click();
  expect(await page.content()).not.toContain(auth.slice(7));
  await expect(page.getByRole('button', { name: 'Revoke Alex’s iPhone' })).toBeVisible();

  // The Shortcut's request: the token alone, no Origin, no cookie.
  const ctx = await request.newContext({ baseURL: ORIGIN });
  const r = await ctx.post('/api/shares', { headers: { authorization: auth }, multipart: { url: 'https://example.org/p/7', text: 'A caption from the Shortcut' } });
  expect(r.status()).toBe(202);
  // Without the service worker, the share target's POST changes nothing on the server.
  const offline = await ctx.post('/share-target', { multipart: { text: 'x' }, maxRedirects: 0 });
  expect([offline.status(), offline.headers().location]).toEqual([303, '/share?offline=1']);
  await ctx.dispose();

  // By hand on the share screen: progress, then done.
  await page.goto('/share');
  await expect(page.getByRole('heading', { name: 'Share to Shelf', level: 1 })).toBeVisible();
  await page.getByLabel('Link').fill('https://example.org/p/8');
  await page.getByLabel('Note').fill('Recommended by a friend');
  await expectAccessible(page, 'share by hand');
  await page.getByRole('button', { name: 'Send to the Inbox' }).click();
  await expect(page.getByText('In your Inbox.')).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  await expectAccessible(page, 'a share sent');

  // The share target: the phone's POST is the service worker's; the share screen then posts it as Shelf's own page.
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  const landed = await page.evaluate(async () => {
    const f = new FormData();
    f.append('title', 'A post about gardens');
    f.append('text', 'Three books on the commons https://example.org/p/9');
    return (await fetch('/share-target', { method: 'POST', body: f })).url;
  });
  expect(landed).toMatch(/\/share\?pending=[0-9a-f-]{36}$/);
  await page.goto(landed);
  // Nothing is sent until the person taps Send.
  await expect(page.getByRole('heading', { name: 'Send this to your Inbox?' })).toBeVisible();
  await expect(page.getByText('Three books on the commons https://example.org/p/9')).toBeVisible();
  await expectAccessible(page, 'a share waiting for the tap');
  await page.getByRole('button', { name: 'Send to the Inbox' }).click();
  await expect(page.getByText('In your Inbox.')).toBeVisible();
  await expect(page).toHaveURL(/\/share\?id=[0-9A-Z]{26}$/);

  await page.getByRole('link', { name: 'Open the Inbox' }).click();
  await expect(page.getByRole('heading', { name: 'A post about gardens' })).toBeVisible();
  await expect(page.getByText('Recommended by a friend')).toBeVisible();
  await expect(page.getByText('A caption from the Shortcut')).toBeVisible();
  await expectAccessible(page, 'inbox with shares');
  done();
});

test('another website cannot post a share through the share target: the share screen waits for the tap (PR #17 review)', async () => {
  // The service worker is installed (the test before). A page of another origin submits a form to the share target.
  const other = await page.context().newPage();
  await other.route('http://evil.test/**', (r) => r.fulfill({ contentType: 'text/html', body: `<!doctype html><form id="f" method="post" enctype="multipart/form-data" action="${ORIGIN}/share-target"><input name="text" value="A share nobody made https://evil.test/x"><input name="url" value="https://evil.test/x"></form><script>document.getElementById('f').submit()</script>` }));
  const posted: string[] = [];
  other.on('request', (r) => { if (r.method() === 'POST' && r.url().startsWith(`${ORIGIN}/api/shares`)) posted.push(r.method()); });
  await other.goto('http://evil.test/');
  await other.waitForURL(/\/share\?pending=[0-9a-f-]{36}$/);
  await expect(other.getByRole('heading', { name: 'Send this to your Inbox?' })).toBeVisible();
  await expect(other.getByText('A share nobody made https://evil.test/x')).toBeVisible();
  // Focus is on the heading, never on Send: keys the other site times for the person send nothing.
  await expect(other.getByRole('heading', { name: 'Send this to your Inbox?' })).toBeFocused();
  for (const key of ['Enter', 'Space', 'Enter']) await other.keyboard.press(key);
  await other.waitForTimeout(1500);
  expect(posted).toEqual([]);
  // Discard comes first in the tab order; Send says it is disabled while the moment after the screen is shown lasts
  // (shelf#18), and that moment starts again whenever the screen comes back into view: another tab brought forward, or
  // the page restored from the browser's page cache.
  const send = other.getByRole('button', { name: 'Send to the Inbox' });
  await other.keyboard.press('Tab');
  await expect(other.getByRole('button', { name: 'Discard' })).toBeFocused();
  await expect(send).toHaveAttribute('aria-disabled', 'false');
  const setVisible = (v: boolean) => other.evaluate((visible) => {
    Object.defineProperty(document, 'visibilityState', { value: visible ? 'visible' : 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, v);
  await setVisible(false);
  await expect(send).toHaveAttribute('aria-disabled', 'true');
  await setVisible(true);
  await expect(send).toHaveAttribute('aria-disabled', 'true');
  // A click while it is disabled (forced: Playwright itself waits for an enabled button) sends nothing.
  await send.click({ force: true });
  await expect(send).toHaveAttribute('aria-disabled', 'false');
  await other.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(send).toHaveAttribute('aria-disabled', 'true');
  await send.click({ force: true });
  await other.waitForTimeout(300);
  expect(posted).toEqual([]);
  const inbox = await (await page.request.get('/api/inbox?filter=shared')).json() as { items: { share?: { url?: string } }[] };
  expect(inbox.items.map((i) => i.share?.url)).not.toContain('https://evil.test/x');
  const landed = other.url();
  await other.getByRole('button', { name: 'Discard' }).click();
  await expect(other.getByRole('heading', { name: 'Send this to your Inbox?' })).toHaveCount(0);
  // Discarded: the same link opens nothing.
  await other.goto(landed);
  await expect(other.getByText(/sent or discarded already/)).toBeVisible();
  expect(posted).toEqual([]);
  // Only an explicit activation of Send posts: once more from the other site, then a click on Send.
  await other.goto('http://evil.test/');
  await other.waitForURL(/\/share\?pending=[0-9a-f-]{36}$/);
  await expect(send).toHaveAttribute('aria-disabled', 'false');
  await send.click();
  await expect(other.getByText('In your Inbox.')).toBeVisible();
  expect(posted).toEqual(['POST']);
  const after = await (await page.request.get('/api/inbox?filter=shared')).json() as { items: { id: string; share?: { url?: string } }[] };
  const made = after.items.find((i) => i.share?.url === 'https://evil.test/x')!;
  expect((await page.request.post(`/api/inbox/${made.id}/dismiss`, { headers: { origin: ORIGIN } })).status()).toBe(204);
  await other.close();
});

test('an empty first page with more after it is followed: never "Nothing waiting" next to "Show more" (PR #17 review)', async () => {
  // 2,100 settled (dismissed) mails newer than the one still waiting: more than a page reads.
  const db = new DatabaseSync(join(dataDir(SEEDED_PORT), 'shelf.sqlite'), { timeout: 5000 });
  const ins = db.prepare("INSERT INTO mail_seen (message_id, kind, parsed_json, parser_version, seen_at, auth_json, accepted) VALUES (?, 'unknown_layout', ?, 'v', ?, '{}', 1)");
  const dis = db.prepare("INSERT INTO inbox_decision (item, idx, decision, decided_at) VALUES (?, -1, 'dismissed', 'x')");
  const itemId = (key: string) => `m_${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32)}`;
  db.exec('BEGIN');
  ins.run('<e2e-old@orellfuessli.ch>', JSON.stringify({ subject: 'An old quote Shelf could not read', reason: 'a price Shelf cannot place' }), '2020-01-01T00:00:00.000Z');
  for (let i = 0; i < 2100; i++) { ins.run(`<e2e-d${i}@orellfuessli.ch>`, '{}', '2030-01-01T00:00:00.000Z'); dis.run(itemId(`<e2e-d${i}@orellfuessli.ch>`)); }
  db.exec('COMMIT');
  db.close();
  await page.goto('/inbox');
  await expect(page.getByRole('heading', { name: 'An old quote Shelf could not read' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nothing waiting' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Dismiss An old quote Shelf could not read' }).click();
  await expect(page.getByRole('heading', { name: 'An old quote Shelf could not read' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
});
