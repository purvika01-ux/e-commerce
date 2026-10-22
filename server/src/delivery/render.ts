import type { OfferSnapshot } from '../domain/types';
import { formatIst, termsConditions, termsHeadline } from '../rules/terms';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Telegram message (HTML parse mode). The AI/template wording is escaped; the terms block is
 * generated only from the approved offer snapshot, so wording can never change what is promised.
 */
export function renderOfferMessage(input: {
  headline: string;
  body: string;
  snapshot: OfferSnapshot;
  grantCode: string;
  expiresAt: Date;
}): string {
  const { snapshot: s } = input;
  return [
    `🎁 <b>${escapeHtml(input.headline)}</b>`,
    escapeHtml(input.body),
    '',
    `💸 <b>${escapeHtml(termsHeadline(s.type, s.terms))}</b>`,
    `🛒 ${escapeHtml(termsConditions(s.terms))}`,
    `⏳ Valid until ${escapeHtml(formatIst(input.expiresAt))} IST`,
    `🔑 Code: <code>${escapeHtml(input.grantCode)}</code>`,
    '',
    '<i>Demo offer from Offerly AI · synthetic shopper profile</i>',
  ].join('\n');
}
