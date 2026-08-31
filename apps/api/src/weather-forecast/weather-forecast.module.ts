import { Module } from '@nestjs/common';
import { WeatherForecastController, WeatherForecastPreviewController } from './weather-forecast.controller';
import { WeatherForecastService } from './weather-forecast.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';
import { ConsentModule } from '../consent/consent.module';
import { SecretsModule } from '../secrets/secrets.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule, ConsentModule, SecretsModule],
  controllers: [WeatherForecastController, WeatherForecastPreviewController],
  providers: [WeatherForecastService],
  exports: [WeatherForecastService],
})
export class WeatherForecastModule {}
