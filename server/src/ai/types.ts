import type { Violation } from '../rules/violations';

export interface AiCandidate {
  offerId: string;
  code: string;
  name: string;
  type: string;
  terms: string; // rendered deterministically; read-only for the model
  purpose: string;
}

export interface AiRequest {
  context: Record<string, unknown>;
  candidates: AiCandidate[];
  previousViolations?: Violation[];
}

export type AiOutcome = 'ok' | 'timeout' | 'rate_limited' | 'api_error' | 'refusal' | 'malformed';

export interface AiResult {
  outcome: AiOutcome;
  /** Parsed JSON from the model. Untrusted: always re-validated by ProposalSchema and the validator. */
  output?: unknown;
  rawText?: string;
  errorCode?: string;
  model: string;
  latencyMs: number;
  usage?: { inputTokens: number; outputTokens: number };
}

/** The only capability the model has: propose. It cannot read other data, write, approve or send. */
export interface AiClient {
  readonly model: string;
  propose(request: AiRequest): Promise<AiResult>;
}
