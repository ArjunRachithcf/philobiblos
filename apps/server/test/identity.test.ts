import { describe, expect, it } from 'vitest';
import { resolveIdentity } from '../src/identity';
import { loadConfig } from '../src/config';
import { parseTrustedProxy } from '../src/net/proxy';

const hl = { mode: 'homerslab' as const, trustedProxy: parseTrustedProxy('172.30.0.2') };
const h = { 'x-homerslab-person': 'person-1' };

describe('X-HomersLab-Person', () => {
  it('counts only from the configured proxy', () => {
    expect(resolveIdentity(hl, '172.30.0.2', h)).toEqual({ externalId: 'person-1', name: null, role: null, via: 'homerslab' });
    expect(resolveIdentity(hl, '::ffff:172.30.0.2', h)).toEqual({ externalId: 'person-1', name: null, role: null, via: 'homerslab' });
    expect(resolveIdentity(hl, '172.30.0.3', h)).toBeNull();
    expect(resolveIdentity(hl, undefined, h)).toBeNull();
  });
  it('carries the name and a known role', () => {
    expect(resolveIdentity(hl, '172.30.0.2', { ...h, 'x-homerslab-name': 'Sam', 'x-homerslab-role': 'adult' })).toMatchObject({ name: 'Sam', role: 'adult' });
    expect(resolveIdentity(hl, '172.30.0.2', { ...h, 'x-homerslab-role': 'root' })).toMatchObject({ role: null });
  });
  it('is ignored without a configured proxy and in standalone mode', () => {
    expect(resolveIdentity({ mode: 'homerslab', trustedProxy: null }, '172.30.0.2', h)).toBeNull();
    expect(resolveIdentity({ mode: 'standalone', trustedProxy: parseTrustedProxy('172.30.0.2') }, '172.30.0.2', h)).toBeNull();
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
  it('the origin must be https, or http on localhost', () => {
    expect(loadConfig({}).origin).toBe('http://localhost:8080');
    expect(loadConfig({ PHILOBIBLOS_ORIGIN: 'https://philobiblos.example.org' })).toMatchObject({ origin: 'https://philobiblos.example.org', rpId: 'philobiblos.example.org' });
    expect(() => loadConfig({ PHILOBIBLOS_ORIGIN: 'http://192.168.1.5:8080' })).toThrow();
    expect(() => loadConfig({ PHILOBIBLOS_ORIGIN: 'https://philobiblos.example.org/app' })).toThrow();
  });
  it('refuses an unknown mode', () => {
    expect(() => loadConfig({ PHILOBIBLOS_MODE: 'public' })).toThrow();
  });
});
