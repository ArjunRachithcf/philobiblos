// Two first calls for the application server key at once (GET /push/key and a subscription, or two servers starting):
// one key is made and both get it. The race is made certain here: while the first call makes its key, the second one
// runs to its end.
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import type { Db } from '../src/db/open';
import { vapidKeys } from '../src/push/push';
import type * as WebPush from '../src/push/webpush';
import type { VapidKeys } from '../src/push/webpush';
import { TEST_SEALING_KEY, household } from './helpers';

const race: { during?: () => void } = {};
vi.mock('../src/push/webpush', async (orig) => {
  const real = await orig<typeof WebPush>();
  return {
    ...real,
    newVapidKeys: () => {
      const k = real.newVapidKeys();
      const other = race.during;
      race.during = undefined;
      other?.();
      return k;
    },
  };
});

const cfg = loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY });

describe('the application server key, made once', () => {
  it('two first calls at once: one key, and both callers get it', () => {
    const db: Db = household();
    let second: VapidKeys | undefined;
    race.during = () => { second = vapidKeys(db, cfg); };
    const first = vapidKeys(db, cfg);
    expect(second).toBeDefined();
    expect(first.publicKey.equals(second!.publicKey)).toBe(true);
    expect(vapidKeys(db, cfg).publicKey.equals(first.publicKey)).toBe(true);
  });
});
