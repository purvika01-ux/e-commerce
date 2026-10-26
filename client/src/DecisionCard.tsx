import { CheckCircle2, Gift, ShieldCheck, Sparkles, Ticket, XCircle } from 'lucide-react';
import { motion } from 'motion/react';
import { when, type DecisionSummary } from './api';
import { Badge, PathBadge, StatusBadge } from './ui';

export const AI_OUTCOME: Record<string, string> = {
  ok: 'answered',
  no_offer: 'chose no offer',
  validation_failed: 'proposal rejected by the validator',
  schema_invalid: 'invalid response format',
  malformed: 'unreadable response',
  timeout: 'timed out',
  rate_limited: 'rate limited',
  api_error: 'API error',
  refusal: 'declined to answer',
};

export const REASON: Record<string, string> = {
  NO_ELIGIBLE_OFFERS: 'No offer passes the business rules for this customer.',
  AI_CHOSE_NO_OFFER: 'Claude decided this customer does not need an offer.',
  NO_CANDIDATE_PASSED_VALIDATION: 'Every candidate failed independent validation, so nothing was approved.',
  AI_UNAVAILABLE_OR_REJECTED: 'Claude was unavailable or its proposal failed validation, so the deterministic rule-based choice was used — and validated the same way.',
  AI_DISABLED: 'Claude is not configured, so the deterministic rule-based choice was used — and validated the same way.',
  PRESEND_CHECK_FAILED: 'A final check just before sending failed, so the offer was cancelled and never sent.',
  DELIVERY_INTERRUPTED: 'Delivery was interrupted; the offer was voided rather than risk a duplicate message.',
};

/** One decision: outcome, the AI-vs-fallback path, the exact message (AI wording + terms from the offer), and validation. */
export function DecisionCard({ d, delivery }: { d: DecisionSummary; delivery?: { status: string; failureReason?: string | null } | null }) {
  const ok = d.lastValidation?.ok;
  const [termsHeadline, termsConditions] = (d.offer?.terms ?? '').split(' — ');
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={d.status} />
        <PathBadge path={d.path} />
        {delivery && (
          <Badge tone={delivery.status === 'sent' ? 'good' : 'bad'}>
            Telegram: {delivery.status.replace(/_/g, ' ')}
            {delivery.failureReason ? ` (${delivery.failureReason})` : ''}
          </Badge>
        )}
        <span className="text-[0.78rem] text-ink-3">{when(d.decidedAt)}</span>
      </div>

      {d.outcomeReason && REASON[d.outcomeReason] && <p className="text-sm leading-relaxed text-ink-2">{REASON[d.outcomeReason]}</p>}

      {d.offer && d.copy && (
        <div className="grid gap-5 md:grid-cols-[1.1fr_1fr]">
          <div className="rounded-2xl border border-line bg-[#0e1a2b] p-4">
            <p className="mb-2.5 text-[0.7rem] font-medium tracking-wider text-ink-3 uppercase">Telegram message</p>
            <div className="rounded-2xl rounded-tl-md bg-[#1c2c44] p-3.5 text-[0.85rem] leading-relaxed text-ink shadow-sm">
              <p className="font-semibold">🎁 {d.copy.headline}</p>
              <p className="mt-1 text-ink-2">{d.copy.body}</p>
              <div className="mt-3 space-y-0.5 border-t border-line pt-2.5 text-[0.82rem]">
                <p className="font-semibold">💸 {termsHeadline}</p>
                <p className="text-ink-2">🛒 {termsConditions}</p>
                {d.grant && <p className="text-ink-2">⏳ Valid until {when(d.grant.expiresAt)}</p>}
                {d.grant && (
                  <p className="text-ink-2">
                    🔑 Code: <code className="rounded bg-[#0b1424] px-1 font-mono text-accent-strong">{d.grant.code}</code>
                  </p>
                )}
              </div>
            </div>
            <div className="mt-2.5 flex gap-2 text-[0.75rem] text-ink-3">
              <span className="flex items-center gap-1">
                <Sparkles size={12} className="text-ai" aria-hidden /> wording
              </span>
              <span>·</span>
              <span className="flex items-center gap-1">
                <Gift size={12} className="text-accent" aria-hidden /> terms from the offer definition
              </span>
            </div>
          </div>
          <div className="space-y-3 text-sm">
            <div>
              <p className="text-[0.7rem] font-medium tracking-wider text-ink-3 uppercase">Offer</p>
              <p className="mt-1 font-medium text-ink">
                {d.offer.name} <span className="font-mono text-[0.78rem] text-ink-3">{d.offer.code}</span>
              </p>
              <p className="text-ink-3">{d.offer.terms}</p>
            </div>
            {d.grant && (
              <div className="flex items-center gap-2 text-ink-2">
                <Ticket size={15} className="text-accent" aria-hidden /> Grant <span className="font-mono">{d.grant.code}</span> · {d.grant.status}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface-2/60 p-3.5">
          <p className="mb-2 flex items-center gap-1.5 text-[0.7rem] font-medium tracking-wider text-ink-3 uppercase">
            <ShieldCheck size={13} aria-hidden /> Independent validation
          </p>
          {!d.lastValidation ? (
            <p className="text-sm text-ink-3">Not reached — {d.candidatesCount === 0 ? 'no offer was eligible' : 'no proposal to check'}.</p>
          ) : ok ? (
            <p className="flex items-center gap-1.5 text-sm text-good-ink">
              <CheckCircle2 size={16} aria-hidden /> All business rules passed ({d.lastValidation.source} check)
            </p>
          ) : (
            <ul className="space-y-1 text-sm text-bad-ink">
              {d.lastValidation.violations.map((v, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <XCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
                  <span>
                    <span className="font-medium">{v.rule}</span> — {v.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-xl border border-line bg-surface-2/60 p-3.5">
          <p className="mb-2 flex items-center gap-1.5 text-[0.7rem] font-medium tracking-wider text-ink-3 uppercase">
            <Sparkles size={13} aria-hidden /> AI attempts
          </p>
          {d.aiAttempts.length === 0 ? (
            <p className="text-sm text-ink-3">Claude was not called{d.candidatesCount === 0 ? ' (nothing was eligible)' : ''}.</p>
          ) : (
            <ol className="space-y-1 text-sm">
              {d.aiAttempts.map((a) => (
                <li key={a.n} className="flex justify-between gap-2 text-ink-2">
                  <span>
                    #{a.n} {AI_OUTCOME[a.outcome] ?? a.outcome}
                  </span>
                  <span className="tabular-nums text-ink-3">{(a.latencyMs / 1000).toFixed(1)} s</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </motion.div>
  );
}
