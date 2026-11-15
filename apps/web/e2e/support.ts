import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { DATA_DIR } from './env';

/** A platform authenticator for this page's browser context: resident keys, user verification, always present. */
export async function addAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, authenticatorId };
}

export const setupLink = (dir = DATA_DIR) => readFileSync(join(dir, 'setup-link.txt'), 'utf8').trim();

/** WCAG 2.2 AA (axe's rules for 2.0, 2.1 and 2.2, A and AA), in light and dark. */
export async function expectAccessible(page: Page, name: string) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    // let colour transitions finish before measuring contrast
    await page.waitForTimeout(600);
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(' ')} ${n.any.map((a) => a.message).join(' ')}`).join(' | ')}`), `${name} (${colorScheme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** Nothing on the page asked the network for anything but Shelf itself. */
export function noForeignRequests(page: Page, origin: string) {
  const foreign: string[] = [];
  page.on('request', (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith('data:')) foreign.push(r.url()); });
  return () => expect(foreign).toEqual([]);
}
