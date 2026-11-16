// The household's AI settings (Settings.ai, contracts/ai-plugin.md): which provider, its models, which jobs run.
//
// - Ollama is the default and nothing leaves the home network with it. Claude is an explicit opt-in by an admin: the
//   request that turns it on must carry `acceptLeaves: true`, the answer to the list Settings shows (`leavesWithClaude`)
//   before it is on and (`leaves`) while it is.
// - The Claude API key is sealed like the delivery address (household/sealed.ts: AES-256-GCM, the key outside the
//   database, the row's name bound to it). It is write-only: no answer of any route holds it, only `hasClaudeKey`.
// - Removing the key while Claude is on turns the AI off ('none'), never over to another provider.
import { eq } from 'drizzle-orm';
import { CLAUDE_DEFAULT_MODEL, CLAUDE_MODEL } from '@shelf/ai';
import type { Config } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { isSealed, keyProblem, seal, sealingKey } from '../household/sealed';
import { SettingsError } from '../library/settings';

export const CLAUDE_KEY = 'claude_api_key';
export const DEFAULT_OLLAMA_MODEL = 'llama3.2';
export type Provider = 'claude' | 'ollama' | 'none';
export interface AiJobs { read: boolean; link: boolean; suggest: boolean; explain: boolean; wildcards: boolean }
export const DEFAULT_JOBS: AiJobs = { read: true, link: true, suggest: true, explain: true, wildcards: true };
export interface AiModels { ollama: { model: string; visionModel: string | null }; claude: { model: string } }

/** An Ollama model name (`name[:tag]`, a namespace allowed): anything else never reaches a request. */
export const OLLAMA_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?(?::[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
/** Anthropic's keys: `sk-ant-` then letters, digits, `-` and `_`. Checked before it is sealed; never echoed. */
export const CLAUDE_KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;

export interface AiSettings { provider: Provider; jobs: AiJobs; models: AiModels; hasClaudeKey: boolean }

const obj = (s: string): Record<string, unknown> => { try { const o = JSON.parse(s) as unknown; return o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, unknown> : {}; } catch { return {}; } };

function row(db: Db) {
  db.insert(t.householdSettings).values({ id: 1 }).onConflictDoNothing().run();
  return db.select().from(t.householdSettings).where(eq(t.householdSettings.id, 1)).get()!;
}

export function getAi(db: Db): AiSettings {
  const r = row(db);
  const j = obj(r.aiJobsJson), m = obj(r.aiModelsJson);
  const jobs = { ...DEFAULT_JOBS };
  for (const k of Object.keys(DEFAULT_JOBS) as (keyof AiJobs)[]) if (typeof j[k] === 'boolean') jobs[k] = j[k] as boolean;
  const o = (m.ollama ?? {}) as Record<string, unknown>, c = (m.claude ?? {}) as Record<string, unknown>;
  const name = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : null);
  return {
    provider: r.aiProvider,
    jobs,
    models: {
      ollama: { model: name(o.model, OLLAMA_MODEL) ?? DEFAULT_OLLAMA_MODEL, visionModel: name(o.visionModel, OLLAMA_MODEL) },
      claude: { model: name(c.model, CLAUDE_MODEL) ?? CLAUDE_DEFAULT_MODEL },
    },
    hasClaudeKey: isSealed(db, CLAUDE_KEY),
  };
}

/** What leaves the server with this provider and these jobs (Settings.ai.leaves): empty unless it is Claude. */
export function leaves(provider: Provider, jobs: AiJobs): string[] {
  if (provider !== 'claude') return [];
  return [
    'Goes to Anthropic (api.anthropic.com), and nowhere else',
    "Books' titles, authors and descriptions",
    "The names of the ideas in each person's reading map, how many books they read in each and which layers are empty",
    ...(jobs.read ? ["Shared posts' images (as Shelf re-encoded them), captions and links"] : []),
    ...(jobs.link ? ['The takeaways of each person who turned on "Takeaways to the AI" (nobody else\'s)'] : []),
    'Never: names of people or kids, the delivery address, mail, or anything about who reads what',
  ];
}

/** GET /settings' `ai`. The key never; only whether there is one. */
export function aiView(db: Db, cfg: Pick<Config, 'ollamaUrl'>) {
  const s = getAi(db);
  return {
    provider: s.provider, model: s.models.ollama.model, visionModel: s.models.ollama.visionModel, claudeModel: s.models.claude.model,
    ollamaUrl: cfg.ollamaUrl ?? '', ollamaConfigured: cfg.ollamaUrl != null, hasClaudeKey: s.hasClaudeKey,
    leaves: leaves(s.provider, s.jobs), leavesWithClaude: leaves('claude', s.jobs), jobs: s.jobs,
  };
}

const ALLOWED = ['provider', 'model', 'visionModel', 'claudeModel', 'claudeApiKey', 'acceptLeaves', 'jobs'];

/** The `ai` part of PATCH /settings, checked whole before anything is written (admins only: routes/library.ts). */
export function checkAi(db: Db, cfg: Pick<Config, 'sealingKey'>, v: unknown): (tx: Db) => void {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SettingsError('ai: a JSON object is needed');
  const p = v as Record<string, unknown>;
  for (const k of Object.keys(p)) if (!ALLOWED.includes(k)) throw new SettingsError(`ai: ${k} is not one of its settings`);
  const now = getAi(db);
  if (p.provider !== undefined && p.provider !== 'claude' && p.provider !== 'ollama' && p.provider !== 'none') throw new SettingsError('ai.provider: claude, ollama or none');
  const model = (k: string, re: RegExp, nullable = false) => {
    const x = p[k];
    if (x === undefined || (nullable && x === null)) return;
    if (typeof x !== 'string' || !re.test(x)) throw new SettingsError(`ai.${k}: not a model name`);
  };
  model('model', OLLAMA_MODEL);
  model('visionModel', OLLAMA_MODEL, true);
  model('claudeModel', CLAUDE_MODEL);
  // The key's own value is never part of a message, valid or not.
  if (p.claudeApiKey !== undefined && p.claudeApiKey !== null && (typeof p.claudeApiKey !== 'string' || !CLAUDE_KEY_SHAPE.test(p.claudeApiKey.trim()))) {
    throw new SettingsError('ai.claudeApiKey: that is not an Anthropic API key (sk-ant-…)');
  }
  if (p.acceptLeaves !== undefined && typeof p.acceptLeaves !== 'boolean') throw new SettingsError('ai.acceptLeaves: true or false');
  let jobs = now.jobs;
  if (p.jobs !== undefined) {
    if (!p.jobs || typeof p.jobs !== 'object' || Array.isArray(p.jobs)) throw new SettingsError('ai.jobs: a JSON object is needed');
    jobs = { ...now.jobs };
    for (const [k, x] of Object.entries(p.jobs)) {
      if (!(k in DEFAULT_JOBS)) throw new SettingsError(`ai.jobs: ${k} is not one of the jobs`);
      if (typeof x !== 'boolean') throw new SettingsError(`ai.jobs.${k}: true or false`);
      (jobs as unknown as Record<string, boolean>)[k] = x;
    }
  }
  const keyAfter = p.claudeApiKey === undefined ? now.hasClaudeKey : p.claudeApiKey !== null;
  let provider = (p.provider as Provider | undefined) ?? now.provider;
  if (provider === 'claude' && now.provider !== 'claude') {
    // The opt-in: an admin who saw the list, and a key to send with.
    if (p.acceptLeaves !== true) throw new SettingsError('ai.provider claude: turning Claude on needs acceptLeaves: true, after reading what leaves (leavesWithClaude)');
    if (!keyAfter) throw new SettingsError('ai.provider claude: an API key is needed first (claudeApiKey)');
  }
  if (provider === 'claude' && !keyAfter) provider = 'none';
  // While Claude is on, a job turned on sends more: the same acceptance, for the longer list.
  if (provider === 'claude' && now.provider === 'claude' && leaves('claude', jobs).length > leaves('claude', now.jobs).length && p.acceptLeaves !== true) {
    throw new SettingsError('ai.jobs: with Claude on, this sends more (see leavesWithClaude): it needs acceptLeaves: true');
  }
  if (typeof p.claudeApiKey === 'string' && keyProblem(cfg)) throw new SealKeyMissing();
  const key = typeof p.claudeApiKey === 'string' ? sealingKey(cfg) : null;
  return (tx) => {
    const r = row(tx);
    const m = obj(r.aiModelsJson);
    const models = {
      ollama: { model: (p.model as string | undefined) ?? now.models.ollama.model, visionModel: p.visionModel === undefined ? now.models.ollama.visionModel : (p.visionModel as string | null) },
      claude: { model: (p.claudeModel as string | undefined) ?? now.models.claude.model },
    };
    if (p.claudeApiKey !== undefined) seal(tx, key!, CLAUDE_KEY, typeof p.claudeApiKey === 'string' ? p.claudeApiKey.trim() : null);
    tx.update(t.householdSettings).set({ aiProvider: provider, aiJobsJson: JSON.stringify(jobs), aiModelsJson: JSON.stringify({ ...m, ...models }) }).where(eq(t.householdSettings.id, 1)).run();
  };
}

/** A key to seal with is missing or unreadable (409, like the addresses). */
export class SealKeyMissing extends Error { constructor() { super('the sealing key is missing or unreadable: fix SHELF_SEALING_KEY on the server'); } }
