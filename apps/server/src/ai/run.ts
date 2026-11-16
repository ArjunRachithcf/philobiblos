// Runs one AI job (contracts/ai-plugin.md, ADR 0009): the one way a Model is called.
//
// - The prompt comes from packages/ai (its versioned file, the input minimised by the job's `split`, outside text in
//   `<untrusted>` blocks). Takeaways can be in it only when the caller says whose (`takeawaysOf`): the run then carries
//   it, and what it proposes is private to that person (knowledge/from-run.ts).
// - Bounded: the prompt's size, the images (count, bytes, JPEG only), the answer's size, a deadline per call, and the
//   caller's budget of calls and tokens for its whole job run, and with Claude the household's daily allowance across
//   every run (ai/spend.ts): a call that could go past it is not made.
// - The answer is data: parsed, validated against contracts/ai/<job>.schema.json, cleaned by the job (ids only from the
//   input, one-line texts), every string through `safeField` (no piece of the delivery address, no long digit runs), and
//   validated again. Invalid or failed: tried once more, then the run is logged as failed.
// - Every call is logged in ai_run (provider, model, prompt version, input hash, output or error, cost); an identical
//   input under the same prompt version, provider, model and person reuses the stored output.
// - Errors are Philobiblos's own words: never a key, the prompt or what the model answered.
import { createHash } from 'node:crypto';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';
import { validateAiOutput } from '@philobiblos/contracts';
import { JOBS, ModelError, buildPrompt, holdsTakeaways, wireSchema, type JobIO, type JobName, type Model } from '@philobiblos/ai';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { safeField } from '../mail/read';
import { getAi } from './settings';
import { SHARE_SPEND, SPEND, spentToday } from './spend';

export const AI_LIMITS = {
  /** Characters of the system and user message together. */
  prompt: 120_000,
  /** Characters of an answer. */
  answer: 64_000,
  images: 30,
  imageBytes: 24 << 20,
  timeoutMs: { ollama: 180_000, claude: 90_000, fake: 5_000 } as Record<Model['provider'], number>,
} as const;

/** What calls in flight hold reserved against the allowance (ai/spend.ts), per database: the household's ('all'), and a share's sharer's ('p:…') and token's ('t:…'). */
const reserved = new WeakMap<Db, Map<string, number>>();
const held = (db: Db, k: string) => reserved.get(db)?.get(k) ?? 0;

/** A job run's allowance: calls and tokens (input and output) across every AI call it makes. */
export class AiBudget {
  calls = 0;
  tokens = 0;
  constructor(readonly maxCalls = 60, readonly maxTokens = 400_000) {}
  take(): void {
    if (this.calls >= this.maxCalls || this.tokens >= this.maxTokens) throw new AiError('budget', `this run's AI budget is spent (${this.calls} calls, ${this.tokens} tokens)`);
    this.calls++;
  }
}

export class AiError extends Error {
  /** `scope` of a budget error: the household's allowance, or only this share's sharer's or token's part of it. */
  constructor(readonly reason: 'budget' | 'too_large' | 'failed' | 'takeaways', message: string, readonly runId?: string, readonly scope: 'run' | 'household' | 'person' | 'token' = 'run') {
    super(message);
    this.name = 'AiError';
  }
}

export interface RunContext {
  budget: AiBudget;
  /** Whose request it serves (ai_run.person_id). */
  personId?: string | null;
  /** Whose takeaways the input holds; required exactly when it holds any. */
  takeawaysOf?: string | null;
  /** extractTitles: the share's JPEGs, as the media worker re-encoded them. */
  images?: Buffer[];
  /** The delivery address's pieces (mail/read.ts addressParts): no answer keeps a string holding one. */
  address?: string[];
  /** A share's run: its sharer and the token it came with, each held to their part of the allowance (ai/spend.ts). */
  share?: { personId: string; tokenId: string | null };
  now?: () => Date;
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const isJpeg = (b: Buffer) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;

/**
 * Every string through safeField: an array drops each item that holds a string it refuses; an object holding one is
 * refused itself (null). A string over 300 characters is refused (safeField reads that many).
 */
export function scrub(v: unknown, address: string[]): unknown {
  if (typeof v === 'string') return v.length <= 300 && safeField(v, address) !== null ? v : null;
  if (Array.isArray(v)) return v.map((x) => scrub(x, address)).filter((x) => x !== null);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const s = scrub(x, address);
      if (s === null && x !== null) return null;
      out[k] = s;
    }
    return out;
  }
  return v;
}

type Out<J extends JobName> = JobIO[J][1];
type Checked<J extends JobName> = { ok: true; out: Out<J> } | { ok: false; error: string };
function check<J extends JobName>(job: J, text: string, input: JobIO[J][0], images: number, address: string[]): Checked<J> {
  if (text.length > AI_LIMITS.answer) return { ok: false, error: `an answer over ${AI_LIMITS.answer} characters` };
  let o: unknown;
  try { o = JSON.parse(text); } catch { return { ok: false, error: 'an answer that is not JSON' }; }
  const v1 = validateAiOutput(job, o);
  if (!v1.ok) return { ok: false, error: `an answer off the schema: ${v1.errors.slice(0, 3).join('; ')}` };
  const c = (JOBS[job].clean as (o: unknown, i: unknown, n: number) => Checked<J>)(o, input, images);
  if (!c.ok) return c;
  const s = scrub(c.out, address);
  if (s === null) return { ok: false, error: 'an answer with a text Philobiblos does not keep (an address or a long number)' };
  const v2 = validateAiOutput(job, s);
  if (!v2.ok) return { ok: false, error: `an answer off the schema once cleaned: ${v2.errors.slice(0, 3).join('; ')}` };
  return { ok: true, out: s as Out<J> };
}

/** Runs `job` on `model`; resolves with the run's id and its checked output, or throws AiError (the run logged). */
export async function runAi<J extends JobName>(db: Db, model: Model, job: J, input: JobIO[J][0], ctx: RunContext): Promise<{ runId: string; output: Out<J>; cached: boolean }> {
  const now = ctx.now ?? (() => new Date());
  const takeaways = holdsTakeaways(job, input as never);
  if (takeaways !== Boolean(ctx.takeawaysOf)) throw new AiError('takeaways', takeaways ? 'takeaways would be sent without saying whose' : 'takeawaysOf named for an input without takeaways');
  const address = ctx.address ?? [];
  // Images only to a model that reads them; never anything but a JPEG Philobiblos re-encoded.
  const images = model.supportsVision ? (ctx.images ?? []) : [];
  if (images.length > AI_LIMITS.images || images.reduce((n, b) => n + b.length, 0) > AI_LIMITS.imageBytes || images.some((b) => !isJpeg(b))) {
    throw new AiError('too_large', `images: at most ${AI_LIMITS.images} JPEGs, ${AI_LIMITS.imageBytes >> 20} MB together`);
  }
  const built = buildPrompt(job, input as never, images.length);
  if (built.system.length + built.user.length > AI_LIMITS.prompt) throw new AiError('too_large', `a prompt over ${AI_LIMITS.prompt} characters`);
  const inputHash = sha(JSON.stringify([job, built.promptVersion, model.provider, model.model, built.system, built.user, images.map((b) => sha(b))]));
  const personId = ctx.personId ?? null, takeawaysOf = ctx.takeawaysOf ?? null;

  const hit = db.select().from(t.aiRun).where(and(
    eq(t.aiRun.job, job), eq(t.aiRun.promptVersion, built.promptVersion), eq(t.aiRun.inputHash, inputHash), eq(t.aiRun.provider, model.provider),
    isNotNull(t.aiRun.outputJson), personId ? eq(t.aiRun.personId, personId) : isNull(t.aiRun.personId),
    takeawaysOf ? eq(t.aiRun.takeawaysOf, takeawaysOf) : isNull(t.aiRun.takeawaysOf),
  )).get();
  if (hit) {
    // Checked again: a stored answer is no more trusted than a fresh one.
    const c = check(job, hit.outputJson!, input, images.length, address);
    if (c.ok) return { runId: hit.id, output: c.out, cached: true };
  }

  const startedAt = now().toISOString();
  let cost = 0, tokens = 0, error = 'no answer', served = model.model;
  let out: Out<J> | null = null;
  // The most one call can cost (SPEND), reserved against the household's allowance while it is out.
  const bound = model.provider === 'claude' ? Buffer.byteLength(built.system) + Buffer.byteLength(built.user) + images.length * SPEND.perImage + JOBS[job].maxTokens + SPEND.overhead : 0;
  const allowance = model.provider === 'claude' ? getAi(db).dailyTokens : Infinity;
  // This run's spend stays reserved until its row records it, so no other run can miss it in between.
  const keys = ['all', ...(ctx.share ? [`p:${ctx.share.personId}`, ...(ctx.share.tokenId ? [`t:${ctx.share.tokenId}`] : [])] : [])];
  const hold = (n: number) => {
    if (!n) return;
    const m = reserved.get(db) ?? new Map<string, number>();
    reserved.set(db, m);
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + n);
  };
  const id = ulid();
  try {
    for (let attempt = 0; attempt < 2 && !out; attempt++) {
      // Nothing sent yet: the budget refuses the run. A retry it refuses ends the run as failed, logged.
      try {
        ctx.budget.take();
        if (bound) {
          const spent = spentToday(db, now()) + held(db, 'all');
          if (spent + bound > allowance) throw new AiError('budget', `the household's AI allowance for the day is spent (${spent} of ${allowance} tokens in the last 24 hours)`, undefined, 'household');
          // A share's run: its sharer, and its token, may spend only their part, so a leaked token cannot stop everyone's AI.
          if (ctx.share) {
            const by = spentToday(db, now(), { personId: ctx.share.personId }) + held(db, `p:${ctx.share.personId}`);
            if (by + bound > allowance * SHARE_SPEND.perPerson) throw new AiError('budget', "this person's shares have used their part of the day's AI allowance", undefined, 'person');
            const tok = ctx.share.tokenId;
            if (tok && spentToday(db, now(), { tokenId: tok }) + held(db, `t:${tok}`) + bound > allowance * SHARE_SPEND.perToken) throw new AiError('budget', "this share token's shares have used their part of the day's AI allowance", undefined, 'token');
          }
        }
      } catch (e) { if (attempt === 0) throw e; error = (e as Error).message; break; }
      hold(bound);
      // What the call counts as: the provider's count, or its bound when it failed without one (a truncated answer or
      // a timeout may still have been billed).
      let used = bound;
      try {
        const reply = await model.complete({
          job, system: built.system, user: built.user, images: images.map((b) => ({ mimeType: 'image/jpeg' as const, base64: b.toString('base64') })),
          schema: wireSchema(job), maxTokens: JOBS[job].maxTokens, timeoutMs: AI_LIMITS.timeoutMs[model.provider],
        });
        used = reply.inputTokens + reply.outputTokens;
        ctx.budget.tokens += used;
        cost += reply.costCents;
        served = reply.model;
        const c = check(job, reply.text, input, images.length, address);
        if (c.ok) out = c.out; else error = c.error;
      } catch (e) {
        error = e instanceof ModelError ? e.message : 'the provider call failed';
      } finally {
        tokens += used;
        if (bound) hold(used - bound);
      }
    }
    db.insert(t.aiRun).values({
      id, job, provider: model.provider, model: served.slice(0, 100), promptVersion: built.promptVersion, inputHash,
      outputJson: out ? JSON.stringify(out) : null, costC: cost, startedAt, finishedAt: now().toISOString(),
      error: out ? null : error.slice(0, 300), takeawaysOf, personId, tokens, shareTokenId: ctx.share?.tokenId ?? null,
    }).run();
  } finally {
    if (bound) hold(-tokens);
  }
  if (!out) throw new AiError('failed', `${job}: ${error}`, id);
  return { runId: id, output: out, cached: false };
}
