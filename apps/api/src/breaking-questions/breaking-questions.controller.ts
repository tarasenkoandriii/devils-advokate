import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { BreakingQuestionsService } from './breaking-questions.service';

class GenerateDto {
  transcriptWindow!: string;
  targetPersonId?: string;
  engineId?: string;
}

@Controller('projects/:projectId/breaking-questions')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class BreakingQuestionsController {
  constructor(private readonly breakingQuestions: BreakingQuestionsService) {}

  @Post()
  async generate(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: GenerateDto,
  ) {
    return this.breakingQuestions.generate(userId, projectId, dto.transcriptWindow, dto?.targetPersonId, dto?.engineId);
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.breakingQuestions.list(userId, projectId);
  }
}
