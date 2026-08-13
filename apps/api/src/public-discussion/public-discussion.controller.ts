import { Body, Controller, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { PublicDiscussionService } from './public-discussion.service';

class ModerateDto {
  decision!: 'ACCEPT' | 'REJECT';
}

// Owner-side — тот же TelegramAuthGuard, что у всего остального
// проекта. Публичная (без аутентификации) сторона — отдельный
// контроллер, см. public-discussion.public-controller.ts.
@Controller('projects/:projectId/public-discussion')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class PublicDiscussionController {
  constructor(private readonly publicDiscussion: PublicDiscussionService) {}

  @Post('enable')
  async enable(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.publicDiscussion.enableSharing(userId, projectId);
  }

  @Post('disable')
  async disable(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.publicDiscussion.disableSharing(userId, projectId);
  }

  @Get('submissions')
  async listSubmissions(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.publicDiscussion.listSubmissionsForModeration(userId, projectId);
  }

  @Patch('submissions/:submissionId/moderate')
  async moderate(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Param('submissionId') submissionId: string,
    @Body() dto: ModerateDto,
  ) {
    return this.publicDiscussion.moderate(userId, projectId, submissionId, dto.decision);
  }
}
