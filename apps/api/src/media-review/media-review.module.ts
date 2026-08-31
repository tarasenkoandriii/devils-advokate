import { Module } from '@nestjs/common';
import { MediaReviewController } from './media-review.controller';
import { MediaReviewService } from './media-review.service';
import { YouTubeSearchService } from './youtube-search.service';
import { MediaReviewAutoService } from './media-review-auto.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { SecretsModule } from '../secrets/secrets.module';

@Module({
  imports: [TelegramAuthModule, SecretsModule],
  controllers: [MediaReviewController],
  providers: [MediaReviewService, YouTubeSearchService, MediaReviewAutoService],
  exports: [MediaReviewService, YouTubeSearchService, MediaReviewAutoService],
})
export class MediaReviewModule {}
