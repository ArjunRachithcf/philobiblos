// Claude (an explicit opt-in, contracts/ai-plugin.md): the Messages API at api.anthropic.com, over the server's egress
// client (ADR 0009: one HTTP client, Claude's host on its allowlist only after the opt-in), so not the SDK, which would
// open its own connections. One request per call, the answer held to the job's schema by structured output
// (`output_config.format`), adaptive thinking at low effort. No tools are ever offered. The key goes in its header and
// nowhere else: never in a message, a log or an error.
import { ModelError, parseAnswer, type Model, type ModelRequest, type Transport } from './provider';

export const CLAUDE_HOST = 'api.anthropic.com';
export const CLAUDE_DEFAULT_MODEL = 'claude-opus-5-5';
export const ANTHROPIC_VERSION = '2026-10-21';
/** US dollars per million tokens (input, output) of the default model; other models are estimated the same. */
const PRICE = { input: 4, output: 20 };

export interface ClaudeOptions { apiKey: string; model?: string | null; transport: Transport }

/** A model id as Anthropic names them (`claude-…`): anything else is refused before it reaches a header or a body. */
export const CLAUDE_MODEL = /^claude-[a-z0-9.-]{1,60}$/;

export function createClaudeModel(o: ClaudeOptions): Model {
  if (!o.apiKey) throw new Error('claude: no API key');
  const model = o.model || CLAUDE_DEFAULT_MODEL;
  if (!CLAUDE_MODEL.test(model)) throw new Error('claude: not a model id');
  return {
    provider: 'claude', model, supportsVision: true,
    async complete(r: ModelRequest) {
      const body = {
        model, max_tokens: r.maxTokens,
        system: r.system,
        // Thinking cannot be turned off on this model; low effort keeps these small jobs small.
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low', format: { type: 'json_schema', schema: r.schema } },
        messages: [{
          role: 'user',
          content: [
            ...r.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.base64 } })),
            { type: 'text', text: r.user },
          ],
        }],
      };
      let raw: Buffer;
      try {
        raw = await o.transport(`https://${CLAUDE_HOST}/v1/messages`, Buffer.from(JSON.stringify(body)), {
          headers: { 'x-api-key': o.apiKey, 'anthropic-version': ANTHROPIC_VERSION }, timeoutMs: r.timeoutMs,
        });
      } catch (e) { throw new ModelError('transport', `claude: ${e instanceof Error ? e.message : 'request failed'}`); }
      const a = parseAnswer(raw, 'claude');
      if (a.stop_reason === 'refusal') throw new ModelError('refused', 'claude declined the request');
      if (a.stop_reason === 'max_tokens') throw new ModelError('truncated', 'claude stopped at the token limit');
      const blocks = Array.isArray(a.content) ? (a.content as { type?: unknown; text?: unknown }[]) : [];
      // Text blocks only: anything else (a tool call it was never offered, say) is not an answer.
      if (blocks.some((b) => b?.type === 'tool_use' || b?.type === 'server_tool_use')) throw new ModelError('bad_answer', 'claude answered with a tool call');
      const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('');
      if (!text) throw new ModelError('bad_answer', 'claude answered without text');
      const u = (a.usage ?? {}) as Record<string, unknown>;
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
      const inputTokens = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
      const outputTokens = n(u.output_tokens);
      const served = typeof a.model === 'string' && CLAUDE_MODEL.test(a.model) ? a.model : model;
      return { text, model: served, inputTokens, outputTokens, costCents: Math.ceil(((inputTokens * PRICE.input + outputTokens * PRICE.output) / 1e6) * 100) };
    },
  };
}
