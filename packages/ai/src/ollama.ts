// Ollama (local, the default provider): POST /api/chat on the household's own Ollama (OLLAMA_URL), one request per
// call, never streamed, the answer held to the job's schema by Ollama's structured output (`format`). Nothing leaves the
// home network. No tools are ever offered.
import { ModelError, parseAnswer, type Model, type ModelRequest, type Transport } from './provider';

export interface OllamaOptions {
  url: string;
  /** The text model (e.g. a Gemma or Llama). */
  model: string;
  /** A vision model for shared images; without one, extractTitles reads captions only. */
  visionModel?: string | null;
  transport: Transport;
}

export function createOllamaModel(o: OllamaOptions): Model {
  if (!o.url) throw new Error('ollama: OLLAMA_URL is not set');
  if (!o.model) throw new Error('ollama: no text model is set');
  const base = new URL(o.url);
  return {
    provider: 'ollama', model: o.model, supportsVision: Boolean(o.visionModel),
    async complete(r: ModelRequest) {
      const model = r.images.length && o.visionModel ? o.visionModel : o.model;
      const body = {
        model, stream: false, format: r.schema,
        options: { temperature: 0, num_predict: r.maxTokens },
        messages: [
          { role: 'system', content: r.system },
          { role: 'user', content: r.user, ...(r.images.length && o.visionModel ? { images: r.images.map((i) => i.base64) } : {}) },
        ],
      };
      let raw: Buffer;
      try {
        raw = await o.transport(new URL('/api/chat', base).toString(), Buffer.from(JSON.stringify(body)), { headers: {}, timeoutMs: r.timeoutMs });
      } catch (e) { throw new ModelError('transport', `ollama: ${e instanceof Error ? e.message : 'request failed'}`); }
      const a = parseAnswer(raw, 'ollama');
      const msg = a.message as { content?: unknown } | undefined;
      if (typeof msg?.content !== 'string') throw new ModelError('bad_answer', 'ollama answered without a message');
      if (a.done_reason === 'length') throw new ModelError('truncated', 'ollama stopped at the token limit');
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
      return { text: msg.content, model: typeof a.model === 'string' ? a.model.slice(0, 100) : model, inputTokens: n(a.prompt_eval_count), outputTokens: n(a.eval_count), costCents: 0 };
    },
  };
}
