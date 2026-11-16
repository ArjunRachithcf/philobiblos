// The AI runner, the providers over the egress client, and the AI settings (M3 g, docs/security.md). Every model here
// is a fake or a mock server on 127.0.0.1: nothing reaches Ollama or Anthropic. Every rule has a test that fails when the
// rule is changed.
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FIELDS, JOBS, JOB_NAMES, buildPrompt, createClaudeModel, createOllamaModel, fakeModel, keyPaths, type Field, type JobName } from '@shelf/ai';
import { AI_LIMITS, AiBudget, AiError, runAi, scrub } from '../src/ai/run';
import { modelFor } from '../src/ai/model';
import { CLAUDE_KEY, DEFAULT_JOBS, JOBS_OF, SealKeyMissing, checkAi, leaves } from '../src/ai/settings';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import * as t from '../src/db/schema';
import { unseal } from '../src/household/sealed';
import { EgressError, POST_TIMEOUT_MAX_MS, aiEgressRules, createEgress, type Rule } from '../src/net/egress';
import { ORIGIN, TEST_SEALING_KEY, household, sessionCookie } from './helpers';

const KEY = 'sk-ant-api03-' + 'k'.repeat(40);
const tag = { audience: 'adult', isFiction: false, ideas: [{ name: 'Markets', layer: 'core', confidence: 0.9 }], kidsThemes: [], ageBand: null };
const tagIn = { book: { id: 'b1', title: 'A Ledger', authors: ['A. Writer'] }, blurb: 'About money.', ideaVocabulary: ['Markets'], kidsThemes: ['Friendship'] };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 0xff, 0xd9]);
const runs = (db: ReturnType<typeof household>) => db.select().from(t.aiRun).all();

describe('runAi', () => {
  it('logs the run: provider, model, prompt version, input hash, output, cost; the same input reuses it', async () => {
    const db = household();
    const m = fakeModel(() => tag);
    const a = await runAi(db, m, 'tagBook', tagIn, { budget: new AiBudget() });
    expect(a.cached).toBe(false);
    expect(a.output).toMatchObject({ audience: 'adult', ideas: [{ name: 'Markets', isNewIdea: false }] });
    const [r] = runs(db);
    expect(r).toMatchObject({ id: a.runId, job: 'tagBook', provider: 'fake', model: 'fake-1', promptVersion: 'tag_book.v1', error: null, costC: 0, takeawaysOf: null, personId: null });
    expect(r!.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(r!.outputJson!)).toEqual(a.output);
    const b = await runAi(db, m, 'tagBook', tagIn, { budget: new AiBudget() });
    expect(b).toMatchObject({ runId: a.runId, cached: true });
    expect(m.requests).toHaveLength(1);
    // Another input, another person, or another model is not the same run.
    await runAi(db, m, 'tagBook', { ...tagIn, blurb: 'Other.' }, { budget: new AiBudget() });
    await runAi(db, m, 'tagBook', tagIn, { budget: new AiBudget(), personId: 'p_sam' });
    await runAi(db, fakeModel(() => tag, { model: 'fake-2' }), 'tagBook', tagIn, { budget: new AiBudget() });
    expect(runs(db)).toHaveLength(4);
  });

  it('an invalid answer is tried once more; twice invalid, the run fails, logged, without the answer', async () => {
    const db = household();
    const once = fakeModel((_r, n) => (n === 1 ? { audience: 'teens' } : tag));
    await expect(runAi(db, once, 'tagBook', tagIn, { budget: new AiBudget() })).resolves.toMatchObject({ cached: false });
    expect(once.requests).toHaveLength(2);
    const never = fakeModel(() => 'SECRET-ANSWER not json');
    const other = { ...tagIn, blurb: 'Another blurb.' };
    const e = await runAi(db, never, 'tagBook', other, { budget: new AiBudget() }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AiError);
    expect(never.requests).toHaveLength(2);
    const failed = runs(db).find((r) => r.id === (e as AiError).runId)!;
    expect(failed.outputJson).toBeNull();
    expect(failed.error).toBe('an answer that is not JSON');
    expect(JSON.stringify(runs(db))).not.toContain('SECRET-ANSWER');
    // A failed run is never a cache hit.
    await expect(runAi(db, fakeModel(() => tag), 'tagBook', other, { budget: new AiBudget() })).resolves.toMatchObject({ cached: false });
  });

  it('a provider that throws is tried once more, and its message is Shelf\'s', async () => {
    const db = household();
    let n = 0;
    const m = { ...fakeModel(() => tag), async complete(): Promise<never> { n++; throw new Error('boom with sk-ant-secret'); } };
    const e = await runAi(db, m, 'tagBook', tagIn, { budget: new AiBudget() }).catch((x: unknown) => x as AiError);
    expect(n).toBe(2);
    expect(runs(db)[0]!.error).toBe('the provider call failed');
    expect(String(e)).not.toContain('sk-ant');
  });

  it('every call gets its provider\'s deadline, and the job\'s token limit', async () => {
    const m = fakeModel(() => tag);
    await runAi(household(), m, 'tagBook', tagIn, { budget: new AiBudget() });
    expect(m.requests[0]).toMatchObject({ timeoutMs: AI_LIMITS.timeoutMs.fake, maxTokens: 2048 });
    expect(AI_LIMITS.timeoutMs).toMatchObject({ ollama: 180_000, claude: 90_000 });
  });

  it('the budget caps calls and tokens across a job run', async () => {
    const db = household();
    const budget = new AiBudget(3, 1_000_000);
    const m = fakeModel(() => 'nope');
    await expect(runAi(db, m, 'tagBook', tagIn, { budget })).rejects.toBeInstanceOf(AiError);
    // One call left: the run starts, its retry is refused, and it fails logged.
    await expect(runAi(db, m, 'tagBook', { ...tagIn, blurb: 'b' }, { budget })).rejects.toMatchObject({ reason: 'failed' });
    expect(runs(db).at(-1)!.error).toMatch(/budget is spent/);
    await expect(runAi(db, m, 'tagBook', { ...tagIn, blurb: 'c' }, { budget })).rejects.toMatchObject({ reason: 'budget' });
    expect(m.requests).toHaveLength(3);
    const tokens = new AiBudget(100, 50);
    const big = fakeModel(() => tag);
    await runAi(db, big, 'tagBook', { ...tagIn, blurb: 'd' }, { budget: tokens });
    await expect(runAi(db, big, 'tagBook', { ...tagIn, blurb: 'e' }, { budget: tokens })).rejects.toMatchObject({ reason: 'budget' });
  });

  it('bounds: the prompt, the answer, the images', async () => {
    const db = household();
    const m = fakeModel(() => tag);
    const titles = (n: number) => Array.from({ length: n }, (_, i) => `${'x'.repeat(290)}${i}`);
    await expect(runAi(db, m, 'suggestNext', { brain: { ideas: [] }, backlogTitles: titles(300), owned: titles(200), wildcards: false, max: 3 }, { budget: new AiBudget() })).rejects.toMatchObject({ reason: 'too_large' });
    expect(m.requests).toHaveLength(0);
    const long = fakeModel(() => ({ ...tag, padding: 'x'.repeat(AI_LIMITS.answer) }));
    await expect(runAi(db, long, 'tagBook', tagIn, { budget: new AiBudget() })).rejects.toMatchObject({ reason: 'failed' });
    expect(runs(db)[0]!.error).toMatch(/over 64000 characters/);
    const ex = { images: [], caption: 'c' };
    const books = fakeModel(() => ({ books: [] }));
    await expect(runAi(db, books, 'extractTitles', ex, { budget: new AiBudget(), images: [Buffer.from('<svg/>')] })).rejects.toMatchObject({ reason: 'too_large' });
    await expect(runAi(db, books, 'extractTitles', ex, { budget: new AiBudget(), images: Array(31).fill(JPEG) })).rejects.toMatchObject({ reason: 'too_large' });
    await runAi(db, books, 'extractTitles', ex, { budget: new AiBudget(), images: [JPEG, JPEG] });
    expect(books.requests[0]!.images).toEqual([{ mimeType: 'image/jpeg', base64: JPEG.toString('base64') }, { mimeType: 'image/jpeg', base64: JPEG.toString('base64') }]);
    // A model without vision gets the caption only.
    const blind = fakeModel(() => ({ books: [] }), { supportsVision: false });
    await runAi(db, blind, 'extractTitles', ex, { budget: new AiBudget(), images: [JPEG] });
    expect(blind.requests[0]!.images).toEqual([]);
  });

  it('a takeaway is sent only with whose it is, and the run carries it', async () => {
    const db = household();
    const m = fakeModel(() => ({ links: [] }));
    const input = { candidate: { id: 'b1', title: 'A', ideas: [] }, readBooks: [{ id: 'b2', title: 'B', ideas: [], takeaway: 'my own line' }] };
    await expect(runAi(db, m, 'proposeLinks', input, { budget: new AiBudget() })).rejects.toMatchObject({ reason: 'takeaways' });
    await expect(runAi(db, m, 'proposeLinks', { ...input, readBooks: [{ id: 'b2', title: 'B', ideas: [] }] }, { budget: new AiBudget(), takeawaysOf: 'p_alex' })).rejects.toMatchObject({ reason: 'takeaways' });
    expect(m.requests).toHaveLength(0);
    const r = await runAi(db, m, 'proposeLinks', input, { budget: new AiBudget(), takeawaysOf: 'p_alex', personId: 'p_alex' });
    expect(runs(db).find((x) => x.id === r.runId)).toMatchObject({ takeawaysOf: 'p_alex', personId: 'p_alex' });
    expect(m.requests[0]!.user).toContain('my own line');
  });

  it('an answer is data: ids only from the input, Shelf decides what is new, texts one line', async () => {
    const db = household();
    const links = fakeModel(() => ({ links: [
      { toBookId: 'b_elsewhere', reason: 'a book the input never named', confidence: 1 },
      { toBookId: 'b1', reason: 'the candidate itself', confidence: 1 },
      { toBookId: 'b2', reason: 'Builds on\nit\u0000', confidence: 0.9 },
      { toBookId: 'b2', reason: 'twice', confidence: 0.9 },
    ] }));
    const r = await runAi(db, links, 'proposeLinks', { candidate: { id: 'b1', title: 'A', ideas: [] }, readBooks: [{ id: 'b2', title: 'B', ideas: [] }] }, { budget: new AiBudget() });
    expect(r.output).toEqual({ links: [{ toBookId: 'b2', reason: 'Builds on it', confidence: 0.9 }] });
    const tags = fakeModel(() => ({ ...tag, ideas: [{ name: 'markets', layer: 'core', confidence: 0.9, isNewIdea: true }, { name: 'Brand New', layer: 'intro', confidence: 2 }], kidsThemes: ['Friendship', 'Not a theme'] }));
    const out = (await runAi(db, tags, 'tagBook', tagIn, { budget: new AiBudget() })).output;
    expect(out.ideas).toEqual([{ name: 'Markets', layer: 'core', confidence: 0.9, isNewIdea: false }, { name: 'Brand New', layer: 'intro', confidence: 1, isNewIdea: true }]);
    expect(out.kidsThemes).toEqual(['Friendship']);
    const next = fakeModel(() => ({ suggestions: [
      { title: 'Owned Already', author: 'X', move: 'deepen', idea: 'Markets', why: 'w' },
      { title: 'Wild One', author: 'Y', move: 'wildcard', idea: 'New', why: 'w' },
      { title: 'Fresh', author: 'Z', move: 'broaden', idea: 'New', why: 'w' },
    ] }));
    const s = (await runAi(db, next, 'suggestNext', { brain: { ideas: [] }, backlogTitles: [], owned: ['owned already'], wildcards: false, max: 3 }, { budget: new AiBudget() })).output;
    expect(s.suggestions.map((x) => x.title)).toEqual(['Fresh']);
    const red = fakeModel(() => ({ repeats: 'b_not_owned', reason: 'r' }));
    expect((await runAi(db, red, 'checkRedundant', { candidate: { id: 'b1', title: 'A' }, owned: [{ id: 'b2', title: 'B' }] }, { budget: new AiBudget() })).output).toEqual({});
  });

  it('no string of an answer holds a piece of the delivery address or a long number', async () => {
    expect(scrub({ links: [{ reason: 'fine' }, { reason: 'Card 4111 1111 1111 1111' }, { reason: 'at Rosenweg in Musterdorf' }] }, ['musterdorf'])).toEqual({ links: [{ reason: 'fine' }] });
    expect(scrub({ why: 'call 0041 79 123 45 67 89' }, [])).toBeNull();
    expect(scrub({ why: 'x'.repeat(301) }, [])).toBeNull();
    const db = household();
    const m = fakeModel(() => ({ why: 'Deepens Markets; send it to Rosenweg 3, Musterdorf' }));
    await expect(runAi(db, m, 'explainPick', { pick: { id: 'b1', title: 'A' }, move: 'deepen', buildsOn: [], idea: 'Markets' }, { budget: new AiBudget(), address: ['musterdorf'] })).rejects.toMatchObject({ reason: 'failed' });
    expect(runs(db)[0]!.error).toMatch(/does not keep/);
  });

  it('a stored answer is checked again before it is reused', async () => {
    const db = household();
    const m = fakeModel(() => tag);
    const a = await runAi(db, m, 'tagBook', tagIn, { budget: new AiBudget() });
    db.update(t.aiRun).set({ outputJson: '{"audience":"teens"}' }).where(eq(t.aiRun.id, a.runId)).run();
    const b = await runAi(db, m, 'tagBook', tagIn, { budget: new AiBudget() });
    expect(b.cached).toBe(false);
    expect(m.requests).toHaveLength(2);
  });
});

describe('the providers over the egress client (mock servers)', () => {
  let server: http.Server, port = 0;
  let answer: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void = () => {};
  const seen: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { seen.push({ url: req.url ?? '', headers: req.headers, body }); answer(req, body, res); });
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => { server.close(); });
  afterEach(() => { seen.length = 0; });
  const json = (o: unknown) => (_q: http.IncomingMessage, _b: string, r: http.ServerResponse) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(o)); };
  const ollamaUrl = () => `http://127.0.0.1:${port}`;
  const egress = (rules: Rule[], timeoutMs?: number) => createEgress({ rules, resolve: async () => [{ address: '127.0.0.1', family: 4 }], timeoutMs });

  it('Ollama: one POST to /api/chat on its own host, the answer read', async () => {
    answer = json({ model: 'llama3.2', message: { content: JSON.stringify(tag) }, done_reason: 'stop', prompt_eval_count: 9, eval_count: 3 });
    const e = egress(aiEgressRules('ollama', ollamaUrl()));
    const m = createOllamaModel({ url: ollamaUrl(), model: 'llama3.2', transport: async (u, b, o) => (await e.post(u, b, o)).body });
    const db = household();
    await runAi(db, m, 'tagBook', tagIn, { budget: new AiBudget() });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('/api/chat');
    expect(seen[0]!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ model: 'llama3.2', stream: false });
  });

  it('an AI request is never redirected, nor sent past its deadline', async () => {
    answer = (_q, _b, r) => { r.statusCode = 307; r.setHeader('location', `${ollamaUrl()}/elsewhere`); r.end(); };
    const e = egress(aiEgressRules('ollama', ollamaUrl()));
    await expect(e.post(`${ollamaUrl()}/api/chat`, Buffer.from('{}'), { timeoutMs: 1000 })).rejects.toMatchObject({ reason: 'redirect' });
    expect(seen).toHaveLength(1);
    answer = () => { /* never answers */ };
    await expect(e.post(`${ollamaUrl()}/api/chat`, Buffer.from('{}'), { timeoutMs: 200 })).rejects.toMatchObject({ reason: 'timeout' });
    await expect(e.post(`${ollamaUrl()}/api/chat`, Buffer.alloc((32 << 20) + 1), { timeoutMs: 200 })).rejects.toMatchObject({ reason: 'too-large' });
    // A caller asking for longer still gets at most the client's cap.
    const capped = createEgress({ rules: aiEgressRules('ollama', ollamaUrl()), resolve: async () => [{ address: '127.0.0.1', family: 4 }], postMaxMs: 150 });
    const t0 = Date.now();
    await expect(capped.post(`${ollamaUrl()}/api/chat`, Buffer.from('{}'), { timeoutMs: 60_000 })).rejects.toMatchObject({ reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(POST_TIMEOUT_MAX_MS).toBe(300_000);
  });

  it('each provider\'s client reaches its own host only', async () => {
    const claude = egress(aiEgressRules('claude', ollamaUrl()));
    expect(aiEgressRules('claude', ollamaUrl())).toEqual([{ host: 'api.anthropic.com' }]);
    for (const u of [`${ollamaUrl()}/api/chat`, 'https://openlibrary.org/x', 'https://api.anthropic.com.evil.test/v1/messages', 'http://api.anthropic.com/v1/messages']) {
      await expect(claude.post(u, Buffer.from('{}'), { timeoutMs: 100 })).rejects.toMatchObject({ reason: 'not-allowed' });
    }
    const ollama = egress(aiEgressRules('ollama', ollamaUrl()));
    for (const u of ['https://api.anthropic.com/v1/messages', 'https://openlibrary.org/x', `http://127.0.0.1:${port + 1}/api/chat`]) {
      await expect(ollama.post(u, Buffer.from('{}'), { timeoutMs: 100 })).rejects.toBeInstanceOf(EgressError);
    }
    expect(aiEgressRules('ollama', null)).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it('the Claude model sends only to api.anthropic.com', async () => {
    const asked: string[] = [];
    const m = createClaudeModel({ apiKey: KEY, transport: async (u) => { asked.push(u); return Buffer.from(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(tag) }], usage: {} })); } });
    await runAi(household(), m, 'tagBook', tagIn, { budget: new AiBudget() });
    expect(asked).toEqual(['https://api.anthropic.com/v1/messages']);
  });
});

/** Each job's request with every field it can hold (a takeaway too), as the jobs build them. */
const FULL: { [J in JobName]: Parameters<typeof buildPrompt<J>>[1] } = {
  extractTitles: { images: [{ path: 'shares/x/00.jpg', mimeType: 'image/jpeg' }], caption: 'Three books', url: 'https://example.test/p' },
  tagBook: tagIn,
  proposeLinks: { candidate: { id: 'b1', title: 'A Ledger', authors: ['A. Writer'], ideas: [{ name: 'Markets', layer: 'core', confidence: 1 }] }, readBooks: [{ id: 'b2', title: 'Old Coins', authors: ['B'], ideas: [{ name: 'Markets', layer: 'intro', confidence: 1 }], takeaway: 'coins were trust' }] },
  suggestNext: { brain: { ideas: [{ name: 'Markets', readCount: 2, layersFilled: ['intro'], gaps: ['core'] }] }, backlogTitles: ['A Ledger'], owned: ['Old Coins'], wildcards: true, max: 3 },
  explainPick: { pick: { id: 'b1', title: 'A Ledger', authors: ['A. Writer'] }, move: 'deepen', buildsOn: ['Old Coins'], idea: 'Markets' },
  checkRedundant: { candidate: { id: 'b1', title: 'A Ledger', authors: ['A. Writer'] }, owned: [{ id: 'b2', title: 'Old Coins', authors: ['B'] }] },
};
/** The key paths a request really holds: its <input> block and each <untrusted> block, read back from the bytes. */
function requestPaths(user: string): Set<string> {
  const out = new Set<string>();
  keyPaths('', JSON.parse(/<input>\n(.*)\n<\/input>/.exec(user)![1]!), out);
  for (const m of user.matchAll(/<untrusted source="(\w+)">\n(.*)\n<\/untrusted>/g)) keyPaths(m[1]!, JSON.parse(m[2]!), out);
  return out;
}

describe("Settings' list of what leaves is what the requests hold", () => {
  it('every field of every job\'s request is a line of leaves while its job is on, and no line while it is off', () => {
    const all = leaves('claude', DEFAULT_JOBS);
    for (const job of JOB_NAMES) {
      const paths = requestPaths(buildPrompt(job, FULL[job] as never, 1).user);
      expect(paths.size, job).toBeGreaterThan(0);
      for (const p of paths) {
        const f = JOBS[job].sends[p] as Field | undefined;
        expect(f, `${job}: ${p} is not listed`).toBeDefined();
        expect(all, `${job}: ${p}`).toContain(FIELDS[f!]);
      }
      // Its switch off and every other on: a field only it sends is gone from the list.
      const sw = (Object.keys(JOBS_OF) as (keyof typeof JOBS_OF)[]).find((k) => JOBS_OF[k].includes(job))!;
      const without = leaves('claude', { ...DEFAULT_JOBS, [sw]: false });
      const others = new Set((Object.keys(JOBS_OF) as (keyof typeof JOBS_OF)[]).filter((k) => k !== sw).flatMap((k) => JOBS_OF[k]).flatMap((j) => Object.values(JOBS[j].sends)));
      for (const p of paths) { const f = JOBS[job].sends[p]!; if (!others.has(f)) expect(without, `${job}: ${p}`).not.toContain(FIELDS[f]); }
    }
    // The reading of one person, the household's shelf and this month's picks are on the list.
    expect(all).toEqual(expect.arrayContaining([FIELDS.readBooks, FIELDS.takeaways, FIELDS.readingMap, FIELDS.backlogTitles, FIELDS.ownedTitles, FIELDS.pick, FIELDS.buildsOn]));
    expect(leaves('claude', { ...DEFAULT_JOBS, link: false }).join(' ')).not.toMatch(/takeaways|read books, up to 60/i);
    expect(leaves('claude', { ...DEFAULT_JOBS, suggest: false })).not.toContain(FIELDS.readingMap);
    expect(leaves('claude', { ...DEFAULT_JOBS, explain: false })).not.toContain(FIELDS.pick);
  });

  it('a request holding a key its job does not list is refused before it is built', () => {
    const sends = JOBS.tagBook.sends as Record<string, Field>;
    const was = sends.blurb!;
    delete sends.blurb;
    try {
      expect(() => buildPrompt('tagBook', tagIn)).toThrow(/blurb.*Settings does not list/);
      expect(() => buildPrompt('tagBook', { ...tagIn, blurb: undefined })).not.toThrow();
    } finally { sends.blurb = was; }
  });
});

describe('Settings.ai and the opt-in', () => {
  const built: BuiltApp[] = [];
  afterEach(async () => { for (const b of built.splice(0)) await b.app.close(); });
  async function app(env: Record<string, string> = {}) {
    const db = household();
    const cfg = loadConfig({ SHELF_MODE: 'standalone', SHELF_DATA_DIR: '/nonexistent-shelf', SHELF_SEALING_KEY: TEST_SEALING_KEY, ...env });
    const b = await buildApp(cfg, db, {});
    built.push(b);
    const alex = sessionCookie(db, 'p_alex'), sam = sessionCookie(db, 'p_sam');
    const patch = (cookie: string, ai: unknown) => b.app.inject({ method: 'PATCH', url: '/api/settings', headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' }, payload: JSON.stringify({ ai }) });
    const get = async (cookie = alex) => (await b.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).json() as { ai: Record<string, unknown> };
    return { db, cfg, alex, sam, patch, get, app: b.app };
  }

  it('Ollama is the default and nothing leaves; Settings lists what would leave with Claude', async () => {
    const a = await app({ OLLAMA_URL: 'http://ollama.lan:11434' });
    const s = (await a.get()).ai;
    expect(s).toMatchObject({ provider: 'ollama', model: 'llama3.2', visionModel: null, claudeModel: 'claude-opus-5-5', ollamaUrl: 'http://ollama.lan:11434', ollamaConfigured: true, hasClaudeKey: false, leaves: [] });
    expect((s.leavesWithClaude as string[]).join(' ')).toMatch(/api\.anthropic\.com/);
    expect((s.leavesWithClaude as string[]).join(' ')).toMatch(/Never: anyone's name, the delivery address/);
    // Each request is one person's reading: the list never says otherwise.
    expect((s.leavesWithClaude as string[]).join(' ')).not.toMatch(/who reads what/);
    expect(leaves('ollama', { read: true, link: true, suggest: true, explain: true, wildcards: true })).toEqual([]);
    expect(leaves('claude', { read: false, link: false, suggest: true, explain: true, wildcards: true }).join(' ')).not.toMatch(/images|takeaways/i);
  });

  it('opting in to Claude: admins only, with a key, and only with acceptLeaves', async () => {
    const a = await app();
    expect((await a.patch(a.sam, { provider: 'claude', claudeApiKey: KEY, acceptLeaves: true })).statusCode).toBe(403);
    const noAccept = await a.patch(a.alex, { provider: 'claude', claudeApiKey: KEY });
    expect(noAccept.statusCode).toBe(400);
    expect(noAccept.json().error).toMatch(/acceptLeaves/);
    expect((await a.patch(a.alex, { provider: 'claude', acceptLeaves: true })).statusCode).toBe(400);
    expect((await a.get()).ai).toMatchObject({ provider: 'ollama', hasClaudeKey: false });
    const ok = await a.patch(a.alex, { provider: 'claude', claudeApiKey: KEY, acceptLeaves: true });
    expect(ok.statusCode).toBe(200);
    const s = (await a.get()).ai;
    expect(s).toMatchObject({ provider: 'claude', hasClaudeKey: true });
    expect((s.leaves as string[]).length).toBeGreaterThan(2);
    // While on, a job that sends more needs the acceptance again.
    expect((await a.patch(a.alex, { jobs: { read: false } })).statusCode).toBe(200);
    expect((await a.patch(a.alex, { jobs: { read: true } })).statusCode).toBe(400);
    expect((await a.patch(a.alex, { jobs: { read: true }, acceptLeaves: true })).statusCode).toBe(200);
  });

  it('the key is sealed, write-only, never in an answer, a message or the database in clear', async () => {
    const a = await app();
    const bad = await a.patch(a.alex, { claudeApiKey: 'sk-ant-short' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('sk-ant-short');
    expect((await a.patch(a.alex, { claudeApiKey: `  ${KEY}  ` })).statusCode).toBe(200);
    const all = JSON.stringify(await a.get()) + JSON.stringify(await a.get(a.sam));
    expect(all).not.toContain(KEY);
    const row = a.db.select().from(t.sealedSecret).where(eq(t.sealedSecret.key, CLAUDE_KEY)).get()!;
    expect(row.ciphertext.toString('latin1')).not.toContain('sk-ant');
    expect(unseal(a.db, Buffer.from(TEST_SEALING_KEY, 'base64'), CLAUDE_KEY)).toBe(KEY);
    // Removing it while Claude is on turns the AI off, never over to another provider.
    await a.patch(a.alex, { provider: 'claude', acceptLeaves: true });
    expect((await a.patch(a.alex, { claudeApiKey: null })).statusCode).toBe(200);
    expect((await a.get()).ai).toMatchObject({ provider: 'none', hasClaudeKey: false });
  });

  it('without a sealing key no Claude key is taken (409)', async () => {
    const a = await app({ SHELF_SEALING_KEY: '', SHELF_MODE: 'homerslab', SHELF_ORIGIN: 'https://shelf.example', SHELF_EDGE_IDENTITY: 'homerslab-v1', SHELF_TRUSTED_PROXY: '10.0.0.1' });
    expect(a.cfg.sealingKey).toBeNull();
    expect(() => checkAi(a.db, a.cfg, { claudeApiKey: KEY })).toThrow(SealKeyMissing);
    expect(() => checkAi(a.db, a.cfg, { model: 'gemma3' })).not.toThrow();
    expect(modelFor(a.db, { ...a.cfg, egress: true }).model).toBeNull();
  });

  it('model names and fields are checked', async () => {
    const a = await app();
    for (const ai of [{ model: 'x y' }, { visionModel: '../etc' }, { claudeModel: 'gpt-5' }, { provider: 'openai' }, { jobs: { tools: true } }, { jobs: { read: 'yes' } }, { url: 'http://x' }]) {
      expect((await a.patch(a.alex, ai)).statusCode, JSON.stringify(ai)).toBe(400);
    }
    expect((await a.patch(a.alex, { model: 'gemma3:12b', visionModel: 'llama3.2-vision', claudeModel: 'claude-sonnet-5-5' })).statusCode).toBe(200);
    expect((await a.get()).ai).toMatchObject({ model: 'gemma3:12b', visionModel: 'llama3.2-vision', claudeModel: 'claude-sonnet-5-5' });
  });

  it('modelFor: the provider the settings name, through its own client', async () => {
    const a = await app({ OLLAMA_URL: 'http://ollama.lan:11434' });
    const asked: Rule[][] = [];
    const deps = { egress: (rules: Rule[]) => { asked.push(rules); return createEgress({ rules }); } };
    expect(modelFor(a.db, a.cfg, deps).model).toMatchObject({ provider: 'ollama', model: 'llama3.2' });
    expect(asked.at(-1)).toEqual([{ host: 'ollama.lan', scheme: 'http', port: 11434, privateOk: true }]);
    expect(modelFor(a.db, { ...a.cfg, ollamaUrl: null }, deps)).toMatchObject({ model: null, why: expect.stringMatching(/OLLAMA_URL/) });
    expect(modelFor(a.db, { ...a.cfg, egress: false }, deps).model).toBeNull();
    await a.patch(a.alex, { provider: 'claude', claudeApiKey: KEY, acceptLeaves: true });
    expect(modelFor(a.db, a.cfg, deps).model).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5' });
    expect(asked.at(-1)).toEqual([{ host: 'api.anthropic.com' }]);
    await a.patch(a.alex, { provider: 'none' });
    expect(modelFor(a.db, a.cfg, deps).model).toBeNull();
  });

  it('an acceptance covers the list it was given: a line it does not hold pauses Claude until an admin accepts again', async () => {
    const a = await app();
    const deps = { egress: (rules: Rule[]) => createEgress({ rules }) };
    expect((await a.patch(a.alex, { provider: 'claude', claudeApiKey: KEY, acceptLeaves: true })).statusCode).toBe(200);
    expect((await a.get()).ai).toMatchObject({ provider: 'claude', leavesAccepted: true });
    expect(modelFor(a.db, a.cfg, deps).model).toMatchObject({ provider: 'claude' });
    // A job off keeps it accepted (it sends less).
    expect((await a.patch(a.alex, { jobs: { explain: false } })).statusCode).toBe(200);
    expect((await a.get()).ai.leavesAccepted).toBe(true);
    // A newer Shelf whose list holds a line the admin never saw (here: the stored acceptance lacks one).
    const stored = JSON.parse(a.db.select().from(t.householdSettings).get()!.aiLeavesAccepted!) as string[];
    a.db.update(t.householdSettings).set({ aiLeavesAccepted: JSON.stringify(stored.filter((l) => l !== FIELDS.readBooks)) }).run();
    expect((await a.get()).ai).toMatchObject({ provider: 'claude', leavesAccepted: false });
    expect(modelFor(a.db, a.cfg, deps)).toMatchObject({ model: null, why: expect.stringMatching(/accept/) });
    // Changing anything else keeps it paused; accepting the list as it is now resumes it.
    expect((await a.patch(a.alex, { claudeModel: 'claude-sonnet-5-5' })).statusCode).toBe(200);
    expect(modelFor(a.db, a.cfg, deps).model).toBeNull();
    expect((await a.patch(a.alex, { acceptLeaves: true })).statusCode).toBe(200);
    expect((await a.get()).ai.leavesAccepted).toBe(true);
    expect(modelFor(a.db, a.cfg, deps).model).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5' });
    // Nothing accepted at all (a household from before this list was stored): paused.
    a.db.update(t.householdSettings).set({ aiLeavesAccepted: null }).run();
    expect(modelFor(a.db, a.cfg, deps).model).toBeNull();
  });
});
