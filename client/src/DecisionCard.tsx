import { CheckCircle2, Gift, ShieldCheck, Ticket, XCircle } from 'lucide-react';
import { motion } from 'motion/react';
import { when, type DecisionSummary } from './api';
import { Badge, PathBadge, StatusBadge } from './ui';

const AI_OUTCOME: Record<string, string> = {
  ok: 'answered',
  no_offer: 'chose no offer',
  validation_failed: 'proposal rejected by validator',
  schema_invalid: 'invalid response format',
  malformed: 'unreadable response',
  timeout: 'timed out',
  rate_limited: 'rate limited',
  api_error: 'API error',
  refusal: 'declined to answer',
};

const REASON: Record<string, string> = {
  NO_ELIGIBLE_OFFERS: 'No offer passes the business rules for this customer.',
  AI_CHOSE_NO_OFFER: 'Claude decided this customer does not need an offer.',
  NO_CANDIDATE_PASSED_VALIDATION: 'Every candidate failed independent validation, so nothing was approved.',
  AI_UNAVAILABLE_OR_REJECTED: 'Claude was unavailable or its proposal failed validation; the rule-based fallback was used and validated.',
  AI_DISABLED: 'Claude is not configured; the rule-based fallback was used and validated.',
  PRESEND_CHECK_FAILED: 'A pre-send recheck failed, so the offer was cancelled and never sent.',
};

/** Shows one decision: outcome, validation, the AI-vs-fallback path, and the message with its terms. */
export function DecisionCard({ d, delivery }: { d: DecisionSummary; delivery?: { status: string; failureReason?: string | null } | null }) {
  const ok = d.lastValidation?.ok;
  return (
    <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={d.status} />
        <PathBadge path={d.path} />
        {delivery && (
          <Badge tone={delivery.status === 'sent' ? 'green' : 'red'}>
            Telegram: {delivery.status.replace(/_/g, ' ')}
            {delivery.failureReason ? ` (${delivery.failureReason})` : ''}
          </Badge>
        )}
        <span className="text-xs text-ink-500">{when(d.decidedAt)}</span>
      </div>

      {d.outcomeReason && REASON[d.outcomeReason] && <p className="text-sm text-ink-700">{REASON[d.outcomeReason]}</p>}

      {d.offer && d.copy && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl bg-[#e7f0f7] p-3">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">Telegram message preview</p>
            <div className="rounded-2xl rounded-tl-sm bg-white p-3 text-sm shadow-sm">
              <p className="font-semibold">🎁 {d.copy.headline}</p>
              <p className="mt-1 text-ink-700">{d.copy.body}</p>
              <div className="mt-3 space-y-0.5 border-t border-slate-100 pt-2 text-[13px]">
                <p className="font-semibold">💸 {d.offer.terms.split(' — ')[0]}</p>
                <p>🛒 {d.offer.terms.split(' — ')[1]}</p>
                {d.grant && <p>⏳ Valid until {when(d.grant.expiresAt)}</p>}
                {d.grant && (
                  <p>
                    🔑 Code: <code className="rounded bg-slate-100 px-1">{d.grant.code}</code>
                  </p>
                )}
              </div>
            </div>
          </div>
          <div className="space-y-3 text-sm">
            <div className="flex items-start gap-2">
              <Gift size={16} className="mt-0.5 text-brand-600" />
              <div>
                <p className="font-medium">
                  {d.offer.name} <span className="text-ink-500">({d.offer.code})</span>
                </p>
                <p className="text-ink-500">Terms come from the offer definition, not from the AI wording.</p>
              </div>
            </div>
            {d.grant && (
              <div className="flex items-center gap-2 text-ink-700">
                <Ticket size={16} className="text-brand-600" /> Grant {d.grant.code} · {d.grant.status}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-slate-200 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
            <ShieldCheck size={14} /> Independent validation
          </p>
          {!d.lastValidation ? (
            <p className="text-sm text-ink-500">Not reached — {d.candidatesCount === 0 ? 'no eligible candidates' : 'no proposal to check'}.</p>
          ) : ok ? (
            <p className="flex items-center gap-1.5 text-sm text-emerald-700">
              <CheckCircle2 size={16} /> All business rules passed ({d.lastValidation.source} check)
            </p>
          ) : (
            <ul className="space-y-1 text-sm text-rose-700">
              {d.lastValidation.violations.map((v, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <XCircle size={14} className="mt-0.5 shrink-0" />
                  <span>
                    <span className="font-medium">{v.rule}</span> — {v.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-xl border border-slate-200 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">AI attempts</p>
          {d.aiAttempts.length === 0 ? (
            <p className="text-sm text-ink-500">Claude was not called{d.candidatesCount === 0 ? ' (nothing eligible)' : ''}.</p>
          ) : (
            <ol className="space-y-1 text-sm">
              {d.aiAttempts.map((a) => (
                <li key={a.n} className="flex justify-between gap-2">
                  <span>
                    #{a.n} {AI_OUTCOME[a.outcome] ?? a.outcome}
                  </span>
                  <span className="text-ink-500">{a.latencyMs} ms</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </motion.div>
  );
}
