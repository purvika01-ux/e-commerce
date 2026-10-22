import { ruleParams, type RuleSetRecord } from '../domain/rules';
import type { OfferType } from '../domain/types';
import type { Violation } from './violations';

// Commercial terms are rendered by code, so AI wording must not state any of them.
const TERM_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /\d/, what: 'a number' },
  { re: /[%₹$€£]/, what: 'a currency or percent sign' },
  { re: /\b(rs|inr|rupees?|percent|paise)\b/i, what: 'a price or percentage word' },
  { re: /(https?:\/\/|www\.|\.(com|in|net|org|me)\b|t\.me|@\w)/i, what: 'a link or handle' },
  { re: /[<>[\]{}`|\\]/, what: 'markup characters' },
  { re: /\b(promo|coupon|voucher)\s*code\b|\buse code\b/i, what: 'a code' },
  { re: /\b(today only|tonight only|ends (today|tonight|tomorrow|soon)|expires? (today|tonight|tomorrow))\b/i, what: 'a deadline' },
];

const MISREPRESENTATION: { re: RegExp; allowedFor: OfferType[]; what: string }[] = [
  { re: /\bfree (shipping|delivery)\b/i, allowedFor: ['free_shipping'], what: 'free shipping' },
  { re: /\b(bonus|extra|reward) points?\b/i, allowedFor: ['bonus_points'], what: 'bonus points' },
  { re: /\b(half (off|price)|bogo|buy one get one|free gift|cashback)\b/i, allowedFor: [], what: 'a benefit this offer does not include' },
];

const HARD_MAX_HEADLINE = 120;
const HARD_MAX_BODY = 600;

/** Checks AI (or template) wording. Always-on checks run even if COPY_POLICY is disabled. */
export function checkCopy(headline: string | null | undefined, body: string | null | undefined, offerType: OfferType, ruleSet: RuleSetRecord): Violation[] {
  const v: Violation[] = [];
  const h = (headline ?? '').trim();
  const b = (body ?? '').trim();
  if (!h || !b) v.push({ rule: 'COPY_REQUIRED', message: 'Headline and body are both required' });
  const policy = ruleParams(ruleSet, 'COPY_POLICY');
  const maxH = Math.min(policy?.maxHeadline ?? HARD_MAX_HEADLINE, HARD_MAX_HEADLINE);
  const maxB = Math.min(policy?.maxBody ?? HARD_MAX_BODY, HARD_MAX_BODY);
  if (h.length > maxH) v.push({ rule: 'COPY_POLICY', message: `Headline is ${h.length} characters (max ${maxH})` });
  if (b.length > maxB) v.push({ rule: 'COPY_POLICY', message: `Body is ${b.length} characters (max ${maxB})` });
  const text = `${h}\n${b}`;
  const normalised = text.toLowerCase().replace(/\s+/g, ' ');
  for (const phrase of policy?.bannedPhrases ?? []) {
    if (normalised.includes(phrase.toLowerCase().replace(/\s+/g, ' '))) v.push({ rule: 'COPY_POLICY', message: `Uses banned phrase "${phrase}"` });
  }
  for (const p of TERM_PATTERNS) {
    if (p.re.test(text)) v.push({ rule: 'COPY_CONTAINS_TERMS', message: `Wording contains ${p.what}; terms are added automatically` });
  }
  for (const m of MISREPRESENTATION) {
    if (m.re.test(text) && !m.allowedFor.includes(offerType)) v.push({ rule: 'COPY_MISREPRESENTS_OFFER', message: `Wording promises ${m.what}` });
  }
  return v;
}
