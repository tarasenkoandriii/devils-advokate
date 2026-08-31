import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { NotRestrictedGuard } from '../telegram-auth/not-restricted.guard';
import { AdminSessionGuard } from '../admin-auth/admin-session.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { VenueApplicationService, SubmitApplicationInput } from './venue-application.service';

class ModerateDto {
  decision!: 'APPROVE' | 'REJECT';
  referralFeeAmount?: number;
}

class SetReferralFeeDto {
  referralFeeAmount: number | null = null;
}

class SetPriorityPartnerDto {
  isPriorityPartner!: boolean;
}

class ConfirmBookingDto {
  scheduledConversationId?: string;
}

@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
@Controller()
export class VenueApplicationController {
  constructor(private readonly venueApplication: VenueApplicationService) {}

  @Get('venue-applications/search')
  async search(
    @Query('query') query: string,
    @Query('latitude') latitude?: string,
    @Query('longitude') longitude?: string,
  ) {
    return this.venueApplication.searchCandidates(
      query,
      latitude ? parseFloat(latitude) : undefined,
      longitude ? parseFloat(longitude) : undefined,
    );
  }

  @Get('venue-applications/autofill/:googlePlaceId')
  async autofill(@Param('googlePlaceId') googlePlaceId: string) {
    return this.venueApplication.getAutofillData(googlePlaceId);
  }

  @Post('venue-applications')
  @UseGuards(NotRestrictedGuard) // devils-advocate-admin-panel-tz.md §4.3
  async submit(@CurrentUser() userId: string, @Body() dto: SubmitApplicationInput) {
    return this.venueApplication.submitApplication(userId, dto);
  }

  @Get('venue-applications/mine')
  async listMine(@CurrentUser() userId: string) {
    return this.venueApplication.listMyApplications(userId);
  }

  // confirmBooking — самоотчёт обычного пользователя о состоявшейся
  // брони (§3.22), НЕ действие модератора: assertModerator() внутри
  // VenueApplicationService на этот метод не навешен (проверено —
  // единственный из monetization-методов сервиса без него), поэтому
  // остаётся на TelegramAuthGuard вместе с остальными пользовательскими
  // эндпоинтами этого контроллера, не переезжает в модерационный.
  @Post('approved-venues/:approvedVenueId/booking-confirmations')
  async confirmBooking(
    @CurrentUser() userId: string,
    @Param('approvedVenueId') approvedVenueId: string,
    @Body() dto: ConfirmBookingDto,
  ) {
    return this.venueApplication.confirmBooking(userId, approvedVenueId, dto.scheduledConversationId);
  }
}

// Пункт [admin-panel] (devils-advocate-admin-panel-tz.md §4.1) —
// та же поправка к буквальной формулировке ТЗ, что уже применена к
// LibraryController (см. комментарий там): весь VenueApplicationController
// переключить на AdminSessionGuard нельзя, не сломав search/autofill/
// submit/listMine/confirmBooking — обычные действия пользователя TMA.
// Сюда вынесены только методы, которые VenueApplicationService реально
// защищает через assertModerator() (проверено в коде, не предположение):
// listPendingForModeration, moderate, setReferralFee, setPriorityPartner,
// getCommissionSummary — те самые функции, которые более ранний аудит
// TMA (см. TODO.md, «Оставшиеся неиспользуемые функции API TMA») нашёл
// «осиротевшими» именно потому, что ждали интерфейс администрирования,
// не обычного пользователя. VenueApplicationService не меняется вообще
// (acceptance-тест §5.4).
@Controller()
@UseGuards(AdminSessionGuard)
@UseInterceptors(ApiResponseInterceptor)
export class VenueApplicationModerationController {
  constructor(private readonly venueApplication: VenueApplicationService) {}

  @Get('venue-applications/moderation-queue')
  async listPending(@CurrentUser() userId: string) {
    return this.venueApplication.listPendingForModeration(userId);
  }

  @Patch('venue-applications/:applicationId/moderate')
  async moderate(
    @CurrentUser() userId: string,
    @Param('applicationId') applicationId: string,
    @Body() dto: ModerateDto,
  ) {
    return this.venueApplication.moderate(userId, applicationId, dto.decision, dto.referralFeeAmount);
  }

  // ── Пункт 67 (§3.22 "Монетизация") — тоже модерационные/операционные
  // действия, не путь обычного пользователя. ──

  @Patch('approved-venues/:approvedVenueId/referral-fee')
  async setReferralFee(
    @CurrentUser() userId: string,
    @Param('approvedVenueId') approvedVenueId: string,
    @Body() dto: SetReferralFeeDto,
  ) {
    return this.venueApplication.setReferralFee(userId, approvedVenueId, dto.referralFeeAmount);
  }

  @Patch('approved-venues/:approvedVenueId/priority-partner')
  async setPriorityPartner(
    @CurrentUser() userId: string,
    @Param('approvedVenueId') approvedVenueId: string,
    @Body() dto: SetPriorityPartnerDto,
  ) {
    return this.venueApplication.setPriorityPartner(userId, approvedVenueId, dto.isPriorityPartner);
  }

  @Get('approved-venues/:approvedVenueId/commission-summary')
  async getCommissionSummary(@CurrentUser() userId: string, @Param('approvedVenueId') approvedVenueId: string) {
    return this.venueApplication.getCommissionSummary(userId, approvedVenueId);
  }
}
