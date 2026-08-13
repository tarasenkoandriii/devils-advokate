import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
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
  async submit(@CurrentUser() userId: string, @Body() dto: SubmitApplicationInput) {
    return this.venueApplication.submitApplication(userId, dto);
  }

  @Get('venue-applications/mine')
  async listMine(@CurrentUser() userId: string) {
    return this.venueApplication.listMyApplications(userId);
  }

  // Модерация — требует User.isVenueModerator (проверяется внутри
  // сервиса, тот же минимальный подход, что у LibraryController).
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

  // ── Пункт 67 (§3.22 "Монетизация") ──

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

  @Post('approved-venues/:approvedVenueId/booking-confirmations')
  async confirmBooking(
    @CurrentUser() userId: string,
    @Param('approvedVenueId') approvedVenueId: string,
    @Body() dto: ConfirmBookingDto,
  ) {
    return this.venueApplication.confirmBooking(userId, approvedVenueId, dto.scheduledConversationId);
  }

  @Get('approved-venues/:approvedVenueId/commission-summary')
  async getCommissionSummary(@CurrentUser() userId: string, @Param('approvedVenueId') approvedVenueId: string) {
    return this.venueApplication.getCommissionSummary(userId, approvedVenueId);
  }
}
