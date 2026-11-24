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
    expect(cfg).toMatchObject({ mode: 'homerslab', trustedProxy: [{ cidr: '10.0.0.2/32' }] });
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

  it('an empty new name is no value: the old database file still wins, never an in-memory database', () => {
    expect(loadConfig({ SHELF_DB_FILE: '/srv/d/shelf.sqlite', PHILOBIBLOS_DB_FILE: '' }).dbFile).toBe('/srv/d/shelf.sqlite');
    expect(() => loadConfig({ PHILOBIBLOS_DB_FILE: '' })).toThrow(/PHILOBIBLOS_DB_FILE is set but empty/);
  });

  it('an empty new name is no value: the old data folder still wins, never the working folder', () => {
    expect(loadConfig({ SHELF_DATA_DIR: '/srv/d', PHILOBIBLOS_DATA_DIR: '' })).toMatchObject({ dataDir: '/srv/d', dbFile: '/srv/d/shelf.sqlite' });
    expect(loadConfig({ SHELF_DATA_DIR: '/srv/d', PHILOBIBLOS_DATA_DIR: '', PHILOBIBLOS_IN_IMAGE: '1' }).dataDir).toBe('/srv/d');
    // in the image an empty one is the image's folder; outside it, refused
    expect(loadConfig({ PHILOBIBLOS_DATA_DIR: '', PHILOBIBLOS_IN_IMAGE: '1' })).toMatchObject({ dataDir: '/data', webDir: '/app/web' });
    expect(() => loadConfig({ PHILOBIBLOS_DATA_DIR: '' })).toThrow(/PHILOBIBLOS_DATA_DIR is set but empty/);
    expect(() => loadConfig({ PHILOBIBLOS_KEYS_DIR: '' })).toThrow(/PHILOBIBLOS_KEYS_DIR is set but empty/);
  });

  it('an empty new name is no value: the old sealing key is still the key, never a new one minted', () => {
    expect(loadConfig({ SHELF_SEALING_KEY: SECRET, PHILOBIBLOS_SEALING_KEY: '' }).sealingKey).toEqual({ value: SECRET });
    expect(loadConfig({ PHILOBIBLOS_MODE: 'homerslab', PHILOBIBLOS_ORIGIN: 'https://b.example.org', PHILOBIBLOS_EDGE_IDENTITY: 'homerslab-v1', PHILOBIBLOS_TRUSTED_PROXY: '10.0.0.2', SHELF_SEALING_KEY: SECRET, PHILOBIBLOS_SEALING_KEY: '' }).sealingKey).toEqual({ value: SECRET });
  });

  it('an empty old name is no value either: nothing is read from it, and no warning', () => {
    const said: string[] = [];
    expect(resolveEnv({ SHELF_DATA_DIR: '', PHILOBIBLOS_IN_IMAGE: '1' }, (m) => said.push(m)).PHILOBIBLOS_DATA_DIR).toBe('/data');
    expect(said).toEqual([]);
  });

  it('one setting, one generation: a new name of a setting set, its other old names are ignored', () => {
    const said: string[] = [];
    const cfg = loadConfig({ SHELF_DB_FILE: '/srv/old/shelf.sqlite', PHILOBIBLOS_DATA_DIR: '/srv/new' });
    expect(cfg).toMatchObject({ dataDir: '/srv/new', dbFile: '/srv/new/shelf.sqlite' });
    resetLegacyEnvWarning();
    expect(resolveEnv({ SHELF_SEALING_KEY: SECRET, PHILOBIBLOS_SEALING_KEY_FILE: '/run/secrets/k' }, (m) => said.push(m)).PHILOBIBLOS_SEALING_KEY).toBeUndefined();
    expect(loadConfig({ SHELF_SEALING_KEY: SECRET, PHILOBIBLOS_SEALING_KEY_FILE: '/run/secrets/k' }).sealingKey).toEqual({ file: '/run/secrets/k', create: false });
    expect(said[0]).toMatch(/ignored SHELF_SEALING_KEY \(a PHILOBIBLOS_\* name of the same setting is set/);
    expect(resolveEnv({ SHELF_IMAP_PASSWORD: 'x-imap-pw', PHILOBIBLOS_IMAP_PASSWORD_FILE: '/run/secrets/p' }, () => {}).PHILOBIBLOS_IMAP_PASSWORD).toBeUndefined();
    // the other names of the setting, old, still count when no new one is set
    expect(loadConfig({ SHELF_DB_FILE: '/srv/old/x.sqlite', SHELF_DATA_DIR: '/srv/old' })).toMatchObject({ dataDir: '/srv/old', dbFile: '/srv/old/x.sqlite' });
  });

  it('the old names go in 0.2.0: this release still reads them, the next must not', () => {
    const manifest = /^version: (\S+)$/m.exec(readFileSync(new URL('../../../contracts/homerslab-app.yaml', import.meta.url), 'utf8'))![1]!;
    for (const v of [VERSION, manifest]) {
      expect(v.split('.').slice(0, 2).join('.'), `${v}: remove SHELF_*, the shelf_session cookie and the image's shelf command (philobiblos#30)`).toBe(LEGACY_NAMES_UNTIL);
    }
  });
});
