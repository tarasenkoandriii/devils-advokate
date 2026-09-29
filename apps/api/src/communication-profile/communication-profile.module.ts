import { Module } from '@nestjs/common';
import { ConsentModule } from '../consent/consent.module';
import { CommunicationProfileController } from './communication-profile.controller';
import { CommunicationProfileService } from './communication-profile.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [ConsentModule, TelegramAuthModule, AIRouterModule],
  controllers: [CommunicationProfileController],
  providers: [CommunicationProfileService],
  exports: [CommunicationProfileService],
})
export class CommunicationProfileModule {}
