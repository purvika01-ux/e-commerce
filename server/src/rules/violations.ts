export interface Violation {
  rule: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  phase: 'decision' | 'presend';
  violations: Violation[];
  checkedAt: Date;
  validatorVersion: string;
}

export const VALIDATOR_VERSION = 'v1';
