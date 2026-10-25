import { Bot, InlineKeyboard } from 'grammy';
import { PERSONAS, rupees, type Persona } from '../domain/types';
import { AppError } from '../infra/errors';
import type { Logger } from '../infra/logger';
import { Customer, Decision, TelegramLink } from '../models';
import type { Services } from '../services';
import { termsHeadline, formatIst } from '../rules/terms';
import { createRateLimiter } from '../security/rateLimit';
import { linkChat, PERSONA_LABELS, unlinkChat } from './linking';

const WELCOME = [
  '👋 <b>Welcome to Offerly AI</b> — a hackathon demo of a personalised offer engine.',
  '',
  'You will play a <b>synthetic shopper</b> on a pretend e-commerce store. Nothing here is real: no purchases, no real discounts, and we store only your Telegram chat id and first name.',
  '',
  'Pick the kind of shopper you want to be:',
].join('\n');

const HELP = [
  '<b>Commands</b>',
  '/offer — get a personalised offer for your shopper profile',
  '/myoffers — offers you currently hold',
  '/profile — your synthetic shopper profile',
  '/stop — stop receiving offers',
  '/help — this message',
].join('\n');

function personaKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  PERSONAS.forEach((p, i) => {
    kb.text(PERSONA_LABELS[p], `persona:${p}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
}

function friendlyNoOffer(decision: Record<string, any> | null): string {
  const reasons = (decision?.excluded ?? []).flatMap((e: any) => e.reasons ?? []) as { rule: string; message: string }[];
  const has = (rule: string) => reasons.some((r) => r.rule === rule);
  if (decision?.outcomeReason === 'AI_CHOSE_NO_OFFER') return "🙂 You're all set — you don't need a discount right now. Check back later!";
  if (has('OPTED_OUT')) return 'You have opted out of offers. Send /start to opt back in.';
  if (has('FREQUENCY_CAP')) return "📬 You've already had the maximum number of offers this week. We don't want to spam you!";
  if (has('NO_STACKING')) return '🎟️ You already hold an unused offer — see /myoffers.';
  if (has('PURCHASE_COOLDOWN')) return '🛍️ You bought something very recently, so no discount right now.';
  if (has('LIKELY_BUYER_SUPPRESSION')) return "😊 You're one of our regulars — no discount needed today.";
  if (has('RETURN_ABUSE_EXCLUSION')) return 'No offers are available for this profile right now.';
  return 'No offer matches your profile right now. Try again later!';
}

/** One /offer per chat per window (default 10 s). */
export const OFFER_COOLDOWN_MS = 10_000;

export function createBot(token: string, services: Services, logger: Logger): Bot {
  const bot = new Bot(token);
  const offerThrottle = createRateLimiter({ windowMs: OFFER_COOLDOWN_MS, max: 1 });

  const activeLink = (chatId: number) => TelegramLink.findOne({ chatId, status: 'active' }).lean();

  bot.command('start', async (ctx) => {
    const link = await activeLink(ctx.chat.id);
    if (link) {
      await ctx.reply('You are already set up. Send /offer to get a personalised offer, or /help.', { parse_mode: 'HTML' });
      return;
    }
    const old = await TelegramLink.findOne({ chatId: ctx.chat.id }).lean();
    if (old) {
      const r = await linkChat(ctx.chat.id, old.personaChoice as Persona, ctx.from?.first_name ?? null);
      await ctx.reply(r.status === 'reactivated' ? '✅ Welcome back! Offers are switched on again. Send /offer.' : 'Send /offer to continue.');
      return;
    }
    await ctx.reply(WELCOME, { parse_mode: 'HTML', reply_markup: personaKeyboard() });
  });

  bot.callbackQuery(/^persona:(.+)$/, async (ctx) => {
    const persona = ctx.match[1] as Persona;
    if (!PERSONAS.includes(persona) || !ctx.chat) return ctx.answerCallbackQuery({ text: 'Unknown option' });
    const r = await linkChat(ctx.chat.id, persona, ctx.from.first_name ?? null);
    await ctx.answerCallbackQuery();
    if (r.status === 'no_customer_available') {
      await ctx.reply('All shoppers of that type are taken — please pick another one.', { reply_markup: personaKeyboard() });
      return;
    }
    const c = await Customer.findById(r.customerId).lean();
    await ctx.reply(
      `✅ You are now <b>${c?.externalRef}</b>, a ${PERSONA_LABELS[persona].replace(/^\S+\s/, '').toLowerCase()} (synthetic profile).\n\nSend /offer to get your personalised offer.`,
      { parse_mode: 'HTML' },
    );
  });

  bot.command('offer', async (ctx) => {
    const link = await activeLink(ctx.chat.id);
    if (!link) return void (await ctx.reply('Send /start first to pick your shopper profile.'));
    // Each /offer can call Claude, so repeated taps from one chat are throttled before any work.
    const throttle = offerThrottle.hit(`chat:${ctx.chat.id}`);
    if (!throttle.allowed) return void (await ctx.reply(`⏳ Please wait ${throttle.retryAfterSec}s before asking for another offer.`));
    await TelegramLink.updateOne({ _id: link._id }, { lastInteractionAt: new Date() });
    await ctx.reply('🔎 Checking your profile and our offer rules…');
    try {
      const r = await services.recommendAndDeliver({
        customerId: String(link.customerId),
        idempotencyKey: `bot:${ctx.chat.id}:${ctx.update.update_id}`,
        type: 'bot_request',
        source: 'bot',
        channel: 'telegram',
        dataOrigin: 'classmate',
      });
      const status = r.decision?.status;
      if (status === 'approved' && r.delivery?.status === 'sent') return;
      if (status === 'approved' || status === 'cancelled') return void (await ctx.reply('⚠️ We found an offer but could not deliver it safely. Please try again later.'));
      if (status === 'rejected') return void (await ctx.reply('No offer passed our safety checks right now. Try again later!'));
      await ctx.reply(friendlyNoOffer(r.decision));
    } catch (err) {
      if (err instanceof AppError && err.code === 'CUSTOMER_BUSY') return void (await ctx.reply('⏳ Still working on your last request…'));
      logger.error('bot /offer failed', { error: err });
      await ctx.reply('Sorry — offers are unavailable right now. Nothing was sent.');
    }
  });

  bot.command('myoffers', async (ctx) => {
    const link = await activeLink(ctx.chat.id);
    if (!link) return void (await ctx.reply('Send /start first.'));
    const active = await Decision.find({
      customerId: link.customerId,
      status: 'approved',
      'grant.status': { $in: ['issued', 'claimed'] },
      'grant.expiresAt': { $gt: new Date() },
    }).lean();
    if (!active.length) return void (await ctx.reply('You have no active offers. Send /offer to get one.'));
    const lines = active.map((d: any) => `• <b>${termsHeadline(d.offerSnapshot.type, d.offerSnapshot.terms)}</b> — code <code>${d.grant.code}</code> (${d.grant.status}, until ${formatIst(new Date(d.grant.expiresAt))})`);
    await ctx.reply(['<b>Your offers</b>', ...lines].join('\n'), { parse_mode: 'HTML' });
  });

  bot.command('profile', async (ctx) => {
    const link = await activeLink(ctx.chat.id);
    if (!link) return void (await ctx.reply('Send /start first.'));
    const c: any = await Customer.findById(link.customerId).lean();
    const f = c.features;
    await ctx.reply(
      [
        `<b>${c.externalRef}</b> (synthetic)`,
        `Segment: ${c.segment.replace('_', ' ')}`,
        `Orders in last 90 days: ${f.frequency90d}`,
        `Last order: ${f.recencyDays === null ? 'never' : `${f.recencyDays} days ago`}`,
        `Average order: ${rupees(f.aovPaise)}`,
        `Reward points: ${c.rewardPoints.balance}`,
        f.openCart ? `Open cart: ${rupees(f.openCart.valuePaise)} (${f.openCart.categories.join(', ')})` : 'Open cart: none',
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  bot.command('stop', async (ctx) => {
    await unlinkChat(ctx.chat.id);
    await ctx.reply('You will not receive any more offers. Send /start any time to opt back in.');
  });

  bot.command('help', (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));

  bot.callbackQuery(/^(claim|decline):([A-Z0-9-]{6,20})$/, async (ctx) => {
    if (!ctx.chat || typeof ctx.match === 'string') return;
    const action = ctx.match[1] === 'claim' ? 'claimed' : 'declined';
    const outcome = await services.engagement.respond(ctx.chat.id, ctx.match[2], action);
    const text: Record<string, string> = {
      ok: action === 'claimed' ? '🎉 Claimed! (Demo only — no real purchase.)' : 'Thanks for letting us know.',
      duplicate: 'Already recorded.',
      not_owner: 'This offer belongs to someone else.',
      not_found: 'Offer not found.',
      expired: 'This offer has expired.',
      not_active: 'This offer is no longer active.',
    };
    await ctx.answerCallbackQuery({ text: text[outcome] });
  });

  bot.catch((err) => logger.error('telegram bot error', { error: err.error }));
  return bot;
}
