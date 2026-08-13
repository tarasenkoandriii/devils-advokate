import { Module } from '@nestjs/common';
import { StakeholderMapController } from './stakeholder-map.controller';
import { StakeholderMapService } from './stakeholder-map.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [StakeholderMapController],
  providers: [StakeholderMapService],
  exports: [StakeholderMapService],
})
export class StakeholderMapModule {}
