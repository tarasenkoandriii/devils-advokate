import { Body, Controller, Get, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { WeatherForecastService } from './weather-forecast.service';

class GenerateByCityDto {
  cityName!: string;
  engineId?: string;
}

class GenerateByGeolocationDto {
  latitude!: number;
  longitude!: number;
  engineId?: string;
}

@Controller('scheduled-conversations/:scheduledConversationId/weather-forecasts')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class WeatherForecastController {
  constructor(private readonly weatherForecast: WeatherForecastService) {}

  @Post('by-city')
  async byCity(
    @CurrentUser() userId: string,
    @Param('scheduledConversationId') scheduledConversationId: string,
    @Body() dto: GenerateByCityDto,
  ) {
    return this.weatherForecast.generateByCity(userId, scheduledConversationId, dto.cityName, dto?.engineId);
  }

  @Post('by-geolocation')
  async byGeolocation(
    @CurrentUser() userId: string,
    @Param('scheduledConversationId') scheduledConversationId: string,
    @Body() dto: GenerateByGeolocationDto,
  ) {
    return this.weatherForecast.generateByGeolocation(userId, scheduledConversationId, dto.latitude, dto.longitude, dto?.engineId);
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('scheduledConversationId') scheduledConversationId: string) {
    return this.weatherForecast.list(userId, scheduledConversationId);
  }
}

// Пункт 78 (§3.20 ТЗ) — "мягкое предупреждение прямо в форме
// создания" — встречи ещё не существует на момент предпросмотра,
// поэтому отдельный, project-level маршрут, не вложен в
// scheduled-conversations/:id/ как остальные методы этого сервиса.
@Controller('projects/:projectId/weather-forecast-preview')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class WeatherForecastPreviewController {
  constructor(private readonly weatherForecast: WeatherForecastService) {}

  @Get()
  async preview(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Query('scheduledAt') scheduledAt: string,
  ) {
    return this.weatherForecast.previewForScheduling(userId, projectId, new Date(scheduledAt));
  }
}
