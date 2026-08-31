// Пункт [admin-sandbox] 2026-08-31 — контроллер песочницы. Тонкий слой
// над AdminSandboxService: авторизация — AdminSessionGuard (та же
// httpOnly-cookie, что у остальной админки), проверка isOperator — в
// сервисе, как у admin-users (граница по роли живёт рядом с логикой,
// а не в декораторах, которые легко забыть на новом методе).

import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { AdminSessionGuard } from '../admin-auth/admin-session.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { AdminSandboxService, SandboxAnalysisKind } from './admin-sandbox.service';

class YouTubeSearchDto {
  query!: string;
}

class AnalyzeDto {
  conversationId!: string;
  kind!: SandboxAnalysisKind;
}

@Controller('admin/sandbox')
@UseGuards(AdminSessionGuard)
@UseInterceptors(ApiResponseInterceptor)
export class AdminSandboxController {
  constructor(private readonly sandbox: AdminSandboxService) {}

  @Get('status')
  async status(@CurrentUser() userId: string) {
    return this.sandbox.getStatus(userId);
  }

  @Post('consents')
  async grantConsents(@CurrentUser() userId: string) {
    return this.sandbox.grantOwnConsents(userId);
  }

  @Post('youtube-search')
  async youtubeSearch(@CurrentUser() userId: string, @Body() dto: YouTubeSearchDto) {
    return this.sandbox.youtubeSearch(userId, dto.query);
  }

  @Post('transcription')
  async runTranscription(@CurrentUser() userId: string) {
    return this.sandbox.runTranscriptionSmoke(userId);
  }

  @Get('conversation/:id')
  async conversation(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.sandbox.getConversation(userId, id);
  }

  @Post('analyze')
  async analyze(@CurrentUser() userId: string, @Body() dto: AnalyzeDto) {
    return this.sandbox.analyze(userId, dto.conversationId, dto.kind);
  }
}
