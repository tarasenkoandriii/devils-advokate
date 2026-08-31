// ТЗ domain-ui-and-voice-intake §2 — HTTP-слой intake-квиза.
import { Body, Controller, Get, Headers, Param, Post, UnauthorizedException, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { NotRestrictedGuard } from '../telegram-auth/not-restricted.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { SecretsService } from '../secrets/secrets.service';
import { IntakeScenario, IntakeService } from './intake.service';
import { safeSecretEqual } from '../common/timing-safe-equal';

class TextDto {
  text!: string;
}

class DispatchDto {
  scenario!: IntakeScenario;
  contractType?: 'PRENUP' | 'DIVORCE_SETTLEMENT';
}

// Тот же секрет, что у scheduler/dispatch — один pg_cron-вызов в сутки
// (ТЗ §2.2 п.7), отдельный секрет плодить незачем.
const DISPATCH_SECRET_REF = 'SCHEDULER_DISPATCH_SECRET';

@Controller('intake')
@UseInterceptors(ApiResponseInterceptor)
export class IntakeController {
  constructor(
    private readonly intake: IntakeService,
    private readonly secrets: SecretsService,
  ) {}

  @Post('sessions')
  @UseGuards(TelegramAuthGuard, NotRestrictedGuard)
  start(@CurrentUser() userId: string, @Body() dto: TextDto) {
    return this.intake.start(userId, dto.text);
  }

  @Get('sessions/:id')
  @UseGuards(TelegramAuthGuard)
  get(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.intake.get(userId, id);
  }

  @Post('sessions/:id/answers')
  @UseGuards(TelegramAuthGuard, NotRestrictedGuard)
  answer(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: TextDto) {
    return this.intake.answer(userId, id, dto.text);
  }

  @Post('sessions/:id/dispatch')
  @UseGuards(TelegramAuthGuard, NotRestrictedGuard)
  dispatch(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: DispatchDto) {
    return this.intake.dispatch(userId, id, dto.scenario, { contractType: dto.contractType });
  }

  @Post('abandon-stale')
  async abandonStale(@Headers('x-dispatch-secret') providedSecret: string) {
    const expected = await this.secrets.resolve(DISPATCH_SECRET_REF);
    if (!safeSecretEqual(providedSecret, expected)) throw new UnauthorizedException();
    return this.intake.abandonStale();
  }
}
