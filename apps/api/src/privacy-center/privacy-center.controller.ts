import { Body, Controller, Delete, Get, Param, UseGuards, UseInterceptors } from '@nestjs/common';

class DeleteAccountDto {
  confirmation!: string;
}
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { PrivacyCenterService } from './privacy-center.service';
import { ACCOUNT_NOT_REMOVED_HERE } from './deletion-report';
import { describeDecision } from './decision-labels';
import { THIRD_PARTY_LOSSES_NOTE } from './deletion-impact';
import { DECISIONS_OUT_OF_SCOPE } from './decision-scope';

@Controller('privacy')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class PrivacyCenterController {
  constructor(private readonly privacyCenter: PrivacyCenterService) {}

  @Get('overview')
  async getOverview(@CurrentUser() userId: string) {
    return this.privacyCenter.getOverview(userId);
  }

  @Delete('person/:id')
  async deletePerson(@CurrentUser() userId: string, @Param('id') id: string) {
    await this.privacyCenter.deletePerson(userId, id);
    return { deleted: true };
  }

  /** Пункт [screen-said-what-server-unsaid] 2026-09-25: тот же список,
   * что придёт в ответе на удаление, — но ДО решения. Раньше экран
   * держал свою копию этого текста и разошёлся с сервером: правка
   * [audit-trail] исправила серверную, экранная осталась с неправдой.
   * Одно место текста и два чтения его же — вместо двух копий. */
  @Get('account/deletion-preview')
  async accountDeletionPreview(@CurrentUser() userId: string) {
    return {
      notRemovedHere: [...ACCOUNT_NOT_REMOVED_HERE],
      // Пункт [cascade-took-a-stranger] 2026-09-26: что удаление заберёт
      // У ДРУГИХ. Раньше экран говорил только о том, что ОСТАЁТСЯ, — и
      // человек принимал решение, не зная его последствий для людей,
      // которых продукт сам попросил что-то написать.
      takesFromOthers: await this.privacyCenter.thirdPartyLosses(userId),
      takesFromOthersNote: THIRD_PARTY_LOSSES_NOTE,
    };
  }

  /** GDPR art. 17 — удаление аккаунта со всеми данными (аудит БД §2.4). */
  @Delete('account')
  async deleteAccount(@CurrentUser() userId: string, @Body() dto: DeleteAccountDto) {
    return this.privacyCenter.deleteAccount(userId, dto.confirmation);
  }

  /** Пункт [right-with-no-door] 2026-09-25 — решения, принятые о
   * человеке, на экран, а не только в скачанный JSON.
   *
   * Тот же метод, что отдаёт их выгрузке: разойтись двум ответам негде.
   * Потолок и признак «есть ещё» приходят как есть — обрезанный список,
   * выглядящий полным, тот же дефект, что и в файле. */
  @Get('decisions')
  async decisions(@CurrentUser() userId: string) {
    const groups = await this.privacyCenter.readDecisions(userId);
    const described = <T extends { items: Parameters<typeof describeDecision>[0][]; hasMore: boolean; limit: number }>(g: T) => ({
      items: g.items.map(describeDecision),
      hasMore: g.hasMore,
      limit: g.limit,
    });
    return {
      accountDecisions: described(groups.accountDecisions),
      projectDecisions: described(groups.projectDecisions),
      // Пункт [door-opened-onto-a-corner] 2026-09-25: третья группа —
      // решения о том, что человеку принадлежит. Без неё экран
      // дотягивался до девяти расшифрованных действий из тридцати
      // четырёх и при этом утверждал, что решений не принималось.
      belongingsDecisions: described(groups.belongingsDecisions),
      // Граница области — словами, рядом с самими решениями. Список
      // того, чего здесь нет, в продукте, который обещает не выдавать
      // пробел за полноту, обязан ехать вместе с данными.
      outOfScope: DECISIONS_OUT_OF_SCOPE.map((s) => ({ resource: s.resource, why: s.why })),
    };
  }

  @Get('export')
  async exportData(@CurrentUser() userId: string) {
    return this.privacyCenter.exportData(userId);
  }
}
