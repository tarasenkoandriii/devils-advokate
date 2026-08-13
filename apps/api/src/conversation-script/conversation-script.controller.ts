import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { ConversationScriptService } from './conversation-script.service';
import { ConversationScriptType } from '@prisma/client';

class GenerateScriptDto {
  type!: ConversationScriptType;
  personId?: string;
  engineId?: string;
}

@Controller('projects/:projectId/scripts')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class ConversationScriptController {
  constructor(private readonly scripts: ConversationScriptService) {}

  @Post()
  async generate(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: GenerateScriptDto,
  ) {
    return this.scripts.generate(projectId, userId, dto.type, dto.personId, dto.engineId);
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.scripts.list(userId, projectId);
  }
}
