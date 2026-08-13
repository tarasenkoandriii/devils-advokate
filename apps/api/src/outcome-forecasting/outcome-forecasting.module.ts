import { Module } from '@nestjs/common';
import { OutcomeForecastingController } from './outcome-forecasting.controller';
import { OutcomeForecastingService } from './outcome-forecasting.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [OutcomeForecastingController],
  providers: [OutcomeForecastingService],
  exports: [OutcomeForecastingService],
})
export class OutcomeForecastingModule {}
