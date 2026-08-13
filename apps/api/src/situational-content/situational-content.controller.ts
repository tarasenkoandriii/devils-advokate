import { Body, Controller, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { SituationalContentService } from './situational-content.service';

class GenerateDto {
  engineId?: string;
}

class UpdatePreferencesDto {
  alwaysShowQuote?: boolean;
  alwaysShowAnecdote?: boolean;
}

@Controller()
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class SituationalContentController {
  constructor(private readonly situationalContent: SituationalContentService) {}

  @Post('projects/:projectId/situational-quotes')
  async generateQuote(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: GenerateDto,
  ) {
    return this.situationalContent.generateQuote(userId, projectId, dto?.engineId);
  }

  @Get('projects/:projectId/situational-quotes')
  async listQuotes(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.situationalContent.listQuotes(userId, projectId);
  }

  @Post('projects/:projectId/situational-anecdotes')
  async generateAnecdote(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: GenerateDto,
  ) {
    return this.situationalContent.generateAnecdote(userId, projectId, dto?.engineId);
  }

  @Get('projects/:projectId/situational-anecdotes')
  async listAnecdotes(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.situationalContent.listAnecdotes(userId, projectId);
  }

  @Patch('users/me/situational-content-preferences')
  async updatePreferences(@CurrentUser() userId: string, @Body() dto: UpdatePreferencesDto) {
    return this.situationalContent.updatePreferences(userId, dto);
  }
}
