import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { VenueRecommendationService } from './venue-recommendation.service';

class GenerateVenuesDto {
  latitude!: number;
  longitude!: number;
}

@Controller('scheduled-conversations/:scheduledConversationId/venue-recommendations')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class VenueRecommendationController {
  constructor(private readonly venueRecommendation: VenueRecommendationService) {}

  @Post()
  async generate(
    @CurrentUser() userId: string,
    @Param('scheduledConversationId') scheduledConversationId: string,
    @Body() dto: GenerateVenuesDto,
  ) {
    return this.venueRecommendation.generate(userId, scheduledConversationId, dto.latitude, dto.longitude);
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('scheduledConversationId') scheduledConversationId: string) {
    return this.venueRecommendation.list(userId, scheduledConversationId);
  }
}
