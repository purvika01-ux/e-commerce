import type { Persona } from '../domain/types';
import { Customer, TelegramLink } from '../models';

export const PERSONA_LABELS: Record<Persona, string> = {
  loyal_high_value: '💎 Loyal big spender',
  deal_seeker: '🏷️ Deal hunter',
  new_customer: '🌱 Brand-new shopper',
  at_risk: '🕰️ Drifting away',
  dormant: '💤 Long-lost customer',
  cart_abandoner: '🛒 Cart abandoner',
  window_shopper: '👀 Window shopper',
  occasional: '🎯 Occasional buyer',
};

export type LinkResult =
  | { status: 'linked' | 'already_linked' | 'reactivated'; customerId: string }
  | { status: 'no_customer_available' };

/**
 * Links a Telegram chat to an unused synthetic customer of the chosen persona.
 * Stores only the chat id and (optionally) a first name for greetings.
 */
export async function linkChat(chatId: number, persona: Persona, firstName: string | null): Promise<LinkResult> {
  const existing = await TelegramLink.findOne({ chatId }).lean();
  if (existing?.status === 'active') return { status: 'already_linked', customerId: String(existing.customerId) };
  if (existing) {
    await TelegramLink.updateOne({ _id: existing._id }, { status: 'active', firstName, lastInteractionAt: new Date() });
    await Customer.updateOne({ _id: existing.customerId }, { optedOut: false });
    return { status: 'reactivated', customerId: String(existing.customerId) };
  }
  // Atomic claim of one unlinked customer, so two chats can never share a profile.
  const customer = await Customer.findOneAndUpdate(
    { persona, telegramLinked: false, optedOut: false },
    { $set: { telegramLinked: true } },
    { returnDocument: 'after', sort: { externalRef: 1 } },
  ).lean();
  if (!customer) return { status: 'no_customer_available' };
  try {
    await TelegramLink.create({ chatId, customerId: customer._id, firstName: firstName?.slice(0, 64) ?? null, personaChoice: persona });
  } catch (err: any) {
    await Customer.updateOne({ _id: customer._id }, { telegramLinked: false });
    if (err?.code === 11000) {
      const winner = await TelegramLink.findOne({ chatId }).lean();
      if (winner) return { status: 'already_linked', customerId: String(winner.customerId) };
    }
    throw err;
  }
  return { status: 'linked', customerId: String(customer._id) };
}

/** /stop: opt out and stop all future offers to this chat. */
export async function unlinkChat(chatId: number): Promise<boolean> {
  const link = await TelegramLink.findOneAndUpdate({ chatId, status: { $ne: 'unlinked' } }, { status: 'unlinked', firstName: null }).lean();
  if (!link) return false;
  await Customer.updateOne({ _id: link.customerId }, { optedOut: true });
  return true;
}
