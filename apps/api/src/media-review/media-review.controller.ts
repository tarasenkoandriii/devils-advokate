// Пункт [media-review]: контролер поверх YouTubeSearchService/
// MediaReviewService, devils-advocate-media-review-tz.md §5.

import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { YouTubeSearchService } from './youtube-search.service';
import { MediaReviewService, CreateQueueItemInput } from './media-review.service';

class CreateQueueDto {
  title!: string;
}

class LinkConversationDto {
  conversationId!: string;
}

@Controller('media-review')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class MediaReviewController {
  constructor(
    private readonly youtubeSearch: YouTubeSearchService,
    private readonly mediaReview: MediaReviewService,
  ) {}

  @Get('youtube-search')
  async search(@CurrentUser() userId: string, @Query('query') query: string) {
    return this.youtubeSearch.search(userId, query);
  }

  @Get('queues')
  async listQueues(@CurrentUser() userId: string) {
    return this.mediaReview.listQueues(userId);
  }

  @Post('queues')
  async createQueue(@CurrentUser() userId: string, @Body() dto: CreateQueueDto) {
    return this.mediaReview.createQueue(userId, dto.title);
  }

  @Post('queues/:id/items')
  async addItem(@CurrentUser() userId: string, @Param('id') queueId: string, @Body() dto: CreateQueueItemInput) {
    return this.mediaReview.addItem(userId, queueId, dto);
  }

  @Get('queues/:id')
  async getQueue(@CurrentUser() userId: string, @Param('id') queueId: string) {
    return this.mediaReview.getQueue(userId, queueId);
  }

  @Get('queues/:id/summary')
  async getSummary(@CurrentUser() userId: string, @Param('id') queueId: string) {
    return this.mediaReview.getSummary(userId, queueId);
  }

  @Patch('queue-items/:id/link-conversation')
  async linkConversation(
    @CurrentUser() userId: string,
    @Param('id') itemId: string,
    @Body() dto: LinkConversationDto,
  ) {
    return this.mediaReview.linkConversation(userId, itemId, dto.conversationId);
  }
}
