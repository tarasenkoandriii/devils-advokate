import { Global, Module } from '@nestjs/common';
import { AIRouterService } from './ai-router.service';
import { MediaUriResolverService } from './media-uri-resolver.service';
import { AIJobsController, AIJobsDispatchController } from './ai-jobs.controller';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { SttModule } from '../stt/stt.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { ConsentModule } from '../consent/consent.module';
import { ContentScanModule } from '../content-scan/content-scan.module';

@Global()
@Module({
  imports: [ConsentModule, ContentScanModule, TelegramAuthModule, ConversationsModule, SttModule],
  controllers: [AIJobsController, AIJobsDispatchController],
  providers: [AIRouterService, MediaUriResolverService],
  exports: [AIRouterService, MediaUriResolverService],
})
export class AIRouterModule {}
