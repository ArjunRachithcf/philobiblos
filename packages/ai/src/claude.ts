// Claude provider (API key). Empty until milestone M3: every job refuses.
import { NotImplementedError, type AiProvider } from './provider';

export interface ClaudeOptions { apiKey: string; model?: string }

export function createClaudeProvider(o: ClaudeOptions): AiProvider {
  const no = (job: string) => () => Promise.reject(new NotImplementedError('claude', job));
  if (!o.apiKey) throw new Error('claude: ANTHROPIC_API_KEY is not set');
  return {
    id: 'claude', model: o.model ?? 'unset', supportsVision: true,
    extractTitles: no('extractTitles'), tagBook: no('tagBook'), proposeLinks: no('proposeLinks'),
    suggestNext: no('suggestNext'), explainPick: no('explainPick'), checkRedundant: no('checkRedundant'),
  };
}
