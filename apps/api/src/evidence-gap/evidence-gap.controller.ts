import { Controller, Get, Param, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { EvidenceGapService } from './evidence-gap.service';

// GET, не POST: детерминированная классификация уже существующих
// данных, не AI-вызов — нет смысла разделять "запустить"/"посмотреть
// результат", как у Missing Information/Turning Points. Всегда
// актуальный ответ на каждый вызов, ничего не персистится.
@Controller('projects/:projectId/evidence-gap')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class EvidenceGapController {
  constructor(private readonly evidenceGap: EvidenceGapService) {}

  @Get()
  async analyze(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.evidenceGap.analyze(userId, projectId);
  }
}
