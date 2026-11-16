// A job's output schema as a provider's structured output takes it: the contract's schema (contracts/ai/*.schema.json)
// with what providers refuse taken out (numeric and length bounds) and every object closed (additionalProperties
// false). The bounds still hold: the server validates every answer against the full contract schema (ADR 0009).
import { AI_SCHEMAS } from '@shelf/contracts';
import type { JobName } from './provider';

const DROP = new Set(['$schema', '$id', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'multipleOf', 'pattern']);

function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (!DROP.has(k)) out[k] = k === 'properties' ? Object.fromEntries(Object.entries(x as object).map(([p, s]) => [p, strip(s)])) : strip(x);
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

export function wireSchema(job: JobName): Record<string, unknown> {
  return strip(AI_SCHEMAS[job]) as Record<string, unknown>;
}
