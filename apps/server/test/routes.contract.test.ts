// Every operation of contracts/openapi.yaml is served, and only those; each answers with a status the spec
// declares and a body that validates against the spec's schema for it.
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db/open';
import * as t from '../src/db/schema';

interface Schema { type?: string | string[]; enum?: unknown[]; pattern?: string; required?: string[]; properties?: Record<string, Schema>; items?: Schema; $ref?: string; allOf?: Schema[] }
interface Op { operationId: string; security?: Record<string, string[]>[]; parameters?: Param[]; requestBody?: { content: Record<string, { schema: Schema }> }; responses: Record<string, { content?: Record<string, { schema: Schema }> }> }
interface Param { name: string; in: string; schema: Schema }

const spec = parse(readFileSync(new URL('../../../contracts/openapi.yaml', import.meta.url), 'utf8'));
const METHODS = ['get', 'put', 'post', 'patch', 'delete'] as const;
const ops: { method: string; path: string; op: Op; params: Param[] }[] = [];
for (const [path, item] of Object.entries<Record<string, unknown>>(spec.paths)) {
  for (const m of METHODS) {
    const op = item[m] as Op | undefined;
    if (op) ops.push({ method: m.toUpperCase(), path, op, params: [...((item.parameters as Param[]) ?? []), ...(op.parameters ?? [])] });
  }
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
ajv.addFormat('binary', true);
ajv.addSchema(spec, 'openapi');
const pointer = (...parts: string[]) => 'openapi#/' + parts.map((p) => p.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');

function resolve(s: Schema): Schema {
  if (!s.$ref) return s;
  const parts = s.$ref.replace(/^#\//, '').split('/');
  return resolve(parts.reduce<any>((o, k) => o[k], spec)); // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A small value that satisfies the schema (required properties only). */
function sample(s0: Schema): unknown {
  const s = resolve(s0);
  if (s.allOf) return Object.assign({}, ...s.allOf.map(sample));
  if (s.enum) return s.enum[0];
  if (s.pattern === '^\\d{4}-\\d{2}$') return '2026-12';
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case 'integer': case 'number': return 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': return Object.fromEntries((s.required ?? []).map((k) => [k, sample(s.properties?.[k] ?? {})]));
    default: return 'x';
  }
}

function multipart(): { body: string; contentType: string } {
  const b = 'shelf-test-boundary';
  const body = [`--${b}`, 'Content-Disposition: form-data; name="url"', '', 'https://example.org/p/1', `--${b}`,
    'Content-Disposition: form-data; name="media"; filename="a.jpg"', 'Content-Type: image/jpeg', '', 'not really a jpeg', `--${b}--`, ''].join('\r\n');
  return { body, contentType: `multipart/form-data; boundary=${b}` };
}

// homerslab mode, the proxy at 127.0.0.1 (Fastify's inject comes from there), an adult and a kid in the household.
const ADULT = { 'x-homerslab-person': 'hl-alex' };
const KID = { 'x-homerslab-person': 'hl-kid' };
const security = (o: { op: Op }) => (o.op.security ?? spec.security) as Record<string, string[]>[];

function household() {
  const db = openDb(':memory:');
  db.insert(t.person).values([
    { id: 'p_alex', externalId: 'hl-alex', name: 'Alex', role: 'admin' },
    { id: 'p_kid1', externalId: 'hl-kid', name: 'Kid 1', role: 'kid', birthYear: 2021 },
  ]).run();
  return db;
}

let built: BuiltApp;
beforeAll(async () => {
  built = await buildApp(loadConfig({ SHELF_MODE: 'homerslab', SHELF_TRUSTED_PROXY: '127.0.0.1', SHELF_DATA_DIR: '/nonexistent' }), household());
  await built.app.ready();
});
afterAll(() => built.app.close());

function request(o: (typeof ops)[number]) {
  let url = '/api' + o.path;
  const query: Record<string, string> = {};
  for (const p of o.params) {
    const v = String(sample(p.schema));
    if (p.in === 'path') url = url.replace(`{${p.name}}`, encodeURIComponent(v));
    else if (p.in === 'query' && p.name === 'q') query.q = 'is:open nonsense:1';
  }
  const content = o.op.requestBody?.content ?? {};
  let payload: string | undefined;
  const headers: Record<string, string> = {};
  if (content['application/json']) {
    payload = JSON.stringify(sample(content['application/json'].schema));
    headers['content-type'] = 'application/json';
  } else if (content['multipart/form-data']) {
    const m = multipart();
    payload = m.body;
    headers['content-type'] = m.contentType;
  }
  return { method: o.method as 'GET', url, query, payload, headers };
}

function validates(o: (typeof ops)[number], status: number, body: unknown) {
  const resp = resolveResponse(o.op.responses[String(status)]!);
  if (!resp.json) return;
  const validate = ajv.getSchema(resp.pointer)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
}

function resolveResponse(r: { $ref?: string; content?: Record<string, { schema: Schema }> }): { json: boolean; pointer: string } {
  if (r.$ref) {
    const name = r.$ref.split('/').pop()!;
    return { json: Boolean(spec.components.responses[name].content?.['application/json']), pointer: pointer('components', 'responses', name, 'content', 'application/json', 'schema') };
  }
  return { json: Boolean(r.content?.['application/json']), pointer: '' };
}

describe('contracts/openapi.yaml', () => {
  it('the server has exactly the spec\'s routes', () => {
    const specRoutes = ops.map((o) => `${o.method} /api${o.path.replace(/\{(\w+)\}/g, ':$1')}`).sort();
    const appRoutes = built.apiRoutes.map((r) => `${r.method} ${r.url}`).sort();
    expect(appRoutes).toEqual(specRoutes);
  });

  it.each(ops.map((o) => [`${o.method} ${o.path} (${o.op.operationId})`, o] as const))('%s', async (_name, o) => {
    const req = request(o);
    const res = await built.app.inject({ ...req, headers: { ...req.headers, ...ADULT } });
    const declared = Object.keys(o.op.responses);
    expect(declared).toContain(String(res.statusCode));
    expect(res.statusCode).toBeLessThan(300);
    const resp = o.op.responses[String(res.statusCode)]!;
    const json = resp.content?.['application/json'];
    if (!json) return;
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    const validate = ajv.getSchema(pointer('paths', o.path, o.method.toLowerCase(), 'responses', String(res.statusCode), 'content', 'application/json', 'schema'))!;
    const body = res.json();
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    if (o.op.operationId === 'listBacklog') expect(body.queryErrors).toEqual(['unknown qualifier "nonsense:"']);
  });
});

describe('deny by default (securitySchemes)', () => {
  it('only /health is open; every other operation declares 401 and 403', () => {
    for (const o of ops) {
      if (o.op.operationId === 'health') { expect(security(o)).toEqual([]); continue; }
      expect(security(o).length, o.op.operationId).toBeGreaterThan(0);
      expect(Object.keys(o.op.responses), o.op.operationId).toEqual(expect.arrayContaining(['401', '403']));
    }
  });

  it.each(ops.filter((o) => o.op.operationId !== 'health').map((o) => [o.op.operationId, o] as const))('%s: 401 without credentials, 403 for a kid', async (_n, o) => {
    const req = request(o);
    const anon = await built.app.inject(req);
    expect(anon.statusCode).toBe(401);
    validates(o, 401, anon.json());
    const kid = await built.app.inject({ ...req, headers: { ...req.headers, ...KID } });
    expect(kid.statusCode).toBe(403);
    validates(o, 403, kid.json());
  });

  it('the header counts only from the trusted proxy', async () => {
    expect((await built.app.inject({ url: '/api/me', headers: ADULT, remoteAddress: '10.0.0.9' })).statusCode).toBe(401);
    expect((await built.app.inject({ url: '/api/me', headers: ADULT })).statusCode).toBe(200);
  });

  it('a person the household does not know gets 403', async () => {
    expect((await built.app.inject({ url: '/api/me', headers: { 'x-homerslab-person': 'stranger' } })).statusCode).toBe(403);
  });

  it('standalone: /health only, until passkey sign-in exists', async () => {
    const sa = await buildApp(loadConfig({ SHELF_MODE: 'standalone', SHELF_DATA_DIR: '/nonexistent' }), household());
    expect((await sa.app.inject({ url: '/api/health' })).statusCode).toBe(200);
    expect((await sa.app.inject({ url: '/api/me', headers: ADULT })).statusCode).toBe(401);
    await sa.app.close();
  });
});

describe('share tokens', () => {
  const shares = ops.find((o) => o.op.operationId === 'createShare')!;
  it('the spec allows a share token on POST /shares and nowhere else', () => {
    for (const o of ops) expect(security(o).some((s) => 'shareToken' in s), o.op.operationId).toBe(o === shares);
  });
  it('a token works for POST /shares only, is shown once, stored hashed, and stops when revoked', async () => {
    const created = await built.app.inject({ method: 'POST', url: '/api/share-tokens', headers: ADULT, payload: { label: 'Phone' } });
    expect(created.statusCode).toBe(201);
    const { id, token } = created.json();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const auth = { authorization: `Bearer ${token}` };
    const req = request(shares);
    expect((await built.app.inject({ ...req, headers: { ...req.headers, ...auth } })).statusCode).toBe(202);
    for (const url of ['/api/me', '/api/share-tokens', '/api/settings']) expect((await built.app.inject({ url, headers: auth })).statusCode).toBe(401);
    const listed = (await built.app.inject({ url: '/api/share-tokens', headers: ADULT })).json();
    expect(listed.find((x: { id: string }) => x.id === id)).toMatchObject({ label: 'Phone', revoked: false });
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(JSON.stringify(listed)).not.toMatch(/hash/i);
    expect((await built.app.inject({ method: 'DELETE', url: `/api/share-tokens/${id}`, headers: ADULT })).statusCode).toBe(204);
    expect((await built.app.inject({ ...req, headers: { ...req.headers, ...auth } })).statusCode).toBe(401);
  });
});

describe('share upload limits', () => {
  const files = (n: number, size: number) => {
    const b = 'limit-boundary';
    const parts = Array.from({ length: n }, (_, i) => [`--${b}`, `Content-Disposition: form-data; name="media"; filename="${i}.jpg"`, 'Content-Type: image/jpeg', '', 'x'.repeat(size)].join('\r\n'));
    return { payload: [...parts, `--${b}--`, ''].join('\r\n'), headers: { 'content-type': `multipart/form-data; boundary=${b}`, ...ADULT } };
  };
  it('30 files pass, 31 are refused with 413', async () => {
    expect((await built.app.inject({ method: 'POST', url: '/api/shares', ...files(30, 10) })).statusCode).toBe(202);
    const r = await built.app.inject({ method: 'POST', url: '/api/shares', ...files(31, 10) });
    expect(r.statusCode).toBe(413);
  });
  it('a file over the size limit is refused with 413', async () => {
    const small = await buildApp(loadConfig({ SHELF_MODE: 'homerslab', SHELF_TRUSTED_PROXY: '127.0.0.1', SHELF_DATA_DIR: '/nonexistent' }), household(), { shareLimits: { fileSize: 1024 } });
    expect((await small.app.inject({ method: 'POST', url: '/api/shares', ...files(1, 1000) })).statusCode).toBe(202);
    expect((await small.app.inject({ method: 'POST', url: '/api/shares', ...files(1, 2000) })).statusCode).toBe(413);
    await small.app.close();
  });
});

describe('no secrets in responses', () => {
  it('settings carry no secret field', async () => {
    const settings = (await built.app.inject({ url: '/api/settings', headers: ADULT })).json();
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
    };
    walk(settings);
    expect(keys.filter((k) => /password|apikey|api_key|secret|^card|cardnumber|address|token/i.test(k))).toEqual([]);
  });
  it('no Gmail or OAuth route exists', () => {
    expect(built.apiRoutes.filter((r) => /gmail|oauth|google/i.test(r.url))).toEqual([]);
  });
});
