import { CATEGORIES, type Category, type CustomerFeatures, type Persona, type Segment } from '../domain/types';
import { buildFeatures, deriveSegment, type EventLike } from '../features/build';
import { createRng, type Rng } from './rng';

const DAY = 86_400_000;

interface PersonaProfile {
  weight: number;
  ordersPerMonth: number;
  basketMultiplier: number;
  inactiveForDays: [number, number]; // how long ago the customer was last active
  tenureDays: [number, number];
  abandonRate: number;
  returnRate: number;
  discountAffinity: number;
  browsePerVisit: [number, number];
  extraBrowsingSessions: number; // per month, without buying
  openCartChance: number;
}

/** Latent behaviour per persona. Personas are ground truth for evaluation and never shown to the AI. */
export const PERSONA_PROFILES: Record<Persona, PersonaProfile> = {
  loyal_high_value: { weight: 10, ordersPerMonth: 2.4, basketMultiplier: 1.9, inactiveForDays: [0, 6], tenureDays: [240, 900], abandonRate: 0.45, returnRate: 0.05, discountAffinity: 0.12, browsePerVisit: [2, 6], extraBrowsingSessions: 2, openCartChance: 0.1 },
  deal_seeker: { weight: 15, ordersPerMonth: 1.1, basketMultiplier: 0.75, inactiveForDays: [0, 18], tenureDays: [90, 700], abandonRate: 0.68, returnRate: 0.09, discountAffinity: 0.75, browsePerVisit: [5, 14], extraBrowsingSessions: 4, openCartChance: 0.25 },
  new_customer: { weight: 12, ordersPerMonth: 0.9, basketMultiplier: 0.9, inactiveForDays: [0, 5], tenureDays: [2, 26], abandonRate: 0.6, returnRate: 0.04, discountAffinity: 0.3, browsePerVisit: [4, 10], extraBrowsingSessions: 3, openCartChance: 0.3 },
  at_risk: { weight: 15, ordersPerMonth: 1.3, basketMultiplier: 1.1, inactiveForDays: [30, 60], tenureDays: [220, 900], abandonRate: 0.6, returnRate: 0.1, discountAffinity: 0.35, browsePerVisit: [3, 8], extraBrowsingSessions: 1, openCartChance: 0.05 },
  dormant: { weight: 10, ordersPerMonth: 0.7, basketMultiplier: 1.0, inactiveForDays: [100, 160], tenureDays: [300, 1000], abandonRate: 0.6, returnRate: 0.1, discountAffinity: 0.3, browsePerVisit: [3, 7], extraBrowsingSessions: 0.5, openCartChance: 0 },
  cart_abandoner: { weight: 15, ordersPerMonth: 0.6, basketMultiplier: 1.25, inactiveForDays: [0, 2], tenureDays: [60, 800], abandonRate: 0.85, returnRate: 0.07, discountAffinity: 0.5, browsePerVisit: [5, 12], extraBrowsingSessions: 3, openCartChance: 0.95 },
  window_shopper: { weight: 13, ordersPerMonth: 0.12, basketMultiplier: 0.9, inactiveForDays: [0, 9], tenureDays: [60, 800], abandonRate: 0.9, returnRate: 0.05, discountAffinity: 0.4, browsePerVisit: [8, 20], extraBrowsingSessions: 6, openCartChance: 0.3 },
  occasional: { weight: 10, ordersPerMonth: 0.45, basketMultiplier: 1.0, inactiveForDays: [6, 40], tenureDays: [120, 900], abandonRate: 0.6, returnRate: 0.12, discountAffinity: 0.3, browsePerVisit: [3, 8], extraBrowsingSessions: 1, openCartChance: 0.08 },
};

/** Median item prices in paise; order values are log-normal around these. */
const CATEGORY_MEDIAN_PAISE: Record<Category, number> = {
  electronics: 650_000,
  fashion: 120_000,
  grocery: 45_000,
  home: 210_000,
  beauty: 60_000,
};

const FIRST = ['Aarav', 'Simran', 'Harpreet', 'Ishaan', 'Navneet', 'Kavya', 'Jaskaran', 'Ananya', 'Gurleen', 'Rohan', 'Mehak', 'Arjun', 'Prabhjot', 'Diya', 'Kabir', 'Tanvi', 'Manveer', 'Riya', 'Sahil', 'Noor', 'Vikram', 'Aditi', 'Karan', 'Pooja'];
const LAST = ['Sandhu', 'Sharma', 'Gill', 'Verma', 'Dhillon', 'Kapoor', 'Grewal', 'Mehta', 'Bains', 'Arora', 'Sidhu', 'Malhotra', 'Brar', 'Chopra', 'Randhawa', 'Bhatia'];
const CITIES = ['Ludhiana', 'Amritsar', 'Jalandhar', 'Patiala', 'Mohali', 'Bathinda', 'Chandigarh', 'Delhi', 'Gurugram', 'Jaipur', 'Pune', 'Bengaluru'];
const AGE_BANDS = ['18-24', '25-34', '35-44', '45-54', '55+'];

export interface GeneratedCustomer {
  externalRef: string;
  displayName: string;
  persona: Persona;
  city: string;
  ageBand: string;
  signupAt: Date;
  preferredCategories: Category[];
  rewardPoints: { balance: number; expiringPoints: number; expiresAt: Date | null };
  features: CustomerFeatures;
  segment: Segment;
  events: EventLike[];
}

/** Festive spike (Diwali season, mid-Oct to mid-Nov) and weekend lift make timing look real. */
function seasonality(d: Date): number {
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const festive = (m === 9 && day >= 15) || (m === 10 && day <= 15) ? 1.6 : 1;
  const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6 ? 1.25 : 1;
  return festive * weekend;
}

function eveningTime(rng: Rng, dayStart: number): Date {
  // Most shopping happens 12:00–23:00 IST (06:30–17:30 UTC); bias toward the evening.
  const hourUtc = rng.bool(0.6) ? rng.int(12, 17) : rng.int(4, 12);
  return new Date(dayStart + hourUtc * 3_600_000 + rng.int(0, 59) * 60_000);
}

function generateCustomer(rng: Rng, index: number, persona: Persona, now: Date): GeneratedCustomer {
  const p = PERSONA_PROFILES[persona];
  const tenure = rng.int(p.tenureDays[0], p.tenureDays[1]);
  const signupAt = new Date(now.getTime() - tenure * DAY - rng.int(0, 86_399) * 1000);
  const inactiveFor = rng.int(p.inactiveForDays[0], p.inactiveForDays[1]);
  const activeUntil = now.getTime() - inactiveFor * DAY;
  const historyStart = Math.max(signupAt.getTime(), now.getTime() - 180 * DAY);

  const prefCount = rng.int(1, 3);
  const preferred: Category[] = [];
  while (preferred.length < prefCount) {
    const c = rng.weighted(CATEGORIES.map((value) => ({ value, weight: value === 'fashion' || value === 'grocery' ? 3 : 2 })));
    if (!preferred.includes(c)) preferred.push(c);
  }
  // A small share of customers are serial returners regardless of persona.
  const returnRate = persona !== 'new_customer' && rng.bool(0.06) ? 0.45 : p.returnRate;

  const events: EventLike[] = [];
  let cartSeq = 0;
  let orderSeq = 0;
  let points = 0;
  const pickCategory = () => (rng.bool(0.72) ? rng.pick(preferred) : rng.pick(CATEGORIES));
  const itemPrice = (cat: Category) => Math.max(9_900, Math.round(rng.logNormal(CATEGORY_MEDIAN_PAISE[cat] * p.basketMultiplier, 0.55) / 100) * 100);

  const visit = (dayStart: number, buys: boolean) => {
    const t0 = eveningTime(rng, dayStart);
    let t = t0.getTime();
    const step = () => (t += rng.int(30, 400) * 1000);
    const sessionId = `s-${index}-${events.length}`;
    events.push({ type: 'session_start', occurredAt: new Date(t), payload: { sessionId } });
    const views = rng.int(p.browsePerVisit[0], p.browsePerVisit[1]);
    for (let i = 0; i < views; i++) {
      const category = pickCategory();
      events.push({ type: 'product_view', occurredAt: new Date(step()), payload: { sessionId, category, sku: `${category.slice(0, 3).toUpperCase()}-${rng.int(1, 400)}` } });
    }
    const willCart = buys || rng.bool(0.35);
    if (!willCart) return;
    const cartId = `c-${index}-${++cartSeq}`;
    const items = rng.int(1, 3);
    let total = 0;
    for (let i = 0; i < items; i++) {
      const category = pickCategory();
      const price = itemPrice(category);
      total += price;
      events.push({ type: 'cart_add', occurredAt: new Date(step()), payload: { sessionId, cartId, category, pricePaise: price } });
    }
    if (!buys) return;
    events.push({ type: 'checkout_start', occurredAt: new Date(step()), payload: { sessionId, cartId } });
    const discountPaise = rng.bool(p.discountAffinity) ? Math.round((total * rng.int(5, 20)) / 100) : 0;
    const orderedAt = new Date(step());
    const orderId = `o-${index}-${++orderSeq}`;
    events.push({ type: 'order_placed', occurredAt: orderedAt, payload: { orderId, cartId, totalPaise: total - discountPaise, discountPaise, items } });
    const earned = Math.floor((total - discountPaise) / 10_000); // 1 point per ₹100
    points += earned;
    events.push({ type: 'points_earned', occurredAt: orderedAt, payload: { orderId, points: earned } });
    if (rng.bool(returnRate)) {
      events.push({ type: 'order_returned', occurredAt: new Date(orderedAt.getTime() + rng.int(2, 12) * DAY), payload: { orderId } });
    }
  };

  for (let day = historyStart; day <= activeUntil; day += DAY) {
    const dayStart = Math.floor(day / DAY) * DAY;
    const s = seasonality(new Date(dayStart));
    const buyP = ((p.ordersPerMonth / 30) * s) / Math.max(0.15, 1 - p.abandonRate * 0.5);
    if (rng.bool(Math.min(0.9, (p.ordersPerMonth / 30) * s))) visit(dayStart, true);
    else if (rng.bool(Math.min(0.9, buyP * p.abandonRate * 0.6 + (p.extraBrowsingSessions / 30) * s))) visit(dayStart, false);
  }

  // Recent open cart (cart abandonment signal) for some active customers.
  if (inactiveFor <= 3 && rng.bool(p.openCartChance)) {
    const dayStart = Math.floor((now.getTime() - rng.int(0, 1) * DAY) / DAY) * DAY;
    const t = Math.min(now.getTime() - 3_600_000, eveningTime(rng, dayStart).getTime());
    const cartId = `c-${index}-${++cartSeq}`;
    const category = pickCategory();
    events.push({ type: 'session_start', occurredAt: new Date(t - 600_000), payload: { sessionId: `s-${index}-open` } });
    events.push({ type: 'cart_add', occurredAt: new Date(t), payload: { sessionId: `s-${index}-open`, cartId, category, pricePaise: itemPrice(category) } });
  }

  // Clamp to the past (generated visits near "now" could otherwise land a few hours ahead).
  const safe = events.filter((e) => e.occurredAt.getTime() <= now.getTime());
  const features = buildFeatures(safe, signupAt, now);
  const totalOrders = safe.filter((e) => e.type === 'order_placed').length;
  const expiringPoints = points > 200 && rng.bool(0.3) ? Math.round(points * 0.3) : 0;

  return {
    externalRef: `CUST-${String(index + 1).padStart(4, '0')}`,
    displayName: `${rng.pick(FIRST)} ${rng.pick(LAST)}`,
    persona,
    city: rng.pick(CITIES),
    ageBand: rng.pick(AGE_BANDS),
    signupAt,
    preferredCategories: preferred,
    rewardPoints: {
      balance: points,
      expiringPoints,
      expiresAt: expiringPoints ? new Date(now.getTime() + rng.int(3, 10) * DAY) : null,
    },
    features,
    segment: deriveSegment(features, totalOrders),
    events: safe,
  };
}

/** Generates a reproducible synthetic population. Same (seed, count, now) → identical output. */
export function generateDataset(opts: { seed: number; count: number; now: Date }): GeneratedCustomer[] {
  const rng = createRng(opts.seed);
  const personaPicker = (Object.entries(PERSONA_PROFILES) as [Persona, PersonaProfile][]).map(([value, p]) => ({ value, weight: p.weight }));
  const out: GeneratedCustomer[] = [];
  for (let i = 0; i < opts.count; i++) {
    // Guarantee at least two of every persona so each can be picked from the Telegram bot.
    const persona = i < personaPicker.length * 2 ? personaPicker[i % personaPicker.length].value : rng.weighted(personaPicker);
    out.push(generateCustomer(rng, i, persona, opts.now));
  }
  return out;
}
