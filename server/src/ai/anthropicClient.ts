import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ProposalOutputSchema } from '../domain/proposal';
import { buildUserMessage, SYSTEM_PROMPT } from './prompt';
import type { AiClient, AiRequest, AiResult } from './types';

export interface AnthropicAiOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  baseURL?: string;
}

/** Real Claude adapter. Refuses to start under NODE_ENV=test so tests can never make live calls. */
export function createAnthropicAiClient(opts: AnthropicAiOptions): AiClient {
  if (process.env.NODE_ENV === 'test') throw new Error('Live Anthropic client must not be constructed in tests');
  const client = new Anthropic({
    apiKey: opts.apiKey,
    // Explicit, so the app never inherits a base URL from the shell environment.
    baseURL: opts.baseURL ?? 'https://api.anthropic.com',
    timeout: opts.timeoutMs,
    maxRetries: 0, // the orchestrator decides: one retry for invalid output, fallback for API failures
  });

  return {
    model: opts.model,
    async propose(req: AiRequest): Promise<AiResult> {
      const started = Date.now();
      const base = { model: opts.model };
      try {
        const response = await client.messages.parse({
          model: opts.model,
          max_tokens: 8000,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildUserMessage(req) }],
          output_config: { effort: 'low', format: zodOutputFormat(ProposalOutputSchema) },
        });
        const latencyMs = Date.now() - started;
        const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
        const rawText = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .slice(0, 2000);
        if (response.stop_reason === 'refusal') return { ...base, outcome: 'refusal', latencyMs, usage, rawText };
        if (response.stop_reason === 'max_tokens' || response.parsed_output == null) {
          return { ...base, outcome: 'malformed', errorCode: `stop_reason:${response.stop_reason}`, latencyMs, usage, rawText };
        }
        return { ...base, outcome: 'ok', output: response.parsed_output, rawText, latencyMs, usage };
      } catch (err) {
        const latencyMs = Date.now() - started;
        if (err instanceof Anthropic.APIConnectionTimeoutError) return { ...base, outcome: 'timeout', errorCode: 'timeout', latencyMs };
        if (err instanceof Anthropic.RateLimitError) return { ...base, outcome: 'rate_limited', errorCode: '429', latencyMs };
        if (err instanceof Anthropic.APIConnectionError) return { ...base, outcome: 'api_error', errorCode: 'connection_error', latencyMs };
        if (err instanceof Anthropic.APIError) return { ...base, outcome: 'api_error', errorCode: String(err.status ?? 'api_error'), latencyMs };
        // JSON / schema parse failures raised by the SDK's parse helper.
        return { ...base, outcome: 'malformed', errorCode: 'parse_error', latencyMs };
      }
    },
  };
}
