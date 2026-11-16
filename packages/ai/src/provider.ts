// The AI plugin interface (contracts/ai-plugin.md). The AI proposes; packages/scoring decides (ADR 0004).
//
// Two layers: `AiProvider` is the typed interface of the contract (one method per job); `Model` is what a provider
// really is underneath, one call that takes a prompt and answers text. The server's runner (apps/server/src/ai/run.ts)
// turns a Model into an AiProvider: it builds the prompt (src/prompt.ts), keeps the cache and the log (ai_run),
// validates and retries. A Model never opens a connection itself: it is handed a Transport, the server's egress client.
import type {
  BookRef, BrainSummary, CheckRedundantOut, ExplainPickOut, ExtractTitlesOut, IdeaTag, Image, Move, ProposeLinksOut, SuggestNextOut, TagBookOut,
} from '@philobiblos/contracts';

export type ProviderId = 'claude' | 'ollama' | 'fake';

export interface ExtractTitlesIn { images: Image[]; caption?: string; url?: string }
export interface TagBookIn { book: BookRef; blurb?: string; ideaVocabulary: string[]; kidsThemes: string[] }
export interface ProposeLinksIn {
  candidate: BookRef & { ideas: IdeaTag[] };
  readBooks: (BookRef & { ideas: IdeaTag[]; takeaway?: string })[];
}
export interface SuggestNextIn { brain: BrainSummary; backlogTitles: string[]; owned: string[]; wildcards: boolean; max: number }
export interface ExplainPickIn { pick: BookRef; move: Move; buildsOn: string[]; idea: string }
export interface CheckRedundantIn { candidate: BookRef; owned: BookRef[] }

export interface JobIO {
  extractTitles: [ExtractTitlesIn, ExtractTitlesOut];
  tagBook: [TagBookIn, TagBookOut];
  proposeLinks: [ProposeLinksIn, ProposeLinksOut];
  suggestNext: [SuggestNextIn, SuggestNextOut];
  explainPick: [ExplainPickIn, ExplainPickOut];
  checkRedundant: [CheckRedundantIn, CheckRedundantOut];
}
export type JobName = keyof JobIO;
export const JOB_NAMES: JobName[] = ['extractTitles', 'tagBook', 'proposeLinks', 'suggestNext', 'explainPick', 'checkRedundant'];

export interface AiProvider {
  id: ProviderId;
  model: string;
  supportsVision: boolean;
  extractTitles(i: ExtractTitlesIn): Promise<ExtractTitlesOut>;
  tagBook(i: TagBookIn): Promise<TagBookOut>;
  proposeLinks(i: ProposeLinksIn): Promise<ProposeLinksOut>;
  suggestNext(i: SuggestNextIn): Promise<SuggestNextOut>;
  /** ≤ 140 characters. */
  explainPick(i: ExplainPickIn): Promise<{ why: string }>;
  checkRedundant(i: CheckRedundantIn): Promise<{ repeats?: string; reason?: string }>;
}

export const EXPLAIN_MAX = 140;

/** An image as a model receives it: always a JPEG the media worker re-encoded, base64. */
export interface ModelImage { mimeType: 'image/jpeg'; base64: string }

export interface ModelRequest {
  job: JobName;
  /** The job's prompt file (prompts/<job>.v<N>.md). */
  system: string;
  /** The input, built by src/prompt.ts. */
  user: string;
  images: ModelImage[];
  /** The job's output schema, as the provider's structured output takes it (src/wire.ts). */
  schema: Record<string, unknown>;
  maxTokens: number;
  timeoutMs: number;
}

export interface ModelReply {
  text: string;
  /** The model that answered (a provider may name the exact one). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** US cents, estimated from the token counts; 0 for a local model. */
  costCents: number;
}

export interface Model {
  provider: ProviderId;
  model: string;
  supportsVision: boolean;
  complete(r: ModelRequest): Promise<ModelReply>;
}

/** Why a call gave no usable answer. Messages are Philobiblos's own words: never a key, a prompt or the provider's body. */
export class ModelError extends Error {
  constructor(readonly reason: 'transport' | 'refused' | 'truncated' | 'bad_answer', message: string) {
    super(message);
    this.name = 'ModelError';
  }
}

/**
 * How a Model reaches its provider: the server's egress client (apps/server/src/net/egress.ts), held to its allowlist.
 * Resolves with a 2xx JSON answer's body; throws for anything else.
 */
export type Transport = (url: string, body: Buffer, o: { headers: Record<string, string>; timeoutMs: number }) => Promise<Buffer>;

/** The answer's JSON, or a ModelError: never the body itself in the message. */
export function parseAnswer(body: Buffer, provider: string): Record<string, unknown> {
  let o: unknown;
  try { o = JSON.parse(body.toString('utf8')); } catch { throw new ModelError('bad_answer', `${provider} answered something that is not JSON`); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new ModelError('bad_answer', `${provider} answered something that is not an object`);
  return o as Record<string, unknown>;
}
