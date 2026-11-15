// Ollama provider (local). Empty until milestone M3: every job refuses.
import { NotImplementedError, type AiProvider } from './provider';

export interface OllamaOptions { url: string; model?: string; visionModel?: string }

export function createOllamaProvider(o: OllamaOptions): AiProvider {
  const no = (job: string) => () => Promise.reject(new NotImplementedError('ollama', job));
  if (!o.url) throw new Error('ollama: OLLAMA_URL is not set');
  return {
    id: 'ollama', model: o.model ?? 'unset', supportsVision: Boolean(o.visionModel),
    extractTitles: no('extractTitles'), tagBook: no('tagBook'), proposeLinks: no('proposeLinks'),
    suggestNext: no('suggestNext'), explainPick: no('explainPick'), checkRedundant: no('checkRedundant'),
  };
}
