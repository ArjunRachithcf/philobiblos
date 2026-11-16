// AI plugin contract (contracts/ai-plugin.md): the job output schemas, their types and validators.
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import extractTitlesSchema from '../../../contracts/ai/extract_titles.schema.json' with { type: 'json' };
import tagBookSchema from '../../../contracts/ai/tag_book.schema.json' with { type: 'json' };
import proposeLinksSchema from '../../../contracts/ai/propose_links.schema.json' with { type: 'json' };
import suggestNextSchema from '../../../contracts/ai/suggest_next.schema.json' with { type: 'json' };
import explainPickSchema from '../../../contracts/ai/explain_pick.schema.json' with { type: 'json' };
import checkRedundantSchema from '../../../contracts/ai/check_redundant.schema.json' with { type: 'json' };
import type { CheckRedundantOut, ExplainPickOut, ExtractTitlesOut, ProposeLinksOut, SuggestNextOut, TagBookOut } from './ai.gen';
import type { components } from './openapi.gen';

export type { CheckRedundantOut, ExplainPickOut, ExtractTitlesOut, ProposeLinksOut, SuggestNextOut, TagBookOut } from './ai.gen';

export const AI_SCHEMAS = {
  extractTitles: extractTitlesSchema,
  tagBook: tagBookSchema,
  proposeLinks: proposeLinksSchema,
  suggestNext: suggestNextSchema,
  explainPick: explainPickSchema,
  checkRedundant: checkRedundantSchema,
} as const;

/** Every job's output has a JSON schema in contracts/ai/. */
export type SchemaJob = keyof typeof AI_SCHEMAS;
export interface JobOutputs {
  extractTitles: ExtractTitlesOut;
  tagBook: TagBookOut;
  proposeLinks: ProposeLinksOut;
  suggestNext: SuggestNextOut;
  explainPick: ExplainPickOut;
  checkRedundant: CheckRedundantOut;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validators = Object.fromEntries(
  Object.entries(AI_SCHEMAS).map(([job, schema]) => [job, ajv.compile(schema)]),
) as Record<SchemaJob, ValidateFunction>;

export interface Validation { ok: boolean; errors: string[] }

/** Check a provider's output against `contracts/ai/<job>.schema.json`. */
export function validateAiOutput(job: SchemaJob, output: unknown): Validation {
  const v = validators[job];
  const ok = v(output) === true;
  return { ok, errors: ok ? [] : (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`) };
}

// Inputs of the jobs. contracts/ai-plugin.md names these types without defining them; these are the
// smallest shapes the interface needs, to settle when the providers are built (M3).
export type Move = components['schemas']['Move'];
export type Layer = 'intro' | 'core' | 'deep' | 'counterpoint';
export type BookRef = components['schemas']['BookRef'];

export interface Image {
  /** Path under PHILOBIBLOS_DATA_DIR, or a data: URL in tests. */
  path: string;
  mimeType: string;
  /** Video frames: the offset in the video, in seconds. */
  atSeconds?: number;
}

export interface IdeaTag { name: string; layer: Layer; confidence: number }

export interface BrainSummary {
  ideas: { name: string; readCount: number; layersFilled: Layer[]; gaps: Layer[] }[];
}
