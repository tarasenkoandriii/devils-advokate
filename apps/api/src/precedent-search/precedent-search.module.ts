import { Module } from '@nestjs/common';
import { PrecedentSearchController } from './precedent-search.controller';
import { PrecedentSearchService } from './precedent-search.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [PrecedentSearchController],
  providers: [PrecedentSearchService],
  exports: [PrecedentSearchService],
})
export class PrecedentSearchModule {}
