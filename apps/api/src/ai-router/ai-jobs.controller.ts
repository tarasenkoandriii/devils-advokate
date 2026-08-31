// Пункт [multimodal] §4.4–§4.5 — HTTP-поверхность асинхронной полосы.
//
// Два контроллера с разной аутентификацией, как у SchedulerController:
//  • AIJobsController — пользовательский GET /ai-jobs/:id под
//    TelegramAuthGuard, только свои джобы;
//  • AIJobsDispatchController — воркер БЕЗ TelegramAuthGuard: вызывает
//    pg_net из Supabase (server-to-server), аутентификация — сверка
//    заголовка x-dispatch-secret с AI_JOB_DISPATCH_SECRET через
//    safeSecretEqual. Дословно тот же паттерн, что
//    SCHEDULER_DISPATCH_SECRET (обоснование — scheduler.service.ts).

import {
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { safeSecretEqual } from '../common/timing-safe-equal';
import { SecretsService } from '../secrets/secrets.service';
import { AIRouterService } from './ai-router.service';
import { ConversationsService } from '../conversations/conversations.service';

const DISPATCH_SECRET_REF = 'AI_JOB_DISPATCH_SECRET';

/** Батчи из ТЗ §4.5: постановка и опрос — короткие вызовы (~1 с), не
 * ожидание модели, поэтому 3 и 10, а не 1. */
const SUBMIT_BATCH = 3;
const POLL_BATCH = 10;

@Controller('ai-jobs')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class AIJobsController {
  constructor(private readonly aiRouter: AIRouterService) {}

  @Get(':id')
  async get(@CurrentUser() userId: string, @Param('id') jobId: string) {
    const job = await this.aiRouter.getJobForUser(userId, jobId);
    if (!job) {
      // Один ответ на «нет» и «не ваш» — не раскрываем существование
      // чужих джоб, тот же принцип, что findOwnedConversation.
      throw new NotFoundException(`AIJob ${jobId} not found`);
    }
    return job;
  }
}

@Controller('internal/ai-jobs')
@UseInterceptors(ApiResponseInterceptor)
export class AIJobsDispatchController {
  constructor(
    private readonly aiRouter: AIRouterService,
    private readonly conversations: ConversationsService,
    private readonly secrets: SecretsService,
  ) {}

  private async assertSecret(providedSecret: string) {
    const expected = await this.secrets.resolve(DISPATCH_SECRET_REF);
    if (!safeSecretEqual(providedSecret, expected)) {
      throw new UnauthorizedException('Invalid dispatch secret');
    }
  }

  @Post('submit')
  async submit(@Headers('x-dispatch-secret') providedSecret: string) {
    await this.assertSecret(providedSecret);
    return this.aiRouter.submitQueued(SUBMIT_BATCH);
  }

  @Post('poll')
  async poll(@Headers('x-dispatch-secret') providedSecret: string) {
    await this.assertSecret(providedSecret);
    return this.aiRouter.pollRunning(POLL_BATCH);
  }

  /** Сторожевая: протухшие lease джоб (§4.5) + принудительная чистка
   * blob-файлов, у которых потребители зависли дольше
   * MEDIA_LEASE_MAX_AGE (§7.2). Оба — в одном тике: обе проверки
   * дешёвые, а отдельный третий cron-запрос не добавил бы ничего,
   * кроме ещё одного секрета в ещё одном SQL-файле. */
  @Post('reap')
  async reap(@Headers('x-dispatch-secret') providedSecret: string) {
    await this.assertSecret(providedSecret);
    const jobs = await this.aiRouter.reapExpired();
    const media = await this.conversations.reapExpiredMediaLeases();
    return { ...jobs, ...media };
  }
}
