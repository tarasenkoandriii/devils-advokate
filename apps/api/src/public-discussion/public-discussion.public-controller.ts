import { Body, Controller, Get, Param, Post, UseInterceptors } from '@nestjs/common';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { PublicDiscussionService } from './public-discussion.service';

class JoinDto {
  displayName?: string;
}

class SubmitArgumentDto {
  text!: string;
  stance!: 'PRO' | 'CON';
  participantId?: string;
}

class VoteDto {
  direction!: 'up' | 'down';
}

class AddCommentDto {
  text!: string;
  participantId?: string;
}

// НАМЕРЕННО БЕЗ @UseGuards(TelegramAuthGuard) — единственный
// контроллер за весь проект без Telegram-аутентификации. Знание
// publicShareToken в URL и есть "доступ" — см. подробное обоснование
// в public-discussion.service.ts, шапка файла.
@Controller('public/:token')
@UseInterceptors(ApiResponseInterceptor)
export class PublicDiscussionPublicController {
  constructor(private readonly publicDiscussion: PublicDiscussionService) {}

  @Get()
  async view(@Param('token') token: string) {
    return this.publicDiscussion.publicView(token);
  }

  @Post('participants')
  async join(@Param('token') token: string, @Body() dto: JoinDto) {
    return this.publicDiscussion.joinAsParticipant(token, dto?.displayName);
  }

  @Post('submissions')
  async submit(@Param('token') token: string, @Body() dto: SubmitArgumentDto) {
    return this.publicDiscussion.submitArgument(token, dto.text, dto.stance, dto.participantId);
  }

  @Post('submissions/:submissionId/vote')
  async vote(
    @Param('token') token: string,
    @Param('submissionId') submissionId: string,
    @Body() dto: VoteDto,
  ) {
    return this.publicDiscussion.vote(token, submissionId, dto.direction);
  }

  @Post('comments')
  async comment(@Param('token') token: string, @Body() dto: AddCommentDto) {
    return this.publicDiscussion.addComment(token, dto.text, dto.participantId);
  }
}
