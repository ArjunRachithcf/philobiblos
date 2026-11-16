// The settings' old names (philobiblos#30): SHELF_* is read as PHILOBIBLOS_* for one release, with one warning that
// names the variables and never a value; PHILOBIBLOS_* wins when both are set; the image's defaults never win over a
// household's old name (its data would open somewhere else).
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { IMAGE_DEFAULTS, LEGACY_NAMES_UNTIL, resetLegacyEnvWarning, resolveEnv } from '@philobiblos/contracts/env';
import { loadConfig } from '../src/config';
import { VERSION } from '../src/version';

afterEach(() => resetLegacyEnvWarning());

const SECRET = 'c2VjcmV0LXNlYWxpbmcta2V5LWZvci10aGUtdGVzdC0xMjM=';

describe('SHELF_* (until 0.2.0)', () => {
  it('an old name is read as the new one', () => {
    const cfg = loadConfig({ SHELF_MODE: 'standalone', SHELF_DATA_DIR: '/srv/old-data', SHELF_ORIGIN: 'https://books.example.org', SHELF_EGRESS: 'off', SHELF_SEALING_KEY: SECRET });
    expect(cfg).toMatchObject({ dataDir: '/srv/old-data', origin: 'https://books.example.org', rpId: 'books.example.org', egress: false, sealingKey: { value: SECRET } });
    expect(cfg.dbFile).toBe('/srv/old-data/shelf.sqlite');
  });

  it('homerslab mode starts on the old names as it did', () => {
    const cfg = loadConfig({ SHELF_MODE: 'homerslab', SHELF_ORIGIN: 'https://books.example.org', SHELF_EDGE_IDENTITY: 'homerslab-v1', SHELF_TRUSTED_PROXY: '10.0.0.2', SHELF_DATA_DIR: '/data' });
    expect(cfg).toMatchObject({ mode: 'homerslab', trustedProxy: '10.0.0.2' });
  });

  it('the new name wins when both are set', () => {
    const cfg = loadConfig({ SHELF_DATA_DIR: '/srv/old', PHILOBIBLOS_DATA_DIR: '/srv/new', SHELF_ORIGIN: 'https://old.example.org', PHILOBIBLOS_ORIGIN: 'https://new.example.org' });
    expect(cfg).toMatchObject({ dataDir: '/srv/new', origin: 'https://new.example.org' });
  });

  it('warns once per process, naming the variables and never a value', () => {
    const said: string[] = [];
    const env = { SHELF_SEALING_KEY: SECRET, SHELF_IMAP_PASSWORD: 'hunter2-imap', PHILOBIBLOS_ORIGIN: 'https://x.example.org', SHELF_ORIGIN: 'https://y.example.org' };
    expect(resolveEnv(env, (m) => said.push(m))).toMatchObject({ PHILOBIBLOS_SEALING_KEY: SECRET, PHILOBIBLOS_IMAP_PASSWORD: 'hunter2-imap', PHILOBIBLOS_ORIGIN: 'https://x.example.org' });
    resolveEnv(env, (m) => said.push(m));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('SHELF_IMAP_PASSWORD, SHELF_SEALING_KEY');
    expect(said[0]).toMatch(/ignored SHELF_ORIGIN/);
    for (const v of Object.values(env)) expect(said[0]).not.toContain(v);
  });

  it('no old name, no warning', () => {
    const said: string[] = [];
    resolveEnv({ PHILOBIBLOS_DATA_DIR: '/data' }, (m) => said.push(m));
    expect(said).toEqual([]);
  });

  it('in the image, the defaults fill only what neither name sets', () => {
    expect(resolveEnv({ PHILOBIBLOS_IN_IMAGE: '1' }, () => {})).toMatchObject(IMAGE_DEFAULTS);
    const old = resolveEnv({ PHILOBIBLOS_IN_IMAGE: '1', SHELF_DATA_DIR: '/srv/old-data', SHELF_PORT: '9000' }, () => {});
    expect(old).toMatchObject({ PHILOBIBLOS_DATA_DIR: '/srv/old-data', PHILOBIBLOS_PORT: '9000', PHILOBIBLOS_KEYS_DIR: '/keys' });
    expect(loadConfig({ PHILOBIBLOS_IN_IMAGE: '1', SHELF_DATA_DIR: '/srv/old-data' })).toMatchObject({ dataDir: '/srv/old-data', host: '0.0.0.0', port: 8080, webDir: '/app/web' });
    // outside the image, no defaults of the image's
    expect(resolveEnv({}, () => {}).PHILOBIBLOS_DATA_DIR).toBeUndefined();
  });

  it('the old names go in 0.2.0: this release still reads them, the next must not', () => {
    const manifest = /^version: (\S+)$/m.exec(readFileSync(new URL('../../../contracts/homerslab-app.yaml', import.meta.url), 'utf8'))![1]!;
    for (const v of [VERSION, manifest]) {
      expect(v.split('.').slice(0, 2).join('.'), `${v}: remove SHELF_*, the shelf_session cookie and the image's shelf command (philobiblos#30)`).toBe(LEGACY_NAMES_UNTIL);
    }
  });
});
