// The Inbox, phone shares and share tokens (M3 e, docs/security.md). Every share, caption and mail here is invented.
// Each rule has a test that fails when the rule is changed.
import { connect } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import * as t from '../src/db/schema';
import type { Db } from '../src/db/open';
import { MAX_COPIES, PAGE, UNVERIFIED_ID, mailItemId, shareItemId } from '../src/inbox/inbox';
import { MediaUnavailable, type MediaOutcome, type runMediaJob } from '../src/media/client';
import { refreshMail } from '../src/mail/job';
import { IMAGE_HEADER, SHARE_PATIENCE_MS, SHARE_RATE, STAGED_MAX_AGE_MS, SHARE_UPLOADS, ShareProcessor, imageType, shareFileType } from '../src/shares/shares';
import { MAX_LIVE_TOKENS, findShareToken } from '../src/shares/tokens';
import { TOKEN_FAILURES } from '../src/auth/hook';
import { ORIGIN, TEST_SEALING_KEY, household, sessionCookie } from './helpers';
import { CFG, fakeBox, message, resolver, signed } from './mailkit';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(17)]);
const GIF = Buffer.from('GIF89a\x01\0\x01\0\0\0\0', 'latin1');
const WEBP = Buffer.from('RIFF\0\0\0\0WEBPVP8 \0\0\0\0', 'latin1');
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(8)]);
const OUT = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
/** Video containers by their first bytes (the server never decodes them: the worker does). */
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypqt  '), Buffer.alloc(16)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('webm'), Buffer.alloc(16)]);

const dirs: string[] = [];
const apps: BuiltApp[] = [];
const sockets: (() => void)[] = [];
const UPLOADS = { ...SHARE_UPLOADS };
afterEach(async () => {
  for (const d of sockets.splice(0)) d();
  Object.assign(SHARE_UPLOADS, { max: UPLOADS.max, perPerson: UPLOADS.perPerson, idleMs: UPLOADS.idleMs, deadlineMs: UPLOADS.deadlineMs });
  for (const a of apps.splice(0)) await a.app.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A worker that re-encodes everything it is given, or answers as told. */
const worker = (answer: (b: Uint8Array) => MediaOutcome | 'unavailable' = () => ({ id: 'j', ok: true, kind: 'image.reencode', width: 10, height: 10, format: 'jpeg', bytes: OUT.length, image: OUT })) => {
  const seen: Buffer[] = [];
  const kinds: string[] = [];
  const media = (async (_root: string | null, kind: string, input: Uint8Array) => {
    seen.push(Buffer.from(input));
    kinds.push(kind);
    const a = answer(input);
    if (a === 'unavailable') throw new MediaUnavailable();
    return a;
  }) as typeof runMediaJob;
  return { media, seen, kinds };
};

async function app(o: { workDir?: boolean; media?: typeof runMediaJob; db?: Db } = {}) {
  const data = mkdtempSync(join(tmpdir(), 'philobiblos-inbox-'));
  dirs.push(data);
  const db = o.db ?? household();
  const cfg = loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: data, PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY, ...(o.workDir === false ? {} : { PHILOBIBLOS_WORK_DIR: join(data, 'work') }) });
  const built = await buildApp(cfg, db, { webauthn: undefined, media: o.media ?? worker().media, shareRetryMs: 60_000 });
  apps.push(built);
  return { ...built, db, data, alex: sessionCookie(db, 'p_alex'), sam: sessionCookie(db, 'p_sam') };
}

type Part = { name: string; value: string } | { name: string; file: Buffer; filename?: string; type?: string };
function form(parts: Part[]) {
  const b = 'inbox-test-boundary';
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${p.name}"${'file' in p ? `; filename="${p.filename ?? 'a.jpg'}"\r\nContent-Type: ${p.type ?? 'image/jpeg'}` : ''}\r\n\r\n`));
    chunks.push('file' in p ? p.file : Buffer.from(p.value));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${b}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}
const share = (a: Awaited<ReturnType<typeof app>>, parts: Part[], auth: Record<string, string> = { cookie: a.alex, origin: ORIGIN }) => {
  const f = form(parts);
  return a.app.inject({ method: 'POST', url: '/api/shares', payload: f.payload, headers: { ...f.headers, ...auth } });
};
const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); expect(f()).toBe(true); };
const newToken = async (a: Awaited<ReturnType<typeof app>>, cookie = a.alex) =>
  (await a.app.inject({ method: 'POST', url: '/api/share-tokens', headers: { cookie, origin: ORIGIN }, payload: { label: 'iPhone' } })).json() as { id: string; token: string };

describe('share tokens: high-entropy, hashed, compared in constant time, scoped, revocable, rate limited', () => {
  it('only the whole token works: its id with another secret, or the secret under another id, is refused', async () => {
    const a = await app();
    const { id, token } = await newToken(a);
    const other = await newToken(a);
    const secret = token.slice(26);
    expect(findShareToken(a.db, token)?.id).toBe(id);
    expect(findShareToken(a.db, id + other.token.slice(26))).toBeNull();
    expect(findShareToken(a.db, other.id + secret)).toBeNull();
    expect(findShareToken(a.db, secret)).toBeNull(); // the old shape: no id
    // One character changed (never to the one it is: a secret ending in A made this a 1-in-64 flake).
    expect(findShareToken(a.db, `${id}${secret.slice(0, 42)}${secret[42] === 'A' ? 'B' : 'A'}`)).toBeNull();
    // At rest: only a hash; the token is in no column.
    const row = a.db.select().from(t.shareToken).where(eq(t.shareToken.id, id)).get()!;
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a token posts a share without Origin, and nothing else; revoked, or its person now a kid, it stops', async () => {
    const a = await app();
    const { id, token } = await newToken(a);
    const auth = { authorization: `Bearer ${token}` };
    expect((await share(a, [{ name: 'url', value: 'https://example.org/p/2' }], auth)).statusCode).toBe(202);
    expect((await a.app.inject({ url: '/api/inbox', headers: auth })).statusCode).toBe(401);
    expect((await a.app.inject({ method: 'POST', url: `/api/inbox/${mailItemId('x')}/dismiss`, headers: { ...auth, origin: ORIGIN } })).statusCode).toBe(401);
    // A token never borrows a cookie next to it.
    expect((await share(a, [{ name: 'url', value: 'https://example.org/p/3' }], { authorization: 'Bearer wrong-token-of-the-right-length-0000', cookie: a.alex, origin: ORIGIN })).statusCode).toBe(401);
    const { token: samToken } = await newToken(a, a.sam);
    a.db.update(t.person).set({ role: 'kid', birthYear: 2020 }).where(eq(t.person.id, 'p_sam')).run();
    expect((await share(a, [{ name: 'url', value: 'https://example.org/p/4' }], { authorization: `Bearer ${samToken}` })).statusCode).toBe(401);
    await a.app.inject({ method: 'DELETE', url: `/api/share-tokens/${id}`, headers: { cookie: a.alex, origin: ORIGIN } });
    expect((await share(a, [{ name: 'url', value: 'https://example.org/p/5' }], auth)).statusCode).toBe(401);
  });

  it('wrong tokens: after 10 from one address, or naming one token id, a wrong one gets 429; a valid token always passes (PR #16 review)', async () => {
    const a = await app();
    const { id, token } = await newToken(a);
    const junk = (i: number) => ({ authorization: `Bearer ${String(i).padStart(26, '0').replace(/[ILOU]/g, '0')}${'A'.repeat(43)}` });
    for (let i = 0; i < TOKEN_FAILURES.max; i++) expect((await share(a, [{ name: 'url', value: 'https://example.org/p' }], junk(i))).statusCode).toBe(401);
    // Behind a proxy every request has its address: a stranger's junk never holds a valid token back.
    expect((await share(a, [{ name: 'url', value: 'https://example.org/p' }], { authorization: `Bearer ${token}` })).statusCode).toBe(202);
    expect((await share(a, [{ name: 'url', value: 'https://example.org/p' }], junk(99))).statusCode).toBe(429);
    // Counted per token id too: guesses at one id from many addresses are throttled.
    const guess = { authorization: `Bearer ${id}${'B'.repeat(43)}` };
    for (let i = 0; i < TOKEN_FAILURES.max; i++) await a.app.inject({ method: 'POST', url: '/api/shares', headers: guess, remoteAddress: `10.0.0.${i + 1}` });
    expect((await a.app.inject({ method: 'POST', url: '/api/shares', headers: guess, remoteAddress: '10.0.1.1' })).statusCode).toBe(429);
    expect((await share(a, [{ name: 'url', value: 'https://example.org/q' }], { authorization: `Bearer ${token}` })).statusCode).toBe(202);
  });

  it(`at most ${MAX_LIVE_TOKENS} live tokens a person; a revoked one makes room`, async () => {
    const a = await app();
    const ids = [];
    for (let i = 0; i < MAX_LIVE_TOKENS; i++) ids.push((await newToken(a)).id);
    expect((await a.app.inject({ method: 'POST', url: '/api/share-tokens', headers: { cookie: a.alex, origin: ORIGIN }, payload: { label: 'x' } })).statusCode).toBe(409);
    await a.app.inject({ method: 'DELETE', url: `/api/share-tokens/${ids[0]}`, headers: { cookie: a.alex, origin: ORIGIN } });
    expect((await a.app.inject({ method: 'POST', url: '/api/share-tokens', headers: { cookie: a.alex, origin: ORIGIN }, payload: { label: 'x' } })).statusCode).toBe(201);
  });

  it('another adult cannot revoke, or see, your tokens', async () => {
    const a = await app();
    const { id, token } = await newToken(a);
    await a.app.inject({ method: 'DELETE', url: `/api/share-tokens/${id}`, headers: { cookie: a.sam, origin: ORIGIN } });
    expect((await a.app.inject({ url: '/api/share-tokens', headers: { cookie: a.sam } })).json()).toEqual([]);
    expect(findShareToken(a.db, token)?.id).toBe(id);
  });
});

describe('POST /shares: CSRF, limits, types by their bytes, and the media worker', () => {
  it('with a session, only from Philobiblos\'s Origin', async () => {
    const a = await app();
    for (const origin of ['https://evil.example', undefined]) {
      expect((await share(a, [{ name: 'url', value: 'https://example.org/p' }], { cookie: a.alex, ...(origin ? { origin } : {}) })).statusCode).toBe(403);
    }
    expect(a.db.select().from(t.share).all()).toEqual([]);
  });

  it('the type comes from the bytes: a PNG named .txt passes; a HEIC, a playlist or a script called JPEG does not, and nothing is staged', async () => {
    expect([JPEG, PNG, GIF, WEBP].map(imageType)).toEqual(['jpeg', 'png', 'gif', 'webp']);
    expect([HEIC, Buffer.from('<svg onload=alert(1)>'), Buffer.from('%PDF-1.7'), Buffer.from([0xff, 0xd8])].map(imageType)).toEqual([null, null, null, null]);
    // Each type needs its whole fixed header: one byte short, it is no image (a 3-byte FF D8 FF was a JPEG, PR #21 review).
    const heads = { jpeg: JPEG, png: PNG, gif: GIF, webp: WEBP };
    for (const [type, b] of Object.entries(heads) as [keyof typeof heads, Buffer][]) {
      expect([imageType(b.subarray(0, IMAGE_HEADER[type])), imageType(b.subarray(0, IMAGE_HEADER[type] - 1))]).toEqual([type, null]);
    }
    expect(IMAGE_HEADER).toEqual({ jpeg: 6, png: 33, webp: 20, gif: 13 });
    // and what the header says must be one: a JPEG's first marker and its length, a PNG's IHDR, a WebP's VP8 chunk
    expect([Buffer.from([0xff, 0xd8, 0xff, 0x00, 0, 2]), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]), Buffer.concat([PNG.subarray(0, 12), Buffer.from('IDAT'), PNG.subarray(16)]), Buffer.from('RIFF\0\0\0\0WEBPXXXX\0\0\0\0', 'latin1'), Buffer.from('GIF89b\x01\0\x01\0\0\0\0', 'latin1')].map(imageType)).toEqual([null, null, null, null, null]);
    expect((await share(await app(), [{ name: 'media', file: Buffer.from([0xff, 0xd8, 0xff]) }])).statusCode).toBe(415);
    const w = worker();
    const a = await app({ media: w.media });
    expect([MP4, WEBM, HEIC].map(shareFileType)).toEqual(['video', 'video', null]);
    for (const file of [HEIC, Buffer.from('<script>alert(1)</script>'), Buffer.from('#EXTM3U\n#EXTINF:10,\nfile:///etc/passwd\n')]) {
      const r = await share(a, [{ name: 'media', file: JPEG }, { name: 'media', file, type: 'image/jpeg' }]);
      expect(r.statusCode).toBe(415);
    }
    expect(existsSync(join(a.data, 'incoming')) ? readdirSync(join(a.data, 'incoming')) : []).toEqual([]);
    expect(a.db.select().from(t.share).all()).toEqual([]);
    expect((await share(a, [{ name: 'media', file: PNG, filename: 'notes.txt', type: 'text/plain' }])).statusCode).toBe(202);
  });

  it('a video goes to the worker as a video; only its frames are kept (NN-MM.jpg, with their offsets), and it counts as one file', async () => {
    const w = worker((b) => (b[4] === 0x66 ? { id: 'j', ok: true, kind: 'video.frames', frames: [{ width: 4, height: 3, bytes: OUT.length, at: 0 }, { width: 4, height: 3, bytes: OUT.length, at: 2 }], images: [OUT, OUT] } : { id: 'j', ok: true, kind: 'image.reencode', width: 1, height: 1, format: 'jpeg', bytes: OUT.length, image: OUT }));
    const a = await app({ media: w.media });
    const r = await share(a, [{ name: 'media', file: JPEG }, { name: 'media', file: MP4, filename: 'reel.mov', type: 'video/quicktime' }]);
    expect(r.statusCode).toBe(202);
    const { id } = r.json();
    await until(() => a.db.select().from(t.share).where(eq(t.share.id, id)).get()!.status === 'done');
    expect(w.kinds).toEqual(['image.reencode', 'video.frames']);
    expect(readdirSync(join(a.data, 'shares', id)).sort()).toEqual(['00.jpg', '01-00.jpg', '01-01.jpg']);
    expect(existsSync(join(a.data, 'incoming', id))).toBe(false);
    const row = a.db.select().from(t.share).where(eq(t.share.id, id)).get()!;
    expect(JSON.parse(row.mediaJson)).toEqual([{ path: `shares/${id}/00.jpg`, width: 1, height: 1 }, { path: `shares/${id}/01-00.jpg`, width: 4, height: 3, at: 0 }, { path: `shares/${id}/01-01.jpg`, width: 4, height: 3, at: 2 }]);
    expect((await a.app.inject({ url: `/api/shares/${id}`, headers: { cookie: a.alex } })).json()).toMatchObject({ status: 'done', progress: { done: 2, total: 2 }, refused: 0 });
    const item = (await a.app.inject({ url: '/api/inbox', headers: { cookie: a.alex } })).json().items[0];
    expect(item).toMatchObject({ title: '2 files', mediaCount: 3, share: { progress: { done: 2, total: 2 } } });
  });

  it('while a video\'s frames are kept and the next file waits, progress counts the video once', async () => {
    let n = 0;
    const w = worker(() => (n++ === 0 ? { id: 'j', ok: true, kind: 'video.frames', frames: [0, 2, 4].map((at) => ({ width: 1, height: 1, bytes: OUT.length, at })), images: [OUT, OUT, OUT] } : 'unavailable'));
    const a = await app({ media: w.media });
    const { id } = (await share(a, [{ name: 'media', file: MP4 }, { name: 'media', file: JPEG }])).json();
    await until(() => n >= 2);
    await until(() => !existsSync(join(a.data, 'incoming', id, '00.bin')));
    expect((await a.app.inject({ url: `/api/shares/${id}`, headers: { cookie: a.alex } })).json()).toMatchObject({ status: 'reading', progress: { done: 1, total: 2 } });
    expect((await a.app.inject({ url: '/api/inbox', headers: { cookie: a.alex } })).json().items[0]).toMatchObject({ share: { progress: { done: 1, total: 2 } } });
  });

  it('a video the worker refuses (too long, say) counts as one refused file; nothing of it is kept', async () => {
    const w = worker(() => ({ id: 'j', ok: false, error: 'too_long' }));
    const a = await app({ media: w.media });
    const { id } = (await share(a, [{ name: 'media', file: WEBM, type: 'video/webm' }])).json();
    await until(() => a.db.select().from(t.share).where(eq(t.share.id, id)).get()!.status === 'failed');
    expect(w.kinds).toEqual(['video.frames']);
    expect((await a.app.inject({ url: `/api/shares/${id}`, headers: { cookie: a.alex } })).json()).toMatchObject({ progress: { done: 1, total: 1 }, refused: 1 });
    expect(existsSync(join(a.data, 'shares', id))).toBe(false);
    expect(existsSync(join(a.data, 'incoming', id))).toBe(false);
  });

  it('sizes by type, and for the share: an image up to 20 MB, a video up to 64 MB, 100 MB together; nothing kept of a refused one', async () => {
    const a = await app();
    const big = (head: Buffer, mb: number) => Buffer.concat([head, Buffer.alloc(mb * 1024 * 1024 - head.length)]);
    expect((await share(a, [{ name: 'media', file: big(JPEG, 21) }])).statusCode).toBe(413);
    expect((await share(a, [{ name: 'media', file: big(MP4, 21) }])).statusCode).toBe(202);
    expect((await share(a, [{ name: 'media', file: big(MP4, 51) }, { name: 'media', file: big(MP4, 50) }])).statusCode).toBe(413);
    expect(a.db.select().from(t.share).all()).toHaveLength(1);
  }, 30_000);

  it('uploads stream to disk, a few at a time: past them, 429 and nothing read; a staged file is whole or not there', async () => {
    const w = worker(() => 'unavailable');
    const a = await app({ media: w.media });
    const { id } = (await share(a, [{ name: 'media', file: JPEG }, { name: 'media', file: MP4 }])).json();
    expect(readdirSync(join(a.data, 'incoming', id)).sort()).toEqual(['00.bin', '01.bin']);
    expect(readFileSync(join(a.data, 'incoming', id, '01.bin'))).toEqual(MP4);
    expect(SHARE_UPLOADS.active).toBe(0);
    // refused after part of it was written: nothing of the share stays, no half file either
    expect((await share(a, [{ name: 'media', file: JPEG }, { name: 'media', file: Buffer.concat([JPEG, Buffer.alloc(21 * 1024 * 1024)]) }])).statusCode).toBe(413);
    expect(readdirSync(join(a.data, 'incoming'))).toEqual([id]);
  });

  it('every file goes through the worker; only its JPEG is kept, the original deleted; progress counts kept and refused', async () => {
    const w = worker((b) => (b[0] === 0x89 ? { id: 'j', ok: false, error: 'too_many_pixels' } : { id: 'j', ok: true, kind: 'image.reencode', width: 10, height: 12, format: 'jpeg', bytes: OUT.length, image: OUT }));
    const a = await app({ media: w.media });
    const r = await share(a, [{ name: 'url', value: 'https://example.org/p/9' }, { name: 'text', value: 'A caption\u0000 with a book' }, { name: 'media', file: JPEG }, { name: 'media', file: PNG }]);
    expect(r.statusCode).toBe(202);
    const { id } = r.json();
    await until(() => a.db.select().from(t.share).where(eq(t.share.id, id)).get()!.status === 'done');
    expect(w.seen).toEqual([JPEG, PNG]);
    const s = (await a.app.inject({ url: `/api/shares/${id}`, headers: { cookie: a.alex } })).json();
    expect(s).toMatchObject({ status: 'done', progress: { done: 2, total: 2 }, refused: 1, found: [] });
    expect(readdirSync(join(a.data, 'shares', id))).toEqual(['00.jpg']);
    expect(readFileSync(join(a.data, 'shares', id, '00.jpg'))).toEqual(OUT);
    expect(existsSync(join(a.data, 'incoming', id))).toBe(false);
    const row = a.db.select().from(t.share).where(eq(t.share.id, id)).get()!;
    expect(row).toMatchObject({ caption: 'A caption with a book', url: 'https://example.org/p/9', mediaTotal: 2, mediaRefused: 1 });
  });

  it('all refused: the share failed (Philobiblos\'s words), and nothing of it is kept', async () => {
    const a = await app({ media: worker(() => ({ id: 'j', ok: false, error: 'unreadable' })).media });
    const { id } = (await share(a, [{ name: 'media', file: JPEG }])).json();
    await until(() => a.db.select().from(t.share).where(eq(t.share.id, id)).get()!.status === 'failed');
    expect((await a.app.inject({ url: `/api/shares/${id}`, headers: { cookie: a.alex } })).json()).toMatchObject({ status: 'failed', error: 'none of the images could be read' });
    expect(existsSync(join(a.data, 'incoming', id))).toBe(false);
  });

  it('no worker here: files are refused (503) and nothing staged; a link and a caption alone still work', async () => {
    const a = await app({ workDir: false });
    expect((await share(a, [{ name: 'media', file: JPEG }])).statusCode).toBe(503);
    expect(existsSync(join(a.data, 'incoming'))).toBe(false);
    const r = await share(a, [{ name: 'url', value: 'https://example.org/p/1' }]);
    expect(r.json()).toMatchObject({ status: 'done' });
  });

  it('the worker down: the share waits with its file staged, goes on when the worker is back, and gives up after a day', async () => {
    let up = false;
    const w = worker(() => (up ? { id: 'j', ok: true, kind: 'image.reencode', width: 1, height: 1, format: 'jpeg', bytes: OUT.length, image: OUT } : 'unavailable'));
    const a = await app({ media: w.media });
    const { id } = (await share(a, [{ name: 'media', file: JPEG }])).json();
    const p = new ShareProcessor(a.db, { dataDir: a.data, workDir: 'w', media: w.media });
    expect((await p.kick()).status).toBe('blocked');
    p.close();
    expect(readdirSync(join(a.data, 'incoming', id))).toEqual(['00.bin']);
    // Hours later, still waiting: its staged file is its own, never swept as an orphan.
    const hoursLater = new ShareProcessor(a.db, { dataDir: a.data, workDir: 'w', media: w.media, now: () => new Date(Date.now() + 2 * STAGED_MAX_AGE_MS) });
    await hoursLater.kick();
    hoursLater.close();
    expect(readdirSync(join(a.data, 'incoming', id))).toEqual(['00.bin']);
    up = true;
    expect(await p.kick()).toEqual({ status: 'done', detail: '1 shares read' });
    expect(a.db.select().from(t.share).where(eq(t.share.id, id)).get()!.status).toBe('done');
    up = false;
    const late = (await share(a, [{ name: 'media', file: JPEG }])).json().id as string;
    const later = new ShareProcessor(a.db, { dataDir: a.data, workDir: 'w', media: w.media, now: () => new Date(Date.now() + SHARE_PATIENCE_MS + 1000) });
    await later.kick();
    expect(a.db.select().from(t.share).where(eq(t.share.id, late)).get()).toMatchObject({ status: 'failed', error: 'the media worker did not read it within a day' });
    expect(existsSync(join(a.data, 'incoming', late))).toBe(false);
  });

  it('each original is deleted as soon as the worker has answered for it, even if the next one has to wait', async () => {
    let n = 0;
    const w = worker(() => (n++ === 0 ? { id: 'j', ok: true, kind: 'image.reencode', width: 1, height: 1, format: 'jpeg', bytes: OUT.length, image: OUT } : 'unavailable'));
    const a = await app({ media: w.media });
    const { id } = (await share(a, [{ name: 'media', file: JPEG }, { name: 'media', file: PNG }])).json();
    await until(() => n >= 2);
    await until(() => !existsSync(join(a.data, 'incoming', id, '00.bin')));
    expect(readdirSync(join(a.data, 'incoming', id))).toEqual(['01.bin']);
    expect((await a.app.inject({ url: `/api/shares/${id}`, headers: { cookie: a.alex } })).json()).toMatchObject({ status: 'reading', progress: { done: 1, total: 2 } });
  });

  it('refused: an empty share, a field too long, a link that is not http(s), files in another field', async () => {
    const a = await app();
    expect((await share(a, [])).statusCode).toBe(400);
    expect((await share(a, [{ name: 'note', value: 'x'.repeat(2001) }])).statusCode).toBe(400);
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pw@example.org/']) expect((await share(a, [{ name: 'url', value: url }])).statusCode, url).toBe(400);
    expect((await share(a, [{ name: 'other', file: JPEG }])).statusCode).toBe(400);
    expect(a.db.select().from(t.share).all()).toEqual([]);
  });

  it(`${SHARE_RATE.max} shares a person in ten minutes, then 429`, async () => {
    const a = await app();
    for (let i = 0; i < SHARE_RATE.max; i++) expect((await share(a, [{ name: 'url', value: `https://example.org/p/${i}` }])).statusCode).toBe(202);
    expect((await share(a, [{ name: 'url', value: 'https://example.org/p/x' }])).statusCode).toBe(429);
    expect((await share(a, [{ name: 'url', value: 'https://example.org/p/y' }], { cookie: a.sam, origin: ORIGIN })).statusCode).toBe(202);
  });

  it('a share is its sharer\'s: another adult gets 404, sees nothing of it in the Inbox, and cannot decide or dismiss it', async () => {
    const a = await app();
    const { id } = (await share(a, [{ name: 'url', value: 'https://example.org/p/1' }, { name: 'note', value: 'for my brain only' }])).json();
    a.db.update(t.share).set({ foundJson: JSON.stringify({ books: [{ title: 'Care at the Centre', author: 'Ruth Adeyemi', confidence: 0.9 }] }) }).where(eq(t.share.id, id)).run();
    expect((await a.app.inject({ url: `/api/shares/${id}`, headers: { cookie: a.sam } })).statusCode).toBe(404);
    expect(JSON.stringify((await a.app.inject({ url: '/api/inbox', headers: { cookie: a.sam } })).json().items)).not.toContain(id);
    expect((await a.app.inject({ method: 'POST', url: `/api/inbox/${shareItemId(id)}/books/0`, headers: { cookie: a.sam, origin: ORIGIN }, payload: { action: 'add' } })).statusCode).toBe(404);
    expect((await a.app.inject({ method: 'POST', url: `/api/inbox/${shareItemId(id)}/dismiss`, headers: { cookie: a.sam, origin: ORIGIN } })).statusCode).toBe(404);
    expect((await a.app.inject({ url: '/api/inbox', headers: { cookie: a.alex } })).json().items).toMatchObject([{ id: shareItemId(id), kind: 'share', found: [{ index: 0, title: 'Care at the Centre', verdict: 'add', decided: null }] }]);
  });
});

/** The app on a real port (inject never shows what a slow client does to the server). */
async function listening(a: Awaited<ReturnType<typeof app>>) {
  await a.app.listen({ port: 0, host: '127.0.0.1' });
  return (a.app.server.address() as AddressInfo).port;
}
/**
 * A share sent over a socket, chunked: its headers, then (with `first`) a media part's head and those bytes, then one
 * byte every `everyMs` if given, until `finish` (which ends the file and the form) or `destroy`.
 */
function slow(port: number, auth: Record<string, string>, o: { first?: Buffer; everyMs?: number } = {}) {
  const b = 'inbox-test-boundary';
  const s = connect(port, '127.0.0.1');
  let got = '';
  s.on('data', (d: Buffer) => { got += d.toString('latin1'); });
  s.on('error', () => {});
  let isClosed = false;
  const closed = new Promise<void>((r) => s.on('close', () => { isClosed = true; r(); }));
  const chunk = (x: Buffer | string) => { if (s.destroyed) return; const c = Buffer.from(x); s.write(`${c.length.toString(16)}\r\n`); s.write(c); s.write('\r\n'); };
  const head = Object.entries({ host: '127.0.0.1', 'content-type': `multipart/form-data; boundary=${b}`, 'transfer-encoding': 'chunked', ...auth }).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  s.write(`POST /api/shares HTTP/1.1\r\n${head}\r\n`);
  if (o.first) chunk(Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="media"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), o.first]));
  const tick = o.everyMs ? setInterval(() => chunk(Buffer.alloc(1)), o.everyMs) : undefined;
  const destroy = () => { clearInterval(tick); s.destroy(); };
  sockets.push(destroy);
  return {
    closed, isClosed: () => isClosed, status: () => /^HTTP\/1\.1 (\d{3})/.exec(got)?.[1] ?? null, destroy,
    finish: () => { clearInterval(tick); chunk(`${o.first ? '\r\n' : ''}--${b}\r\nContent-Disposition: form-data; name="url"\r\n\r\nhttps://example.org/p/slow\r\n--${b}--\r\n`); if (!s.destroyed) s.write('0\r\n\r\n'); },
  };
}
const within = async (ms: number, f: () => boolean) => { for (const end = Date.now() + ms; !f() && Date.now() < end;) await new Promise((r) => setTimeout(r, 10)); expect(f()).toBe(true); };
const staged = (a: { data: string }) => (existsSync(join(a.data, 'incoming')) ? readdirSync(join(a.data, 'incoming')) : []);

describe('uploads cannot be held open (PR #21 review): two a person, a few for the household; cut when idle, late or revoked', () => {
  it('the limits, and no request outlasts a share\'s deadline', async () => {
    const a = await app();
    expect(SHARE_UPLOADS).toMatchObject({ max: 6, perPerson: 2, idleMs: 15_000, deadlineMs: 5 * 60_000, active: 0 });
    expect(a.app.server.requestTimeout).toBe(SHARE_UPLOADS.deadlineMs + 60_000);
  });

  it('four trickling uploads from one adult (and their token) hold two slots: another adult\'s plain share still gets 202', async () => {
    const a = await app();
    const port = await listening(a);
    const mine = [0, 1, 2, 3].map(() => slow(port, { cookie: a.alex, origin: ORIGIN }, { first: JPEG, everyMs: 100 }));
    await within(3000, () => SHARE_UPLOADS.active === 2 && mine.filter((u) => u.status() === '429').length === 2);
    // A token is its person's: it counts against the same two.
    const { token } = await newToken(a);
    const viaToken = slow(port, { authorization: `Bearer ${token}` }, { first: JPEG, everyMs: 100 });
    await within(3000, () => viaToken.status() === '429');
    const other = slow(port, { cookie: a.sam, origin: ORIGIN });
    other.finish();
    await within(3000, () => other.status() !== null);
    expect(other.status()).toBe('202');
    for (const u of [...mine, viaToken]) u.destroy();
    await within(3000, () => SHARE_UPLOADS.active === 0);
    expect(staged(a)).toEqual([]);
  });

  it('the household\'s ceiling: past it, 429 even for someone with nothing open', async () => {
    SHARE_UPLOADS.max = 3;
    const a = await app();
    const port = await listening(a);
    for (const cookie of [a.alex, a.alex, a.sam]) slow(port, { cookie, origin: ORIGIN }, { first: JPEG, everyMs: 100 });
    await within(3000, () => SHARE_UPLOADS.active === 3);
    const robin = slow(port, { cookie: sessionCookie(a.db, 'p_del'), origin: ORIGIN });
    robin.finish();
    await within(3000, () => robin.status() !== null);
    expect(robin.status()).toBe('429');
  });

  it('an idle upload is cut: no bytes for idleMs, the request is destroyed, the slot comes back and nothing stays staged', async () => {
    SHARE_UPLOADS.idleMs = 300;
    const a = await app();
    const port = await listening(a);
    const quiet = slow(port, { cookie: a.alex, origin: ORIGIN }, { first: JPEG });
    const headersOnly = slow(port, { cookie: a.sam, origin: ORIGIN });
    // One that keeps sending is not idle, however slowly it arrives, and is taken once it is in.
    const steady = slow(port, { cookie: sessionCookie(a.db, 'p_del'), origin: ORIGIN }, { first: JPEG, everyMs: 50 });
    await within(3000, () => SHARE_UPLOADS.active === 3 && staged(a).length > 0);
    await within(3000, () => quiet.isClosed() && headersOnly.isClosed());
    expect([quiet.status(), headersOnly.status()]).toEqual([null, null]);
    await new Promise((r) => setTimeout(r, 700));
    expect([steady.isClosed(), SHARE_UPLOADS.active]).toEqual([false, 1]);
    steady.finish();
    await within(3000, () => steady.status() !== null);
    expect(steady.status()).toBe('202');
    await within(3000, () => SHARE_UPLOADS.active === 0);
    // Only the steady one's share: the cut ones left nothing.
    expect(a.db.select().from(t.share).all()).toHaveLength(1);
  });

  it('an upload that never ends is cut at its deadline, bytes or not; the slot comes back and nothing stays staged', async () => {
    Object.assign(SHARE_UPLOADS, { idleMs: 10_000, deadlineMs: 800 });
    const a = await app();
    const port = await listening(a);
    const forever = slow(port, { cookie: a.alex, origin: ORIGIN }, { first: JPEG, everyMs: 50 });
    await within(3000, () => SHARE_UPLOADS.active === 1 && staged(a).length === 1);
    await within(3000, () => forever.isClosed());
    expect(SHARE_UPLOADS.active).toBe(0);
    expect(staged(a)).toEqual([]);
    expect(a.db.select().from(t.share).all()).toEqual([]);
  });

  it('revoking a token cuts the uploads it has open, and only those', async () => {
    const a = await app();
    const port = await listening(a);
    const { id, token } = await newToken(a);
    const viaToken = slow(port, { authorization: `Bearer ${token}` }, { first: JPEG, everyMs: 100 });
    const viaSession = slow(port, { cookie: a.alex, origin: ORIGIN }, { first: JPEG, everyMs: 100 });
    await within(3000, () => SHARE_UPLOADS.active === 2 && staged(a).length === 2);
    // Another adult revoking it changes nothing.
    await a.app.inject({ method: 'DELETE', url: `/api/share-tokens/${id}`, headers: { cookie: a.sam, origin: ORIGIN } });
    await new Promise((r) => setTimeout(r, 300));
    expect([viaToken.isClosed(), SHARE_UPLOADS.active]).toEqual([false, 2]);
    expect((await a.app.inject({ method: 'DELETE', url: `/api/share-tokens/${id}`, headers: { cookie: a.alex, origin: ORIGIN } })).statusCode).toBe(204);
    await within(3000, () => viaToken.isClosed());
    expect([viaSession.isClosed(), SHARE_UPLOADS.active, staged(a).length]).toEqual([false, 1, 1]);
    viaSession.finish();
    await within(3000, () => viaSession.status() !== null);
    expect(viaSession.status()).toBe('202');
  });
});

describe('the Inbox', () => {
  const inv = (rows: string[][]) => ({ pdfText: async (): Promise<MediaOutcome> => ({ id: 'j', ok: true, kind: 'pdf.text', pages: 1, truncated: false, rows }) });
  /** A household that has read an invoice with an unmatched row, a toy and a row whose EAN is spaced; and a forgery. */
  async function withMail() {
    const db = household();
    db.insert(t.person).values({ id: 'p_kid2', name: 'Kid 2', role: 'kid', handle: 'kid2', birthYear: 2019 }).run();
    const pdf = Buffer.from('%PDF-1.4\n% invented\n');
    const raw = await signed(message({ id: 'inb1', from: 'rechnung@quillmere.example', subject: 'Ihre Quillmere-Rechnung Nr. 99001122', body: 'Ihre Rechnung.', pdf }));
    const forged = message({ id: 'inb2', from: 'rechnung@quillmere.example', subject: 'Ihre Quillmere-Rechnung Nr. 99001123', body: 'Bitte zahlen Sie hier: https://evil.example/pay' });
    const quote = await signed(message({ id: 'inb3', subject: 'Re: Book order, March 2031', body: 'Author: Ines Varga\nTitle: Harbour Lights\nISBN: 9780000000101\nPrice: CHF 21.00' }));
    await refreshMail(db, CFG, { open: async () => fakeBox([{ uid: 1, raw }, { uid: 2, raw: forged }, { uid: 3, raw: quote }]), resolver, ...inv([
      ['9780000000033', 'Gardens of the Commons', '2 ST', '15.00', '30.00 CHF', '2.6 %'],
      ['4001234567890', 'Wooden Train Set', '1 ST', '39.00', '39.00 CHF', '8.1 %'],
      ['978 0000 000040', 'The Patient River', '1 ST', '12.00', '12.00 CHF', '2.6 %'],
    ]) });
    return app({ db });
  }
  const list = async (a: Awaited<ReturnType<typeof app>>, cookie = a.alex, filter = 'all') => (await a.app.inject({ url: `/api/inbox?filter=${filter}`, headers: { cookie } })).json().items as { id: string; kind: string; title: string; found: { index: number; title: string | null; notBook?: boolean; eanUnreadable?: boolean }[]; mail?: Record<string, unknown>; unverified?: { count: number; reasons: { reason: string; count: number }[] } }[];
  const post = (a: Awaited<ReturnType<typeof app>>, url: string, payload?: object, cookie = a.alex) => a.app.inject({ method: 'POST', url, headers: { cookie, origin: ORIGIN }, ...(payload ? { payload } : {}) });

  it('the household\'s mail for every adult: unmatched lines (notBook and unreadable EANs too), and unverified mail by its reason only', async () => {
    const a = await withMail();
    const items = await list(a);
    expect(items.map((i) => i.kind).sort()).toEqual(['mail_unverified', 'unmatched_invoice_line', 'unmatched_quote_line']);
    expect(await list(a, a.sam)).toEqual(items);
    const invoice = items.find((i) => i.kind === 'unmatched_invoice_line')!;
    expect(invoice).toMatchObject({ id: mailItemId('<inb1@quillmere.example>'), title: 'Invoice 99001122', found: [
      { index: 0, title: 'Gardens of the Commons', ean: '9780000000033', qty: 2, priceC: 3000, decided: null },
      { index: 1, title: 'Wooden Train Set', notBook: true },
      { index: 2, title: 'The Patient River', ean: null, eanUnreadable: true },
    ] });
    const forged = items.find((i) => i.kind === 'mail_unverified')!;
    expect(forged).toMatchObject({ id: UNVERIFIED_ID, title: '1 mail not verified', unverified: { count: 1, reasons: [{ count: 1 }] } });
    expect(Object.keys(forged.mail!)).toEqual(['reason']);
    expect(JSON.stringify(forged)).not.toMatch(/evil|zahlen|99001123|rechnung@/i);
    expect((await list(a, a.alex, 'mail')).length).toBe(3);
    expect(await list(a, a.alex, 'shared')).toEqual([]);
    expect(await list(a, a.alex, 'ai')).toEqual([]);
    expect((await a.app.inject({ url: '/api/inbox?filter=nonsense', headers: { cookie: a.alex } })).statusCode).toBe(400);
  });

  it('an invoice line added becomes copies (owned); decided once; the item goes when nothing is left', async () => {
    const a = await withMail();
    const id = mailItemId('<inb1@quillmere.example>');
    const r = await post(a, `/api/inbox/${id}/books/0`, { action: 'add' });
    expect(r.statusCode, r.body).toBe(200);
    const book = a.db.select().from(t.book).where(eq(t.book.isbn13, '9780000000033')).get()!;
    expect(a.db.select().from(t.copy).where(eq(t.copy.bookId, book.id)).all().map((c) => [c.source, c.priceC])).toEqual([['invoice', 1500], ['invoice', 1500]]);
    expect((await post(a, `/api/inbox/${id}/books/0`, { action: 'skip' })).statusCode).toBe(409);
    // A toy, or a row whose EAN could not be read (a position number as much as a book), can only be skipped.
    expect((await post(a, `/api/inbox/${id}/books/1`, { action: 'add' })).statusCode).toBe(400);
    expect((await post(a, `/api/inbox/${id}/books/1`, { action: 'skip' })).statusCode).toBe(200);
    expect((await post(a, `/api/inbox/${id}/books/2`, { action: 'add' })).statusCode).toBe(400);
    expect((await post(a, `/api/inbox/${id}/books/2`, { action: 'skip' })).json()).toMatchObject({ found: [] });
    expect((await list(a)).map((i) => i.id)).not.toContain(id);
    expect((await post(a, `/api/inbox/${id}/books/7`, { action: 'skip' })).statusCode).toBe(404);
  });

  it('a quote line goes to a backlog: yours or a kid\'s, never another adult\'s', async () => {
    const a = await withMail();
    const id = mailItemId('<inb3@quillmere.example>');
    expect((await post(a, `/api/inbox/${id}/books/0`, { action: 'add', for: 'partner' })).statusCode).toBe(403);
    expect((await post(a, `/api/inbox/${id}/books/0`, { action: 'add', for: 'nobody' })).statusCode).toBe(404);
    expect((await post(a, `/api/inbox/${id}/books/0`, { action: 'add', for: 'kid2' })).statusCode).toBe(200);
    const book = a.db.select().from(t.book).where(eq(t.book.isbn13, '9780000000101')).get()!;
    expect(a.db.select().from(t.candidate).where(eq(t.candidate.bookId, book.id)).all().map((c) => [c.personId, c.origin])).toEqual([['p_kid2', 'manual']]);
    expect((await post(a, `/api/inbox/${id}/books/0`, { action: 'add', extra: 1 })).statusCode).toBe(400);
  });

  it('a share\'s book goes to the backlog with the share it came from', async () => {
    const a = await app();
    const { id } = (await share(a, [{ name: 'url', value: 'https://example.org/p/1' }])).json();
    a.db.update(t.share).set({ foundJson: JSON.stringify({ books: [{ title: 'Care at the Centre', author: 'Ruth Adeyemi', confidence: 0.9 }, { title: 42 }] }) }).where(eq(t.share.id, id)).run();
    expect((await post(a, `/api/inbox/${shareItemId(id)}/books/0`, { action: 'add' })).statusCode).toBe(200);
    const c = a.db.select().from(t.candidate).where(eq(t.candidate.shareId, id)).get()!;
    expect(c).toMatchObject({ personId: 'p_alex', origin: 'share' });
    // The AI's output is data: a found book that is not one (no title string) is not offered.
    expect((await post(a, `/api/inbox/${shareItemId(id)}/books/1`, { action: 'add' })).statusCode).toBe(404);
    expect(await list(a)).toEqual([]);
  });

  it('an imported share whose books are in a backlog already, offering none, asks nothing', async () => {
    const a = await app();
    const { id } = (await share(a, [{ name: 'url', value: 'https://example.org/p/1' }])).json();
    expect((await list(a)).map((i) => i.id)).toEqual([shareItemId(id)]);
    a.db.update(t.candidate).set({ shareId: id }).where(eq(t.candidate.bookId, 'b_tide')).run();
    expect(await list(a)).toEqual([]);
  });

  it('mail that failed closed shows its reason; mail waiting for the worker says so; dismissed, it is gone for everyone', async () => {
    const a = await withMail();
    const now = new Date().toISOString();
    a.db.insert(t.mailSeen).values([
      { messageId: '<f1@quillmere.example>', kind: 'unknown_layout', parserVersion: 'm3d-1/quote-1', seenAt: now, accepted: 1, authJson: '{}', parsedJson: JSON.stringify({ subject: 'Re: Book order, November 2026', expected: 'bookshop_quote', reason: 'a price Philobiblos cannot place' }) },
      { messageId: '<w1@quillmere.example>', kind: 'pending_pdf', parserVersion: 'm3d-1', seenAt: now, accepted: 1, authJson: '{}', parsedJson: JSON.stringify({ subject: 'Ihre Rechnung', tries: 2 }) },
    ]).run();
    const items = await list(a);
    expect(items.find((i) => i.kind === 'mail_failed')).toMatchObject({ title: 'Re: Book order, November 2026', mail: { reason: 'a price Philobiblos cannot place', expected: 'bookshop_quote' } });
    expect(items.find((i) => i.kind === 'mail_waiting')).toMatchObject({ mail: { reason: 'its PDF waits for the media worker (tried 2 times)' } });
    const id = mailItemId('<f1@quillmere.example>');
    expect((await post(a, `/api/inbox/${id}/dismiss`)).statusCode).toBe(204);
    expect((await list(a, a.sam)).map((i) => i.id)).not.toContain(id);
    expect((await post(a, `/api/inbox/m_${'0'.repeat(32)}/dismiss`)).statusCode).toBe(404);
  });

  it('an invoice line added: the library\'s own book (by title and author, not a duplicate), its order line delivered, at most 20 copies, on the to-read pile of whoever it is for (PR #16 review)', async () => {
    const a = await app();
    const now = new Date().toISOString();
    a.db.insert(t.order).values({ id: 'o_q', month: '2026-11', status: 'quoted', createdAt: now }).run();
    a.db.insert(t.orderLine).values({ orderId: 'o_q', bookId: 'b_tide', forPerson: 'p_alex', state: 'quoted' }).run();
    a.db.insert(t.mailSeen).values({ messageId: '<big@quillmere.example>', kind: 'invoice', parserVersion: 'm3d-1/invoice-1', seenAt: now, accepted: 1, authJson: '{}', parsedJson: JSON.stringify({ invoiceNumber: '1234', lines: [
      { ean: null, title: 'The Long Tide of Markets', qty: 2, priceC: 1000, totalC: 2000, vatPct: 2.6, bookId: null },
      { ean: '9780000000057', title: 'Box of Many', qty: 99, priceC: 100, totalC: 9900, vatPct: 2.6, bookId: null },
    ] }) }).run();
    const id = mailItemId('<big@quillmere.example>');
    const books = a.db.select().from(t.book).all().length;
    expect((await post(a, `/api/inbox/${id}/books/0`, { action: 'add', for: 'partner' })).statusCode).toBe(403);
    expect((await post(a, `/api/inbox/${id}/books/0`, { action: 'add', for: 'me' })).statusCode).toBe(200);
    expect(a.db.select().from(t.book).all().length).toBe(books);
    expect(a.db.select().from(t.copy).where(eq(t.copy.bookId, 'b_tide')).all().map((c) => c.orderId)).toEqual(['o_q', 'o_q']);
    expect(a.db.select().from(t.orderLine).where(eq(t.orderLine.orderId, 'o_q')).get()!.state).toBe('delivered');
    expect(a.db.select().from(t.order).where(eq(t.order.id, 'o_q')).get()).toMatchObject({ status: 'invoiced', invoicedC: 2000 });
    expect((await post(a, `/api/inbox/${id}/books/1`, { action: 'add', for: 'kid1' })).statusCode).toBe(200);
    const box = a.db.select().from(t.book).where(eq(t.book.isbn13, '9780000000057')).get()!;
    expect(box.audience).toBe('kids');
    expect(a.db.select().from(t.copy).where(eq(t.copy.bookId, box.id)).all().length).toBe(MAX_COPIES);
    expect(a.db.select().from(t.reading).where(eq(t.reading.bookId, box.id)).all().map((r) => [r.personId, r.status])).toEqual([['p_kid1', 'to_read']]);
  });

  it('matched lines never show; a dismissed item takes no decisions; an unverified mail is no item of its own (PR #16 review)', async () => {
    const a = await app();
    const now = new Date().toISOString();
    const lines = JSON.stringify({ invoiceNumber: '1', lines: [{ ean: null, title: 'The Long Tide of Markets', qty: 1, priceC: 1, totalC: 1, vatPct: 2.6, bookId: 'b_tide' }, { ean: null, title: 'Unknown', qty: 1, priceC: 1, totalC: 1, vatPct: 2.6, bookId: null }] });
    a.db.insert(t.mailSeen).values([
      { messageId: '<mixed@quillmere.example>', kind: 'invoice', parserVersion: 'x', seenAt: now, accepted: 1, authJson: '{}', parsedJson: lines },
      { messageId: 'unverified:lines', kind: 'invoice', parserVersion: 'x', seenAt: now, accepted: 0, authJson: '{}', parsedJson: lines },
    ]).run();
    const items = await list(a);
    expect(items.find((i) => i.id === mailItemId('<mixed@quillmere.example>'))!.found.map((f) => f.index)).toEqual([1]);
    expect(items.map((i) => i.id)).not.toContain(mailItemId('unverified:lines'));
    expect((await post(a, `/api/inbox/${mailItemId('unverified:lines')}/books/1`, { action: 'add' })).statusCode).toBe(404);
    const id = mailItemId('<mixed@quillmere.example>');
    expect((await post(a, `/api/inbox/${id}/dismiss`)).statusCode).toBe(204);
    expect((await post(a, `/api/inbox/${id}/books/1`, { action: 'skip' })).statusCode).toBe(409);
    expect(a.db.select().from(t.copy).all()).toEqual([]);
  });

  it('40,000 unverified mails are one item, the reasons counted; the Inbox stays a page; dismissed, the item comes back only with new ones (PR #16 review)', async () => {
    const a = await app();
    const old = '2026-11-01T00:00:00.000Z';
    const ins = a.db.$client.prepare('INSERT INTO mail_seen (message_id, kind, parsed_json, parser_version, seen_at, auth_json, accepted) VALUES (?, ?, NULL, ?, ?, ?, 0)');
    a.db.$client.transaction(() => {
      for (let i = 0; i < 40_000; i++) ins.run(`unverified:${i}`, 'not_verified', 'm3d-1', old, JSON.stringify({ accepted: false, reason: i % 4 ? 'not from the bookshop' : 'no valid signature of the bookshop' }));
    })();
    const r = await a.app.inject({ url: '/api/inbox', headers: { cookie: a.alex } });
    expect(r.statusCode).toBe(200);
    const items = r.json().items as { id: string; unverified?: { count: number; reasons: unknown[] } }[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: UNVERIFIED_ID, unverified: { count: 40_000, reasons: [{ reason: 'not from the bookshop', count: 30_000 }, { reason: 'no valid signature of the bookshop', count: 10_000 }] } });
    expect((await post(a, `/api/inbox/${UNVERIFIED_ID}/dismiss`)).statusCode).toBe(204);
    expect(await list(a)).toEqual([]);
    ins.run('unverified:new', 'not_verified', 'm3d-1', new Date(Date.now() + 1000).toISOString(), JSON.stringify({ reason: 'not addressed to the household' }));
    expect(await list(a)).toMatchObject([{ id: UNVERIFIED_ID, unverified: { count: 1 } }]);
  }, 30_000);

  it('pages: every item once, newest first, through nextCursor; a limit and a cursor out of range are refused', async () => {
    const a = await app();
    const ins = a.db.$client.prepare("INSERT INTO mail_seen (message_id, kind, parsed_json, parser_version, seen_at, auth_json, accepted) VALUES (?, 'unknown_layout', '{\"reason\":\"x\"}', 'v', ?, '{}', 1)");
    // 260 failed mails, many on the same second (the cursor breaks ties), 40 of them dismissed; and 70 shares.
    for (let i = 0; i < 260; i++) ins.run(`<f${i}@quillmere.example>`, `2026-11-0${1 + (i % 5)}T00:00:00.000Z`);
    for (let i = 0; i < 40; i++) a.db.insert(t.inboxDecision).values({ item: mailItemId(`<f${i}@quillmere.example>`), idx: -1, decision: 'dismissed', decidedAt: 'x' }).run();
    for (let i = 0; i < 70; i++) a.db.insert(t.share).values({ id: `01JC${String(i).padStart(22, '0')}`, personId: 'p_alex', note: 'n', status: 'done', createdAt: `2026-11-0${1 + (i % 7)}T00:00:00.000Z` }).run();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      // A small page, so that pages end on shares and on mails that share a second with each other.
      const r = await a.app.inject({ url: `/api/inbox?limit=${pages % 2 ? 7 : 3}${cursor ? `&cursor=${cursor}` : ''}`, headers: { cookie: a.alex } });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { items: { id: string; createdAt: string }[]; nextCursor: string | null };
      expect(body.items.length).toBeLessThanOrEqual(PAGE.max);
      seen.push(...body.items.map((i) => `${i.createdAt} ${i.id}`));
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 200);
    expect(seen).toHaveLength(220 + 70);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort().reverse().map((x) => x.slice(0, 24))).toEqual(seen.map((x) => x.slice(0, 24)));
    for (const q of ['limit=0', 'limit=101', 'cursor=nonsense']) expect((await a.app.inject({ url: `/api/inbox?${q}`, headers: { cookie: a.alex } })).statusCode, q).toBe(400);
  });

  it('staged files that no waiting share owns are swept after an hour; a fresh upload is left alone', async () => {
    const a = await app({ media: worker(() => 'unavailable').media });
    for (const n of ['orphan', 'fresh']) { mkdirSync(join(a.data, 'incoming', n), { recursive: true }); writeFileSync(join(a.data, 'incoming', n, '00.bin'), JPEG); }
    const p = new ShareProcessor(a.db, { dataDir: a.data, workDir: 'w', now: () => new Date(Date.now() + STAGED_MAX_AGE_MS / 2) });
    await p.kick();
    expect(readdirSync(join(a.data, 'incoming')).sort()).toEqual(['fresh', 'orphan']);
    const later = new ShareProcessor(a.db, { dataDir: a.data, workDir: 'w', now: () => new Date(Date.now() + STAGED_MAX_AGE_MS + 1000) });
    await later.kick();
    expect(readdirSync(join(a.data, 'incoming'))).toEqual([]);
  });

  it(`a page reads at most ${PAGE.scan} rows: settled rows newer than anything waiting give an empty page with a cursor, and the next has the item (PR #17 review)`, async () => {
    const a = await app();
    const ins = a.db.$client.prepare("INSERT INTO mail_seen (message_id, kind, parsed_json, parser_version, seen_at, auth_json, accepted) VALUES (?, 'unknown_layout', '{}', 'v', ?, '{}', 1)");
    const dis = a.db.$client.prepare("INSERT INTO inbox_decision (item, idx, decision, decided_at) VALUES (?, -1, 'dismissed', 'x')");
    a.db.$client.transaction(() => {
      ins.run('<old@quillmere.example>', '2026-01-01T00:00:00.000Z');
      for (let i = 0; i < PAGE.scan + 100; i++) { ins.run(`<d${i}@quillmere.example>`, '2026-11-01T00:00:00.000Z'); dis.run(mailItemId(`<d${i}@quillmere.example>`)); }
    })();
    const first = (await a.app.inject({ url: '/api/inbox', headers: { cookie: a.alex } })).json() as { items: unknown[]; nextCursor: string | null };
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toBeTruthy();
    const second = (await a.app.inject({ url: `/api/inbox?cursor=${first.nextCursor}`, headers: { cookie: a.alex } })).json() as { items: { id: string }[]; nextCursor: string | null };
    expect(second).toEqual({ items: [expect.objectContaining({ id: mailItemId('<old@quillmere.example>') })], nextCursor: null });
  }, 30_000);
});
