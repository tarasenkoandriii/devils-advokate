import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { ClosingMessageService } from './closing-message.service';

class GenerateClosingMessageDto {
  engineId?: string;
}

@Controller('projects/:projectId/closing-messages')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class ClosingMessageController {
  constructor(private readonly closingMessage: ClosingMessageService) {}

  @Post()
  async generate(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: GenerateClosingMessageDto,
  ) {
    return this.closingMessage.generate(userId, projectId, dto?.engineId);
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.closingMessage.list(userId, projectId);
  }
}
