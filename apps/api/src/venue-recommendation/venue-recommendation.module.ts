import { Module } from '@nestjs/common';
import { VenueRecommendationController } from './venue-recommendation.controller';
import { VenueRecommendationService } from './venue-recommendation.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';
import { SecretsModule } from '../secrets/secrets.module';
import { ConsentModule } from '../consent/consent.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule, SecretsModule, ConsentModule],
  controllers: [VenueRecommendationController],
  providers: [VenueRecommendationService],
  exports: [VenueRecommendationService],
})
export class VenueRecommendationModule {}
