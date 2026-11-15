import { describe, expect, it } from 'vitest';
import { resolveIdentity } from '../src/identity';
import { loadConfig } from '../src/config';

const hl = { mode: 'homerslab' as const, trustedProxy: '172.30.0.2' };
const h = { 'x-homerslab-person': 'person-1' };

describe('X-HomersLab-Person', () => {
  it('counts only from the configured proxy', () => {
    expect(resolveIdentity(hl, '172.30.0.2', h)).toEqual({ externalId: 'person-1', via: 'homerslab' });
    expect(resolveIdentity(hl, '::ffff:172.30.0.2', h)).toEqual({ externalId: 'person-1', via: 'homerslab' });
    expect(resolveIdentity(hl, '172.30.0.3', h)).toBeNull();
    expect(resolveIdentity(hl, undefined, h)).toBeNull();
  });
  it('is ignored without a configured proxy and in standalone mode', () => {
    expect(resolveIdentity({ mode: 'homerslab', trustedProxy: null }, '172.30.0.2', h)).toBeNull();
    expect(resolveIdentity({ mode: 'standalone', trustedProxy: '172.30.0.2' }, '172.30.0.2', h)).toBeNull();
  });
  it('a repeated or empty header is refused', () => {
    expect(resolveIdentity(hl, '172.30.0.2', { 'x-homerslab-person': ['a', 'b'] })).toBeNull();
    expect(resolveIdentity(hl, '172.30.0.2', { 'x-homerslab-person': ' ' })).toBeNull();
  });
});

describe('config', () => {
  it('standalone binds to localhost by default', () => {
    expect(loadConfig({}).host).toBe('127.0.0.1');
    expect(loadConfig({}).mode).toBe('standalone');
  });
  it('refuses an unknown mode', () => {
    expect(() => loadConfig({ SHELF_MODE: 'public' })).toThrow();
  });
});
