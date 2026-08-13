import { Body, Controller, Get, Put, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { OnboardingService, SaveOnboardingInput } from './onboarding.service';

class SuggestFromLocationDto {
  lat!: number;
  lon!: number;
  engineId?: string;
}

@Controller('onboarding')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  async get(@CurrentUser() userId: string) {
    return this.onboarding.get(userId);
  }

  @Put()
  async save(@CurrentUser() userId: string, @Body() dto: SaveOnboardingInput) {
    return this.onboarding.save(userId, dto);
  }

  // Пункт 49 — НЕ персистит ничего сама, только возвращает подсказку
  // (детерминированную country/city + AI-догадку о религии).
  @Post('suggest-from-location')
  async suggestFromLocation(@CurrentUser() userId: string, @Body() dto: SuggestFromLocationDto) {
    return this.onboarding.suggestFromLocation(userId, dto.lat, dto.lon, dto.engineId);
  }
}
