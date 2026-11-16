// The household's AI model as its settings say (ai/settings.ts), reaching its provider only through an egress client
// whose whole allowlist is that provider's host (net/egress.ts aiEgressRules).
import { createClaudeModel, createOllamaModel, type Model, type Transport } from '@shelf/ai';
import type { Config } from '../config';
import type { Db } from '../db/open';
import { SealError, sealingKey, unseal } from '../household/sealed';
import { aiEgressRules, createEgress, type Egress, type Rule } from '../net/egress';
import { CLAUDE_KEY, getAi } from './settings';

export type ModelFor = { model: Model; why?: undefined } | { model: null; why: string };
export interface ModelDeps { egress?: (rules: Rule[]) => Egress }

const transport = (e: Egress): Transport => async (url, body, o) => (await e.post(url, body, o)).body;

/** The model the AI jobs use now, or why there is none (the AI off, Ollama not configured, no Claude key). */
export function modelFor(db: Db, cfg: Pick<Config, 'ollamaUrl' | 'egress' | 'sealingKey'>, deps: ModelDeps = {}): ModelFor {
  const s = getAi(db);
  if (s.provider === 'none') return { model: null, why: 'the AI is off (Settings)' };
  if (!cfg.egress) return { model: null, why: 'outgoing requests are turned off (SHELF_EGRESS=off)' };
  const egress = (rules: Rule[]) => (deps.egress ?? ((r) => createEgress({ rules: r, enabled: cfg.egress })))(rules);
  if (s.provider === 'ollama') {
    if (!cfg.ollamaUrl) return { model: null, why: 'no Ollama is configured (OLLAMA_URL)' };
    return { model: createOllamaModel({ url: cfg.ollamaUrl, model: s.models.ollama.model, visionModel: s.models.ollama.visionModel, transport: transport(egress(aiEgressRules('ollama', cfg.ollamaUrl))) }) };
  }
  let apiKey: string | null = null;
  try { apiKey = unseal(db, sealingKey(cfg), CLAUDE_KEY); } catch (e) { if (!(e instanceof SealError)) throw e; }
  if (!apiKey) return { model: null, why: 'the Claude API key is missing or sealed under another key: an admin enters it again' };
  return { model: createClaudeModel({ apiKey, model: s.models.claude.model, transport: transport(egress(aiEgressRules('claude', null))) }) };
}
