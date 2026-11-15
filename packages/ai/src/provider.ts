// The AI plugin interface (contracts/ai-plugin.md). The AI proposes; packages/scoring decides (ADR 0004).
import type {
  BookRef, BrainSummary, ExtractTitlesOut, IdeaTag, Image, Move, ProposeLinksOut, SuggestNextOut, TagBookOut,
} from '@shelf/contracts';

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

export class NotImplementedError extends Error {
  constructor(provider: ProviderId, job: string) {
    super(`${provider}: ${job} is not implemented yet (milestone M3)`);
    this.name = 'NotImplementedError';
  }
}
