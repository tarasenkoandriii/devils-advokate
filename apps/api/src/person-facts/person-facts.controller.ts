import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { FactStatus } from '@prisma/client';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { PersonFactsService, CreatePersonFactInput } from './person-facts.service';

@Controller('people/:personId/facts')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class PersonFactsController {
  constructor(private readonly personFacts: PersonFactsService) {}

  @Post()
  async create(
    @CurrentUser() userId: string,
    @Param('personId') personId: string,
    @Body() dto: CreatePersonFactInput,
  ) {
    return this.personFacts.create(userId, personId, dto);
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('personId') personId: string) {
    return this.personFacts.listForPerson(userId, personId);
  }

  /** Пункт [no-correction] 2026-09-05 — «я перепроверил, это по-прежнему
   * так». Без этого действия предупреждение об устаревании снять было
   * нечем: `lastVerifiedAt` не записывался нигде. */
  @Patch(':factId/confirm')
  async confirm(
    @CurrentUser() userId: string,
    @Param('personId') personId: string,
    @Param('factId') factId: string,
  ) {
    return this.personFacts.confirm(userId, personId, factId);
  }

  /** «Это неверно» (DISPUTED) и «больше не актуально» (EXPIRED) — оба
   * состояния схема знала с самого начала, три сервиса на них ветвились,
   * и выставить их не мог никто. */
  @Patch(':factId/status')
  async setStatus(
    @CurrentUser() userId: string,
    @Param('personId') personId: string,
    @Param('factId') factId: string,
    @Body() dto: { status?: string },
  ) {
    if (dto.status !== FactStatus.DISPUTED && dto.status !== FactStatus.EXPIRED) {
      // Возврат в ACTIVE — это не «смена статуса», а подтверждение:
      // человек говорит, что проверил. Отдельным действием выше, чтобы
      // заодно ставилась дата проверки.
      throw new BadRequestException(
        'Допустимые значения: DISPUTED (это неверно) или EXPIRED (больше не актуально). Чтобы вернуть факт в силу, подтвердите его.',
      );
    }
    return this.personFacts.setStatus(userId, personId, factId, dto.status);
  }

  @Delete(':factId')
  async remove(
    @CurrentUser() userId: string,
    @Param('personId') personId: string,
    @Param('factId') factId: string,
  ) {
    return this.personFacts.remove(userId, personId, factId);
  }
}
