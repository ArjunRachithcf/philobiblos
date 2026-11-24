// The first admin, the household, an invited adult, signing out and in, on one fresh Philobiblos. Names come from
// seed-sample/household.json (Alex, Sam, Kid 1), all invented.
import { expect, test, type Browser } from '@playwright/test';
import { PORT } from './env';
import { addAuthenticator, expectAccessible, noForeignRequests, setupLink } from './support';

const ORIGIN = `http://localhost:${PORT}`;
test.describe.configure({ mode: 'serial' });

let invite = '';

test('a new Philobiblos asks for its first admin', async ({ page }) => {
  const done = noForeignRequests(page, ORIGIN);
  await page.goto('/');
  await expect(page.getByText('Philobiblos needs its first admin.')).toBeVisible();
  // the button stays: an admin whose passkey a restore lost still gets in once the setup is done
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  await expectAccessible(page, 'sign-in, setup needed');
  done();
});

test('the setup link makes Alex the admin with a passkey, then the household is set up', async ({ page, browser }) => {
  const done = noForeignRequests(page, ORIGIN);
  await addAuthenticator(page);
  await page.goto(setupLink());
  await expect(page).toHaveURL(`${ORIGIN}/setup`); // the token left the address bar
  await expect(page.getByRole('heading', { name: 'Set up Philobiblos' })).toBeFocused();
  await expectAccessible(page, 'setup');
  await page.getByLabel('Your name').fill('Alex');
  await page.getByRole('button', { name: 'Create a passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Household' })).toBeVisible();
  await expect(page.getByText('Alex (you)')).toBeVisible();
  // A household of one (ADR 0011): just you, no family parts, no one waiting
  await expect(page.getByRole('heading', { name: 'You', exact: true })).toBeVisible();
  await expect(page.getByText(/Just you for now/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Waiting to join' })).toHaveCount(0);
  await expectAccessible(page, 'household');

  await page.getByLabel('Name', { exact: true }).fill('Sam');
  await page.getByRole('button', { name: 'Add them' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Sam' })).toContainText('No passkey yet');
  // a second person: the family's parts show
  await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
  await expect(page.getByText(/Just you for now/)).toHaveCount(0);
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

  // A join link (ADR 0011): the home network first, then the link; whoever opens it sees nothing of the household,
  // makes a passkey and waits, and Alex lets them in.
  await page.getByRole('region', { name: 'A link for Sam' }).getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: 'Make a join link' })).toBeDisabled();
  await page.getByLabel('A range, such as 192.0.2.0/24').fill('127.0.0.0/8');
  await page.getByRole('button', { name: 'Add the range' }).click();
  await expect(page.getByRole('button', { name: 'Remove 127.0.0.0/8' })).toBeVisible();
  await page.getByRole('button', { name: 'Make a join link' }).click();
  const joinField = page.getByLabel(/Send it yourself; it lets 5 people ask/);
  await expect(joinField).toHaveValue(new RegExp(`^${ORIGIN}/join#`));
  const joinUrl = await joinField.inputValue();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expectAccessible(page, 'household with a join link');
  const joiner = await (await browser.newContext()).newPage();
  const joinDone = noForeignRequests(joiner, ORIGIN);
  await addAuthenticator(joiner);
  await joiner.goto(joinUrl);
  await expect(joiner).toHaveURL(`${ORIGIN}/join`); // the token left the address bar
  await expect(joiner.getByLabel('Your name')).toBeEnabled();
  await expect(joiner.locator('body')).not.toContainText(/Alex|Sam|Kid 1/);
  await expectAccessible(joiner, 'join');
  await joiner.getByLabel('Your name').fill('Jordan');
  await joiner.getByRole('button', { name: 'Ask to join' }).click();
  await expect(joiner.getByText('Waiting for approval.')).toBeVisible();
  await expect(joiner.locator('body')).not.toContainText(/Alex|Sam|Kid 1/);
  joinDone();
  await page.reload();
  await expect(page.getByRole('listitem').filter({ hasText: 'Jordan' }).first()).toContainText('Alex’s join link · ');
  await expect(page.getByRole('listitem').filter({ hasText: 'Jordan' }).first()).toContainText('from the home network');
  await page.getByRole('button', { name: 'Approve Jordan as an adult' }).click();
  await expect(page.getByText('Jordan is in the household now, as an adult.')).toBeAttached();
  await joiner.reload();
  await expect(joiner.getByText('Jordan (you)')).toBeVisible();

  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  await expectAccessible(page, 'sign-in');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByText('Alex (you)')).toBeVisible();

  // another device: Alex's own one-time link, then a passkey there
  await expect(page.getByRole('button', { name: 'Invite Sam to make a passkey' })).toBeVisible();
  await page.getByRole('button', { name: 'Add a passkey on another device' }).click();
  const own = page.getByLabel(/Open it on the other device/);
  await expect(own).toHaveValue(new RegExp(`^${ORIGIN}/enrol#`));
  const ownLink = await own.inputValue();
  const other = await (await browser.newContext()).newPage();
  await addAuthenticator(other);
  await other.goto(ownLink);
  await expect(other.getByRole('heading', { name: 'Welcome, Alex' })).toBeVisible();
  await other.getByRole('button', { name: 'Create a passkey' }).click();
  await expect(other.getByText('Alex (you)')).toBeVisible();
  await expect(other.getByRole('button', { name: /Remove the passkey/ })).toHaveCount(2);
  await expectAccessible(other, 'household with two passkeys');

  // sign out everywhere: both browsers are signed out
  other.once('dialog', (d) => void d.accept());
  await other.getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(other.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
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
