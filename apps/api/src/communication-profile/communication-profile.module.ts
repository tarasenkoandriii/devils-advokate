import { Module } from '@nestjs/common';
import { CommunicationProfileController } from './communication-profile.controller';
import { CommunicationProfileService } from './communication-profile.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [CommunicationProfileController],
  providers: [CommunicationProfileService],
  exports: [CommunicationProfileService],
})
export class CommunicationProfileModule {}
