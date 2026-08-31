import { Module } from '@nestjs/common';
import { MediaReviewController } from './media-review.controller';
import { MediaReviewService } from './media-review.service';
import { YouTubeSearchService } from './youtube-search.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { SecretsModule } from '../secrets/secrets.module';

@Module({
  imports: [TelegramAuthModule, SecretsModule],
  controllers: [MediaReviewController],
  providers: [MediaReviewService, YouTubeSearchService],
  exports: [MediaReviewService, YouTubeSearchService],
})
export class MediaReviewModule {}
