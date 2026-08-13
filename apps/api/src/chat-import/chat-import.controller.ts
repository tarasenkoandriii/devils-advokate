import { Body, Controller, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { ChatImportService, ImportChatMessage } from './chat-import.service';

class ImportChatDto {
  messages!: ImportChatMessage[];
  selfSenderName!: string;
  rawFileRef?: string;
}

@Controller('projects/:projectId/chat-import')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class ChatImportController {
  constructor(private readonly chatImport: ChatImportService) {}

  @Post()
  async import(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: ImportChatDto,
  ) {
    return this.chatImport.importChat(userId, projectId, dto);
  }
}
