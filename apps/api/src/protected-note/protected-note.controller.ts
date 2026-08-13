import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { ProtectedNoteService, CreateProtectedNoteInput, UpdateProtectedNoteInput } from './protected-note.service';

@Controller()
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class ProtectedNoteController {
  constructor(private readonly protectedNote: ProtectedNoteService) {}

  @Post('projects/:projectId/protected-notes')
  async create(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CreateProtectedNoteInput,
  ) {
    return this.protectedNote.create(userId, projectId, dto);
  }

  @Get('projects/:projectId/protected-notes')
  async list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.protectedNote.list(userId, projectId);
  }

  @Patch('protected-notes/:id')
  async update(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateProtectedNoteInput,
  ) {
    return this.protectedNote.update(userId, id, dto);
  }

  @Delete('protected-notes/:id')
  async delete(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.protectedNote.delete(userId, id);
  }
}
