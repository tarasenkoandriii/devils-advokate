import { Module } from '@nestjs/common';
import { ArchetypePerspectiveController } from './archetype-perspective.controller';
import { ArchetypePerspectiveService } from './archetype-perspective.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [ArchetypePerspectiveController],
  providers: [ArchetypePerspectiveService],
  exports: [ArchetypePerspectiveService],
})
export class ArchetypePerspectiveModule {}
