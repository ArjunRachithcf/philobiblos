// The first admin, the household, an invited adult, signing out and in, on one fresh Shelf. Names come from
// seed-sample/household.json (Alex, Sam, Kid 1), all invented.
import { expect, test, type Browser } from '@playwright/test';
import { PORT } from './env';
import { addAuthenticator, expectAccessible, noForeignRequests, setupLink } from './support';

const ORIGIN = `http://localhost:${PORT}`;
test.describe.configure({ mode: 'serial' });

let invite = '';

test('a new Shelf asks for its first admin', async ({ page }) => {
  const done = noForeignRequests(page, ORIGIN);
  await page.goto('/');
  await expect(page.getByText('Shelf needs its first admin.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toHaveCount(0);
  await expectAccessible(page, 'sign-in, setup needed');
  done();
});

test('the setup link makes Alex the admin with a passkey, then the household is set up', async ({ page }) => {
  const done = noForeignRequests(page, ORIGIN);
  await addAuthenticator(page);
  await page.goto(setupLink());
  await expect(page).toHaveURL(`${ORIGIN}/setup`); // the token left the address bar
  await expect(page.getByRole('heading', { name: 'Set up Shelf' })).toBeFocused();
  await expectAccessible(page, 'setup');
  await page.getByLabel('Your name').fill('Alex');
  await page.getByRole('button', { name: 'Create a passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Household' })).toBeVisible();
  await expect(page.getByText('Alex (you)')).toBeVisible();
  await expectAccessible(page, 'household');

  await page.getByLabel('Name', { exact: true }).fill('Sam');
  await page.getByRole('button', { name: 'Add them' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Sam' })).toContainText('No passkey yet');
  await page.getByLabel('Name', { exact: true }).fill('Kid 1');
  await page.getByLabel('Role').selectOption('kid');
  await page.getByLabel('Birth year').fill('2021');
  await page.getByRole('button', { name: 'Add the kid' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Kid 1' })).toContainText('Kid · 3–5 years');
  await expect(page.getByRole('button', { name: 'Invite Kid 1 to make a passkey' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Invite Sam to make a passkey' }).click();
  const link = page.getByLabel(/Send it to Sam yourself/);
  await expect(link).toHaveValue(new RegExp(`^${ORIGIN}/enrol#`));
  invite = await link.inputValue();
  await expectAccessible(page, 'household with an invite');
  await expect(page.getByRole('heading', { name: 'Your passkeys' })).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test-results/household.png', fullPage: true });

  // a phone: no sideways scrolling, still accessible
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/household-phone.png', fullPage: true });
  await expectAccessible(page, 'household on a phone');
  await page.setViewportSize({ width: 1280, height: 720 });

  // reduced transparency: the glass bar turns solid
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  expect(await page.locator('header.bar').evaluate((el) => getComputedStyle(el).backdropFilter)).toBe('none');
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  await expectAccessible(page, 'sign-in');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByText('Alex (you)')).toBeVisible();
  done();
});

test('Sam makes a passkey from the invite and sees the household, without the admin\'s controls', async ({ browser }) => {
  const page = await (await (browser as Browser).newContext()).newPage();
  await addAuthenticator(page);
  await page.goto(invite);
  await expect(page.getByRole('heading', { name: 'Welcome, Sam' })).toBeVisible();
  await expectAccessible(page, 'enrol');
  await page.getByRole('button', { name: 'Create a passkey' }).click();
  await expect(page.getByText('Sam (you)')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Add someone' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Remove/ })).toHaveCount(0);
  // the link worked once
  const again = await (await (browser as Browser).newContext()).newPage();
  await again.goto(invite);
  await expect(again.getByRole('alert')).toContainText('unknown, used or expired');
});

test('reduced motion is honoured; the phone layout is accessible', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  await page.screenshot({ path: 'test-results/sign-in-phone.png' });
  expect(await page.evaluate(() => window.HL.still())).toBe(true);
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(scroll).toBe(true);
  await expectAccessible(page, 'sign-in on a phone');
});
