import { Module } from '@nestjs/common';
import { PublicDiscussionController } from './public-discussion.controller';
import { PublicDiscussionPublicController } from './public-discussion.public-controller';
import { PublicDiscussionService } from './public-discussion.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { ConsentModule } from '../consent/consent.module';

@Module({
  imports: [TelegramAuthModule, ConsentModule],
  controllers: [PublicDiscussionController, PublicDiscussionPublicController],
  providers: [PublicDiscussionService],
  exports: [PublicDiscussionService],
})
export class PublicDiscussionModule {}
