import { Body, Controller, Get, Headers, Param, Patch, Post, UnauthorizedException, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { SchedulerService } from './scheduler.service';
import { SecretsService } from '../secrets/secrets.service';

const DISPATCH_SECRET_REF = 'SCHEDULER_DISPATCH_SECRET';
const BOT_TOKEN_REF = 'TELEGRAM_BOT_TOKEN';

class CreateScheduledConversationDto {
  personId?: string;
  scheduledAt!: string;
  sparringReminderMinutesBefore?: number | null;
}

@Controller('projects/:projectId/scheduled-conversations')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class SchedulerController {
  constructor(private readonly scheduler: SchedulerService) {}

  @Post()
  async create(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CreateScheduledConversationDto,
  ) {
    return this.scheduler.create(userId, projectId, {
      personId: dto.personId,
      scheduledAt: new Date(dto.scheduledAt),
      sparringReminderMinutesBefore: dto.sparringReminderMinutesBefore,
    });
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.scheduler.listForProject(userId, projectId);
  }

  // Пункт 51 (TMA UI) — эндпоинт для связывания запланированного
  // события с реальным разговором был описан в SchedulerService с
  // самого Пункта 50, но не был выведен наружу — реальный пробел,
  // найденный при подключении TMA UI, не молчаливый пропуск.
  @Patch(':scheduledId/link')
  async link(
    @CurrentUser() userId: string,
    @Param('scheduledId') scheduledId: string,
    @Body() dto: { conversationId: string },
  ) {
    return this.scheduler.linkToConversation(userId, scheduledId, dto.conversationId);
  }
}

// Пункт 50 — отдельный контроллер БЕЗ TelegramAuthGuard: вызывающая
// сторона — pg_net из Supabase (server-to-server), не пользователь
// Telegram. Аутентификация — сверка заголовка с секретом, тот же
// принцип, что CRON_SECRET у самого Vercel (см. обоснование в
// scheduler.service.ts).
@Controller('internal/reminders')
export class SchedulerDispatchController {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly secrets: SecretsService,
  ) {}

  @Post('dispatch')
  async dispatch(@Headers('x-dispatch-secret') providedSecret: string) {
    const expectedSecret = await this.secrets.resolve(DISPATCH_SECRET_REF);
    if (!providedSecret || providedSecret !== expectedSecret) {
      throw new UnauthorizedException('Invalid dispatch secret');
    }
    const botToken = await this.secrets.resolve(BOT_TOKEN_REF);
    return this.scheduler.dispatchDueReminders(botToken);
  }
}
