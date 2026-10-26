export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Fired when the session is missing or expired, so the app can show the sign-in screen. */
export const UNAUTHENTICATED_EVENT = 'offerly:unauthenticated';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      credentials: 'same-origin',
      // The custom header is the server's CSRF check for state-changing requests.
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'offerly', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the Offerly server. Is it running on port 4000?');
  }
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
    throw new ApiError(res.status, body?.error?.code ?? 'ERROR', body?.error?.message ?? `Request failed (${res.status})`, body?.error?.details);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => call<T>(path),
  post: <T>(path: string, body: unknown, headers?: Record<string, string>) => call<T>(path, { method: 'POST', body: JSON.stringify(body), headers }),
  put: <T>(path: string, body: unknown) => call<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => call<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
};

export const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
export const pct = (x: number) => `${Math.round(x * 100)}%`;
export const when = (d: string | Date | null | undefined) =>
  d ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(d)) : '—';

// ---- response types (subset of the server DTOs) ----
export interface Health {
  status: string;
  db: { status: string; latencyMs?: number };
  ai: { mode: 'live' | 'fallback_only'; model: string | null };
  telegram: { enabled: boolean; botUsername: string | null; status: string; lastError?: { kind: string; message: string } | null };
}

export interface Violation {
  rule: string;
  message: string;
}

export interface DecisionSummary {
  id: string;
  customerId: string;
  customerRef: string;
  status: 'approved' | 'no_offer' | 'rejected' | 'dry_run' | 'cancelled' | 'error' | 'pending';
  path: 'ai' | 'ai_retry' | 'fallback' | 'none';
  decidedAt: string;
  offer: { code: string; name: string; terms: string } | null;
  copy: { headline: string; body: string } | null;
  grant: { code: string; status: string; expiresAt: string } | null;
  outcomeReason: string | null;
  candidatesCount: number;
  lastValidation: { ok: boolean; violations: Violation[]; source: string } | null;
  aiAttempts: { n: number; outcome: string; errorCode: string | null; latencyMs: number }[];
}

export interface Overview {
  range: '7d' | '30d' | '90d' | 'all';
  customers: number;
  segments: { segment: string; count: number }[];
  offers: { code: string; name: string; status: string; budget: { totalPaise: number; reservedPaise: number; redeemedPaise: number }; usage: { maxGrants: number; grantsIssued: number } }[];
  budget: { totalPaise: number; committedPaise: number; availablePaise: number; liveOffers: number };
  decisions: Record<string, number>;
  paths: Record<string, number>;
  deliveries: Record<string, number>;
  engagement: Record<string, number>;
  telegramLinked: number;
  daily: { days: number; timezone: string; points: { date: string; approved: number; noOffer: number; blocked: number }[] };
  recentDecisions: DecisionSummary[];
  dataNotice: string;
}

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface CustomerRow {
  id: string;
  externalRef: string;
  displayName: string;
  segment: string;
  persona: string;
  telegramLinked: boolean;
  optedOut: boolean;
  features: Record<string, any>;
  rewardPoints: { balance: number };
}

export interface CustomerDetail {
  customer: CustomerRow & { city: string; preferredCategories: string[]; signupAt: string };
  telegram: { status: string; linkedAt: string } | null;
  stats: { approvedInWindow: number; activeGrants: unknown[] };
  eligibility: { eligible: { id: string; code: string; name: string; terms: string }[]; excluded: { offerId: string; code: string; reasons: Violation[] }[] };
  recentEvents: { type: string; occurredAt: string; payload: Record<string, any> }[];
  decisions: DecisionSummary[];
}

export type OfferType = 'percent_off' | 'flat_off' | 'free_shipping' | 'bonus_points';

export interface OfferTerms {
  percentOff?: number;
  maxDiscountPaise?: number;
  flatOffPaise?: number;
  bonusPoints?: number;
  minOrderPaise: number;
  categories?: string[];
}

export interface OfferEligibility {
  segments?: string[];
  minChurnRisk?: number;
  maxPurchaseProbability?: number;
  requiresOpenCart?: boolean;
  newCustomersOnly?: boolean;
  minRewardPoints?: number;
}

export interface OfferItem {
  id: string;
  code: string;
  name: string;
  description: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  version: number;
  type: OfferType;
  terms: OfferTerms;
  termsSummary: string;
  eligibility: OfferEligibility;
  validFrom: string;
  validTo: string;
  isExpired: boolean;
  grantValidityHours: number;
  priority: number;
  stackable: boolean;
  estimatedCostPaise: number;
  budget: { totalPaise: number; reservedPaise: number; redeemedPaise: number };
  usage: { maxGrants: number; grantsIssued: number; maxGrantsPerCustomer: number };
  remainingBudgetPaise: number;
  ruleIssues: Violation[];
}

export interface RuleItem {
  key: string;
  type: string;
  enabled: boolean;
  params: Record<string, unknown>;
  description: string;
  help: string;
}

export const SEGMENTS = ['champion', 'loyal', 'promising', 'new', 'at_risk', 'hibernating', 'price_sensitive', 'window_shopper'] as const;
export const CATEGORIES = ['electronics', 'fashion', 'grocery', 'home', 'beauty'] as const;

/** Maps a server validation error ({ path, message }[]) to a field → message record for inline errors. */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || !Array.isArray(err.details)) return {};
  const out: Record<string, string> = {};
  for (const d of err.details as { path?: string; message?: string; rule?: string }[]) {
    if (d.path && d.message && !out[d.path]) out[d.path] = d.message;
  }
  return out;
}
