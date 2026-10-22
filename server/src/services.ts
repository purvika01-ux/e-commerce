import type { AiClient } from './ai/types';
import { newGrantCode } from './decision/ledger';
import { createOrchestrator, type Clock, type RecommendRequest } from './decision/orchestrator';
import { createDeliveryService } from './delivery/service';
import type { TelegramSender } from './delivery/telegramSender';
import { createEngagementService } from './engagement/service';
import type { Logger } from './infra/logger';

export interface ServiceDeps {
  clock: Clock;
  ai: AiClient | null;
  telegram: TelegramSender | null;
  logger: Logger;
  newGrantCode?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** Must outlast the slowest pipeline (two AI attempts) or concurrent triggers could bypass the frequency cap. */
  leaseMs?: number;
}

export function createServices(deps: ServiceDeps) {
  const orchestrator = createOrchestrator({
    clock: deps.clock,
    ai: deps.ai,
    logger: deps.logger,
    newGrantCode: deps.newGrantCode ?? newGrantCode,
    leaseMs: deps.leaseMs,
  });
  const delivery = createDeliveryService({ clock: deps.clock, telegram: deps.telegram, logger: deps.logger, sleep: deps.sleep });
  const engagement = createEngagementService({ clock: deps.clock });

  /** Decide, then — only if approved — hand the decision id to the delivery service. Idempotent end to end. */
  async function recommendAndDeliver(req: RecommendRequest) {
    const result = await orchestrator.recommend(req);
    const approved = result.decision?.status === 'approved';
    const delivery_ = approved && req.channel === 'telegram' ? await delivery.deliver(String(result.decision!._id)) : null;
    return { ...result, delivery: delivery_ };
  }

  return { orchestrator, delivery, engagement, recommendAndDeliver, aiEnabled: Boolean(deps.ai), telegramEnabled: Boolean(deps.telegram) };
}

export type Services = ReturnType<typeof createServices>;
