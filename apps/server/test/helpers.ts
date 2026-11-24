// Shared by the API tests: contracts/openapi.yaml, a validator for it, sample requests, and a small household.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { expect } from 'vitest';
import { createSession } from '../src/auth/sessions';
import type { WebAuthn } from '../src/auth/webauthn';
import { openDb, type Db } from '../src/db/open';
import { EgressError, type Egress } from '../src/net/egress';
import * as t from '../src/db/schema';
import { currentMonth } from '../src/month/plan';
import { UNVERIFIED_ID, mailItemId } from '../src/inbox/inbox';
import { enableShop } from './mailkit';

/** Plans are made for this month and the next only: the tests use the server's this month (PHILOBIBLOS_TZ default). */
export const THIS_MONTH = currentMonth('Europe/Zurich');

export const ORIGIN = 'http://localhost:8080';
/** A sealing key for tests (32 bytes, base64); never a real one. */
export const TEST_SEALING_KEY = Buffer.alloc(32, 7).toString('base64');

export interface Schema { type?: string | string[]; enum?: unknown[]; pattern?: string; required?: string[]; properties?: Record<string, Schema>; items?: Schema; $ref?: string; allOf?: Schema[] }
export interface Op { operationId: string; security?: Record<string, string[]>[]; parameters?: Param[]; requestBody?: { content: Record<string, { schema: Schema }> }; responses: Record<string, { content?: Record<string, { schema: Schema }> }> }
export interface Param { name: string; in: string; schema: Schema }

export const spec = parse(readFileSync(new URL('../../../contracts/openapi.yaml', import.meta.url), 'utf8'));
const METHODS = ['get', 'put', 'post', 'patch', 'delete'] as const;
export const ops: { method: string; path: string; op: Op; params: Param[] }[] = [];
for (const [path, item] of Object.entries<Record<string, unknown>>(spec.paths)) {
  for (const m of METHODS) {
    const op = item[m] as Op | undefined;
    if (op) ops.push({ method: m.toUpperCase(), path, op, params: [...((item.parameters as Param[]) ?? []), ...(op.parameters ?? [])] });
  }
}

export const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
ajv.addFormat('binary', true);
ajv.addSchema(spec, 'openapi');
export const pointer = (...parts: string[]) => 'openapi#/' + parts.map((p) => p.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');

function resolve(s: Schema): Schema {
  if (!s.$ref) return s;
  const parts = s.$ref.replace(/^#\//, '').split('/');
  return resolve(parts.reduce<any>((o, k) => o[k], spec)); // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A small value that satisfies the schema (required properties only). */
export function sample(s0: Schema): unknown {
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

export function multipart(): { body: string; contentType: string } {
  const b = 'shelf-test-boundary';
  const body = [`--${b}`, 'Content-Disposition: form-data; name="url"', '', 'https://example.org/p/1', `--${b}`,
    'Content-Disposition: form-data; name="text"', '', 'A caption', `--${b}--`, ''].join('\r\n');
  return { body, contentType: `multipart/form-data; boundary=${b}` };
}


export type SpecOp = (typeof ops)[number];
export const security = (o: { op: Op }) => (o.op.security ?? spec.security) as Record<string, string[]>[];
export const isPublic = (o: { op: Op }) => security(o).length === 0;

/** A share of Alex's in household(). */
export const SHARE_ID = '01JC0000000000000000000000';

/** Path parameters that name something real in household() (and leave the signed-in admin alone). */
const PARAMS: Record<string, Record<string, string>> = {
  getBrain: { personId: 'p_alex' }, reviewLink: { fromBook: 'b_ledger', toBook: 'b_tide' }, reviewBookIdea: { bookId: 'b_tide', ideaId: 'i_markets' }, reviewIdeaProposal: { proposalId: 'ip_tide' }, editIdea: { ideaId: 'i_markets' },
  undoMerge: { mergeId: 'm_old' },
  getOrder: { id: 'o_old' }, getOrderList: { id: 'o_old' }, markOwned: { id: 'o_tap', bookId: 'b_tap' }, getMonth: { month: THIS_MONTH }, setMonthBudget: { month: THIS_MONTH }, changePicks: { month: THIS_MONTH },
  renameFilter: { id: 'default-1' }, removeFilter: { id: 'default-2' },
  getShare: { id: SHARE_ID }, removePushSubscription: { id: 'ps_alex' }, decideFound: { itemId: mailItemId('<inv-1@bookshop.example>'), index: '0' }, dismissInboxItem: { itemId: UNVERIFIED_ID }, answerTypedInvoice: { itemId: mailItemId('<held@bookshop.example>') }, undoOrderEntry: { id: 'e_undo' },
  getLibrary: { personId: 'p_alex' }, setReading: { personId: 'p_alex', bookId: 'b_tide' },
  setConnector: { connectorId: 'quillmere' },
  editPerson: { personId: 'p_sam' }, removePerson: { personId: 'p_del' }, invitePerson: { personId: 'p_sam' }, removePasskey: { id: 'pk2' },
};

/** A browser's push key (RFC 8291 §5's example's receiver: a point on P-256 nobody's browser holds). */
export const RFC8291_UA_KEY = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';

/** A push client that sends nothing anywhere (the tests never reach a real push service). */
export const nowherePush: Egress = {
  get: () => Promise.reject(new EgressError('not-allowed', 'no')), post: () => Promise.reject(new EgressError('not-allowed', 'no')),
  push: async (url) => ({ status: 201, type: '', body: Buffer.alloc(0), url }),
};

/** Request bodies that name something real in household() where a sample would be refused. */
const BODIES: Record<string, unknown> = {
  bulkBacklog: { ids: ['p_alex.b_tide'], action: 'reopen' },
  markOwned: { owned: true },
  reviewLink: { state: 'confirmed' }, reviewBookIdea: { state: 'confirmed' }, reviewIdeaProposal: { state: 'confirmed' }, editIdea: { name: 'Markets and value' },
  addToBacklog: { title: 'Gardens of the Commons', author: 'Tomas Ehrlich' },
  decideFound: { action: 'skip' }, answerTypedInvoice: { answer: 'same' },
  setConnector: { enabled: false },
  addPushSubscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/contract-new', keys: { p256dh: RFC8291_UA_KEY, auth: 'BTBZMqHH6r4Tts7J_aSIgg' } },
  setMonthBudget: { min: 10000, max: 15000 }, changePicks: { recompute: true }, createOrderDraft: { month: THIS_MONTH },
  recordOrderEntry: { kind: 'invoice', lines: [{ title: 'Paper Boats', qty: 1, price: 900 }] },
};

export function request(o: SpecOp) {
  let url = '/api' + o.path;
  const query: Record<string, string> = {};
  for (const p of o.params) {
    const v = PARAMS[o.op.operationId]?.[p.name] ?? String(sample(p.schema));
    if (p.in === 'path') url = url.replace(`{${p.name}}`, encodeURIComponent(v));
    else if (p.in === 'query' && p.name === 'q') query.q = 'is:open nonsense:1';
  }
  const content = o.op.requestBody?.content ?? {};
  let payload: string | undefined;
  const headers: Record<string, string> = { origin: ORIGIN };
  if (content['application/json']) {
    payload = JSON.stringify(BODIES[o.op.operationId] ?? sample(content['application/json'].schema));
    headers['content-type'] = 'application/json';
  } else if (content['multipart/form-data']) {
    const m = multipart();
    payload = m.body;
    headers['content-type'] = m.contentType;
  }
  return { method: o.method as 'GET', url, query, payload, headers };
}

/** The body validates against what the spec declares for this operation and status. */
export function expectValid(o: SpecOp, status: number, body: unknown) {
  const r = o.op.responses[String(status)] as { $ref?: string; content?: Record<string, unknown> } | undefined;
  expect(r, `${o.op.operationId} declares ${status}`).toBeDefined();
  let ptr: string | null = null;
  if (r!.$ref) {
    const name = r!.$ref.split('/').pop()!;
    if (spec.components.responses[name].content?.['application/json']) ptr = pointer('components', 'responses', name, 'content', 'application/json', 'schema');
  } else if (r!.content?.['application/json']) {
    ptr = pointer('paths', o.path, o.method.toLowerCase(), 'responses', String(status), 'content', 'application/json', 'schema');
  }
  if (!ptr) return;
  const validate = ajv.getSchema(ptr)!;
  expect(validate(body), `${o.op.operationId} ${status}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

/** Alex (admin, two passkeys), Sam and Robin (adults), Kid 1 (kid), one book; all invented, as in seed-sample/. */
export function household(): Db {
  const db = openDb(':memory:');
  db.insert(t.person).values([
    { id: 'p_alex', externalId: 'hl-alex', name: 'Alex', role: 'admin', handle: 'alex' },
    { id: 'p_sam', externalId: 'hl-sam', name: 'Sam', role: 'adult', handle: 'partner' },
    { id: 'p_del', name: 'Robin', role: 'adult', handle: 'robin' },
    { id: 'p_kid1', externalId: 'hl-kid', name: 'Kid 1', role: 'kid', handle: 'kid1', birthYear: 2021 },
  ]).run();
  const now = new Date().toISOString();
  db.insert(t.book).values({ id: 'b_tide', title: 'The Long Tide of Markets', authorsJson: '["Mira Okafor"]', audience: 'adult', normKey: 'tide', createdAt: now }).run();
  db.insert(t.candidate).values({ personId: 'p_alex', bookId: 'b_tide', origin: 'wishlist', addedAt: now, touchedAt: now }).run();
  db.insert(t.book).values({ id: 'b_ledger', title: 'The Grand Ledger', authorsJson: '["Mira Okafor"]', audience: 'adult', normKey: 'ledger', createdAt: now }).run();
  db.insert(t.bookLink).values({ fromBook: 'b_ledger', toBook: 'b_tide', reason: 'the sequel', confidence: 0.6, state: 'proposed' }).run();
  db.insert(t.idea).values({ id: 'i_markets', name: 'Markets and value' }).run();
  db.insert(t.bookIdea).values({ bookId: 'b_tide', ideaId: 'i_markets', layer: 'core', confidence: 0.5, state: 'proposed' }).run();
  db.insert(t.idea).values({ id: 'i_old', name: 'Prices', mergedInto: 'i_markets' }).run();
  // A new idea the AI proposed: a name only, no idea row.
  db.insert(t.ideaProposal).values({ id: 'ip_tide', bookId: 'b_tide', name: 'Tides of trade', layer: 'deep', confidence: 0.6 }).run();
  db.insert(t.ideaMerge).values({ id: 'm_old', ideaId: 'i_old', intoId: 'i_markets', mergedBy: 'p_alex', mergedAt: now }).run();
  db.insert(t.order).values({ id: 'o_old', month: '2026-01', status: 'closed', createdAt: now }).run();
  db.insert(t.orderLine).values({ orderId: 'o_old', bookId: 'b_ledger', forPerson: 'p_alex', estimateC: 3000, state: 'delivered' }).run();
  for (const id of ['pk1', 'pk2']) {
    db.insert(t.passkey).values({ id, personId: 'p_alex', publicKey: Buffer.from([1]), label: id, createdAt: now }).run();
  }
  // The invented example bookshop, enabled as an admin would (connectors/quillmere).
  enableShop(db);
  return db;
}

/** For the contract test: a share of Alex's, a verified invoice with a line that matched no book, a mail that was not verified. */
export function inboxItems(db: Db): void {
  const now = new Date().toISOString();
  db.insert(t.share).values({ id: SHARE_ID, personId: 'p_alex', url: 'https://example.org/p/1', status: 'done', createdAt: now }).run();
  db.insert(t.mailSeen).values({ messageId: '<inv-1@bookshop.example>', kind: 'invoice', parserVersion: 'm3d-1/invoice-1', seenAt: now, accepted: 1, authJson: '{}',
    parsedJson: JSON.stringify({ invoiceNumber: '123456', lines: [{ ean: '9780000000002', title: 'A Book Nobody Has', qty: 1, priceC: 2000, discountPct: null, totalC: 2000, vatPct: 2.6, bookId: null }] }) }).run();
  db.insert(t.mailSeen).values({ messageId: 'unverified:abc', kind: 'not_verified', parserVersion: 'm3d-1', seenAt: now, accepted: 0, authJson: JSON.stringify({ accepted: false, reason: 'not from the bookshop', fromDomain: 'evil.example' }) }).run();
}

export function sessionCookie(db: Db, personId: string): string {
  return `philobiblos_session=${createSession(db, personId).token}`;
}

/**
 * A stand-in authenticator: a "response" is { id, challenge } and verifies when the challenge is the one issued.
 * The real WebAuthn verification is @simplewebauthn's, exercised end to end in apps/web/e2e with a virtual
 * authenticator.
 */
export function fakeWebAuthn(): WebAuthn {
  const challenge = () => randomBytes(16).toString('base64url');
  return {
    async registrationOptions({ userName }) { const c = challenge(); return { challenge: c, options: { challenge: c, user: { name: userName } } }; },
    async verifyRegistration({ response, challenge: c }) {
      const r = response as { id?: string; challenge?: string } | undefined;
      return r?.challenge === c && r.id ? { id: r.id, publicKey: new Uint8Array([9]), counter: 0, transports: ['internal'], backedUp: true } : null;
    },
    async authenticationOptions() { const c = challenge(); return { challenge: c, options: { challenge: c } }; },
    credentialId(response) { const id = (response as { id?: unknown } | undefined)?.id; return typeof id === 'string' ? id : null; },
    async verifyAuthentication({ response, challenge: c, credential }) {
      const r = response as { id?: string; challenge?: string } | undefined;
      return r?.challenge === c && r.id === credential.id ? { newCounter: credential.counter + 1 } : null;
    },
  };
}
