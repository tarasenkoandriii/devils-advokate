import { Module } from '@nestjs/common';
import { MissingInformationController } from './missing-information.controller';
import { MissingInformationService } from './missing-information.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [MissingInformationController],
  providers: [MissingInformationService],
  exports: [MissingInformationService],
})
export class MissingInformationModule {}
