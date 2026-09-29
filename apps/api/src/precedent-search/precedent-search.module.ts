import { Module } from '@nestjs/common';
import { ConsentModule } from '../consent/consent.module';
import { PrecedentSearchController } from './precedent-search.controller';
import { PrecedentSearchService } from './precedent-search.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [ConsentModule, TelegramAuthModule, AIRouterModule],
  controllers: [PrecedentSearchController],
  providers: [PrecedentSearchService],
  exports: [PrecedentSearchService],
})
export class PrecedentSearchModule {}
