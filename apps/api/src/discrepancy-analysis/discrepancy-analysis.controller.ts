import { Body, Controller, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { DiscrepancyAnalysisService } from './discrepancy-analysis.service';

class CheckAgainstUserSourceDto {
  segmentId!: string;
  url!: string;
}

class CheckAgainstFactCheckApiDto {
  segmentId!: string;
  claimText!: string;
}

@Controller()
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class DiscrepancyAnalysisController {
  constructor(private readonly discrepancyAnalysis: DiscrepancyAnalysisService) {}

  @Post('conversations/:conversationId/discrepancies/detect')
  async detect(@CurrentUser() userId: string, @Param('conversationId') conversationId: string) {
    return this.discrepancyAnalysis.detect(userId, conversationId);
  }

  @Get('conversations/:conversationId/discrepancies')
  async list(@CurrentUser() userId: string, @Param('conversationId') conversationId: string) {
    return this.discrepancyAnalysis.list(userId, conversationId);
  }

  // §3.16 ТЗ: userConfirmedIntentionalFalsehood — только ручное
  // действие пользователя, отдельный эндпоинт, не побочный эффект detect().
  @Patch('discrepancies/:signalId/confirm-intentional')
  async confirmIntentionalFalsehood(
    @CurrentUser() userId: string,
    @Param('signalId') signalId: string,
  ) {
    return this.discrepancyAnalysis.confirmIntentionalFalsehood(userId, signalId);
  }

  // Пункт 40 — четвёртый источник сверки §3.16 ТЗ, ручная вставка
  // ссылки пользователем вместо автономного поиска.
  @Post('conversations/:conversationId/discrepancies/check-source')
  async checkAgainstUserSource(
    @CurrentUser() userId: string,
    @Param('conversationId') conversationId: string,
    @Body() dto: CheckAgainstUserSourceDto,
  ) {
    return this.discrepancyAnalysis.checkAgainstUserSource(userId, conversationId, dto.segmentId, dto.url);
  }

  // Пункт [media-review] (devils-advocate-media-review-tz.md §2.4/§5)
  // — путь следует уже установленной конвенции этого контроллера
  // (conversationId в пути, нужен для проверки владения — ТЗ §5
  // предлагал segments/:segmentId/... без conversationId, здесь
  // сохранена согласованность с check-source выше, не буквальный путь ТЗ).
  @Post('conversations/:conversationId/discrepancies/check-against-fact-check-api')
  async checkAgainstFactCheckAPI(
    @CurrentUser() userId: string,
    @Param('conversationId') conversationId: string,
    @Body() dto: CheckAgainstFactCheckApiDto,
  ) {
    return this.discrepancyAnalysis.checkAgainstFactCheckAPI(userId, conversationId, dto.segmentId, dto.claimText);
  }

  // Пункт 41 — выгрузка пронумерованного списка утверждений для
  // ручной проверки пользователем, не автономный поиск.
  @Get('conversations/:conversationId/discrepancies/export')
  async exportFactsToVerify(@CurrentUser() userId: string, @Param('conversationId') conversationId: string) {
    return this.discrepancyAnalysis.exportFactsToVerify(userId, conversationId);
  }
}

