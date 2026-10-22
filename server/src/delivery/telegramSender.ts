import { Api, GrammyError, HttpError, InlineKeyboard } from 'grammy';

export type SendErrorKind = 'blocked' | 'bad_request' | 'rate_limited' | 'network';

export class TelegramSendError extends Error {
  constructor(
    public readonly kind: SendErrorKind,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

/** The delivery channel. Only the delivery service calls sendOffer, and only for approved decisions. */
export interface TelegramSender {
  sendOffer(chatId: number, html: string, grantCode: string): Promise<{ messageId: string }>;
}

export function offerKeyboard(grantCode: string): InlineKeyboard {
  return new InlineKeyboard().text('✅ Claim', `claim:${grantCode}`).text('🙅 Not interested', `decline:${grantCode}`);
}

export function classifyTelegramError(err: unknown): TelegramSendError {
  if (err instanceof GrammyError) {
    if (err.error_code === 403) return new TelegramSendError('blocked', 'User blocked the bot or never started it');
    if (err.error_code === 429) return new TelegramSendError('rate_limited', 'Telegram rate limit', err.parameters?.retry_after ?? 1);
    if (err.error_code >= 500) return new TelegramSendError('network', `Telegram server error ${err.error_code}`);
    return new TelegramSendError('bad_request', `Telegram rejected the message (${err.error_code})`);
  }
  if (err instanceof HttpError) return new TelegramSendError('network', 'Network error talking to Telegram');
  if (err instanceof TelegramSendError) return err;
  return new TelegramSendError('network', err instanceof Error ? err.message : 'Unknown Telegram error');
}

/** Real sender backed by the Bot API. Refuses to start under NODE_ENV=test. */
export function createTelegramSender(api: Api): TelegramSender {
  if (process.env.NODE_ENV === 'test') throw new Error('Live Telegram sender must not be constructed in tests');
  return {
    async sendOffer(chatId, html, grantCode) {
      try {
        const msg = await api.sendMessage(chatId, html, {
          parse_mode: 'HTML',
          reply_markup: offerKeyboard(grantCode),
          link_preview_options: { is_disabled: true },
        });
        return { messageId: String(msg.message_id) };
      } catch (err) {
        throw classifyTelegramError(err);
      }
    },
  };
}
